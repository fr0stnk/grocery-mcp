import { createLimiter, SearchCache } from './cache.js';
import { compareItems, StoreError } from './normalize.js';
import { withTimeout } from './stores.js';

/** Shared by every request in this process; see cache.js for the freshness rules. */
export const searchCache = new SearchCache();
const FETCH_SIZE = 20;
const PER_STORE_CONCURRENCY = 4;

export const SEARCH_TOOL = {
  name: 'search_all_stores',
  title: 'Search all stores',
  description:
    'Search Shufersal and Rami Levy at once. The catalogs are in Hebrew: use Hebrew requests as written, and translate Russian or English ones ' +
    'into a Hebrew query first (молоко / milk → חלב). Retry with a simpler Hebrew term if nothing is found. Returns one list in each store\'s own ' +
    'relevance order, interleaved by rank (sortBy unitPrice or price for cheapest first), with per-store status. ' +
    'priceBasis says what price buys: unit, kg, or an estimated package; regularPrice, when present, is the price before a promotion already included in price. ' +
    'Results sharing no word with the query are left out and counted in `stores.<id>.unrelatedHidden`. A store that fails is reported in `stores` and the other store still answers. ' +
    'Items with the same barcode in different stores are the same product and are grouped in `sameProduct` with the cheapest store; ' +
    'compare other items by name, size and pricePerUnit and say which you treat as equivalent. ' +
    '`promotions` lists multi-buy and club offers (unitPrice is the price per item under the offer); mention them when they change which store is cheaper. ' +
    'Results may be cached for up to 15 minutes; `stores.<id>.stale` means the store did not answer and older prices from `fetchedAt` are shown, so say so.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: 'Hebrew search terms, e.g. "חלב 3%". Translate Russian or English requests; use Hebrew as written.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'Maximum results per store' },
      sortBy: { type: 'string', enum: ['relevance', 'unitPrice', 'price'], default: 'relevance', description: 'relevance keeps each store\'s ranking; unitPrice sorts by price per liter or kilogram' },
      stores: {
        type: 'array',
        items: { type: 'string', enum: ['shufersal', 'rami-levy'] },
        description: 'Only search these stores (default: all configured stores)',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

/**
 * One store's results for a query, in the store's own relevance order. Results
 * are cached per store, branch and query, and each store runs at most a few
 * searches at once.
 */
export async function searchStore(store, query, { timeoutMs = 45_000, cache = searchCache } = {}) {
  store.limiter ??= createLimiter(PER_STORE_CONCURRENCY);
  const key = `${store.id}|${store.cacheKey ?? ''}|${query}`;
  return cache.get(key, () => store.limiter(() => fetchStore(store, query, timeoutMs)));
}

async function fetchStore(store, query, timeoutMs) {
  const { maxLimit, run } = store.search;
  const limit = Math.min(FETCH_SIZE, maxLimit);
  const timeoutMessage = `${store.label} did not answer within ${timeoutMs / 1000}s`;
  const viaAdapter = () => adapterSearch(store, query, limit, timeoutMs, timeoutMessage);
  if (run) return withTimeout(run({ query, limit, fallback: viaAdapter }), timeoutMs, timeoutMessage);
  return viaAdapter();
}

/** Searches through the adapter's own search tool. */
async function adapterSearch(store, query, limit, timeoutMs, timeoutMessage) {
  const { tool, normalize } = store.search;
  const result = await withTimeout(store.callTool(tool, { query, limit }, timeoutMs), timeoutMs + 1_000, timeoutMessage);
  const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (result.isError) throw new StoreError(text.slice(0, 500) || `${store.label} reported an error`);
  return normalize(text).slice(0, limit);
}

/** The per-store status reported to clients, including cache age when relevant. */
export function storeStatus(hit, count) {
  return {
    ok: true,
    count,
    fetchedAt: hit.fetchedAt,
    ...(hit.cached ? { cached: true } : {}),
    ...(hit.stale ? { stale: true, error: hit.error } : {}),
  };
}

export function selectStores(stores, wantedIds) {
  const wanted = Array.isArray(wantedIds) && wantedIds.length ? new Set(wantedIds) : null;
  const selected = wanted ? stores.filter((s) => wanted.has(s.id)) : stores;
  if (!selected.length) throw new StoreError(`No configured store matches ${JSON.stringify(wantedIds)}`, 'INVALID_ARGUMENT');
  return selected;
}

export async function searchAllStores(stores, args = {}, { timeoutMs = 45_000, cache = searchCache } = {}) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new StoreError('query is required', 'INVALID_ARGUMENT');
  const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 20) : 10;
  const selected = selectStores(stores, args.stores);

  const sortBy = ['relevance', 'unitPrice', 'price'].includes(args.sortBy) ? args.sortBy : 'relevance';
  const outcomes = await Promise.allSettled(selected.map((store) => searchStore(store, query, { timeoutMs, cache })));

  const status = {};
  const results = [];
  outcomes.forEach((outcome, i) => {
    const store = selected[i];
    if (outcome.status === 'fulfilled') {
      const { kept, hidden } = relevantOnly(outcome.value.value, query);
      const items = kept.slice(0, limit).map((item, index) => ({ ...item, rank: index + 1 }));
      status[store.id] = { ...storeStatus(outcome.value, items.length), ...(hidden ? { unrelatedHidden: hidden } : {}) };
      results.push(...items);
    } else {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      status[store.id] = { ok: false, error: reason };
    }
  });
  // Array.prototype.sort is stable, so equal ranks keep the stores' order.
  if (sortBy === 'unitPrice') results.sort(compareItems);
  else if (sortBy === 'price') results.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  else results.sort((a, b) => a.rank - b.rank);
  // The catalogs are Hebrew; a Latin or Cyrillic query usually finds nothing useful.
  const hint = /[\u0590-\u05FF]/.test(query) || /^\d+$/.test(query)
    ? undefined
    : 'The store catalogs are in Hebrew and this query has no Hebrew letters; translate it to Hebrew (for example молоко or milk → חלב) and search again.';
  return { query, sortBy, ...(hint ? { hint } : {}), stores: status, sameProduct: groupByBarcode(results), results };
}

const HEBREW_PREFIX = /^[והבלמשכ](?=[\u0590-\u05FF]{3})/u;
const wordsOf = (text) => String(text).toLocaleLowerCase().replace(/["'״׳()\-,.]/g, ' ').split(/\s+/).filter((w) => w.length >= 2 || /\d/.test(w));

/**
 * The stores' fuzzy search fills short result lists with unrelated products
 * (beef tongue for "frozen salmon fillet"). Results sharing no word with the
 * query are dropped, unless nothing matches at all: then the store may know a
 * synonym, and everything is kept. Barcode and number queries are not filtered.
 * The catalogs are Hebrew, so a query with no Hebrew letters (a brand such as
 * "milka", or an untranslated "lactose free milk") must match every word, and
 * nothing is kept when no product does: one shared English word is not a match.
 */
export function relevantOnly(items, query) {
  if (/^\d+$/.test(query.trim())) return { kept: items, hidden: 0 };
  // Numbers and sizes ("12", "3%", "500") say nothing about what the product is.
  const words = wordsOf(query).filter((w) => !/\d/.test(w)).map((w) => [w, w.replace(HEBREW_PREFIX, '')]);
  if (!words.length) return { kept: items, hidden: 0 };
  const foreign = !/[\u0590-\u05FF]/.test(query);
  const related = (item) => {
    const text = `${item.name} ${item.brand ?? ''}`.toLocaleLowerCase();
    const has = ([w, bare]) => text.includes(w) || text.includes(bare);
    return foreign ? words.every(has) : words.some(has);
  };
  const kept = items.filter(related);
  return kept.length || foreign ? { kept, hidden: items.length - kept.length } : { kept: items, hidden: 0 };
}

/** Products sold by more than one store, matched by barcode, cheapest first within each group. */
export function groupByBarcode(results) {
  const groups = new Map();
  for (const r of results) {
    if (!r.barcode || r.price == null) continue;
    if (!groups.has(r.barcode)) groups.set(r.barcode, []);
    groups.get(r.barcode).push(r);
  }
  return [...groups.values()]
    .filter((offers) => new Set(offers.map((o) => o.store)).size > 1)
    .map((offers) => {
      offers.sort((a, b) => a.price - b.price);
      const [cheapest, ...rest] = offers;
      return {
        barcode: cheapest.barcode,
        confidence: offers.some((o) => o.barcodeInferred) ? 'inferred' : 'exact',
        name: offers.find((o) => o.store === 'shufersal')?.name ?? cheapest.name,
        offers: offers.map((o) => ({
          store: o.store,
          productId: o.productId,
          price: o.price,
          ...(o.promotions ? { promotions: o.promotions } : {}),
        })),
        cheapestStore: rest.some((o) => o.price === cheapest.price) ? null : cheapest.store,
        priceDifference: Math.round((offers.at(-1).price - cheapest.price) * 100) / 100,
      };
    })
    .sort((a, b) => b.priceDifference - a.priceDifference);
}
