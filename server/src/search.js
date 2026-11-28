import { createLimiter, SearchCache } from './cache.js';
import { compareItems, StoreError } from './normalize.js';
import { withTimeout } from './stores.js';
import { isAbout, matchedTerms, queryTerms, stemOf, withoutPackaging } from './match.js';

/** Shared by every request in this process; see cache.js for the freshness rules. */
export const searchCache = new SearchCache();
const FETCH_SIZE = 20;
const PERCENT = /(\d+(?:[.,]\d+)?)\s*%/u;
const PER_STORE_CONCURRENCY = 4;

export const SEARCH_TOOL = {
  name: 'search_all_stores',
  title: 'Search all stores',
  description:
    'Search Shufersal and Rami Levy at once. The catalogs are in Hebrew: use Hebrew requests as written, and translate Russian or English ones ' +
    'into a Hebrew query first (молоко / milk → חלב). Retry with a simpler Hebrew term if nothing is found. Returns one list in each store\'s own ' +
    'relevance order, interleaved by rank (sortBy unitPrice or price for cheapest first), with per-store status. ' +
    'priceBasis says what price buys: unit, kg, or an estimated package; regularPrice, when present, is the price before a promotion already included in price. ' +
    'Results sharing no word with the query are left out and counted in `stores.<id>.unrelatedHidden`; a store with nothing related returns none, and a Hebrew plural with no match is retried in the singular (`retriedAs`). A store that fails is reported in `stores` and the other store still answers. ' +
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
      sortBy: { type: 'string', enum: ['relevance', 'unitPrice', 'price'], default: 'relevance', description: 'relevance keeps each store\'s ranking; unitPrice sorts by price per kg, litre or piece, each unit in its own group' },
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
let recorder = null;

/** Every fresh (not cached) search result is passed to `record`, e.g. the price history. */
export function recordSearchesWith(record) {
  recorder = record;
}

export async function searchStore(store, query, { timeoutMs = 45_000, cache = searchCache } = {}) {
  store.limiter ??= createLimiter(PER_STORE_CONCURRENCY);
  const key = `${store.id}|${store.cacheKey ?? ''}|${query}`;
  return cache.get(key, async () => {
    const items = await store.limiter(() => fetchStore(store, query, timeoutMs));
    if (recorder) Promise.resolve().then(() => recorder(items)).catch((error) => process.stderr.write(`[grocery] price history not recorded: ${error.message}\n`));
    return items;
  });
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
  const outcomes = await Promise.allSettled(selected.map((store) => relevantSearch(store, query, { timeoutMs, cache })));

  const status = {};
  const results = [];
  outcomes.forEach((outcome, i) => {
    const store = selected[i];
    if (outcome.status === 'fulfilled') {
      const { hit, items: kept, hidden, retriedAs, relevance } = outcome.value;
      const items = kept.slice(0, limit).map((item, index) => ({ ...item, rank: index + 1 }));
      status[store.id] = { ...storeStatus(hit, items.length), ...(hidden ? { unrelatedHidden: hidden } : {}), ...(retriedAs ? { retriedAs } : {}), ...(relevance ? { relevance } : {}) };
      results.push(...items);
    } else {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      status[store.id] = { ok: false, error: reason };
    }
  });
  // Array.prototype.sort is stable, so equal ranks keep the stores' order.
  // Sorted by price, products stating another percentage than the query's go last: 1% milk must not top "חלב 3%".
  const wanted = PERCENT.exec(query)?.[1];
  const offPercent = (r) => {
    const stated = wanted ? [...String(r.name ?? '').matchAll(new RegExp(PERCENT, 'gu'))].map((m) => m[1]) : [];
    return stated.length && !stated.some((v) => Number(v.replace(',', '.')) === Number(wanted.replace(',', '.'))) ? 1 : 0;
  };
  if (sortBy === 'unitPrice') {
    // Prices per kg, litre and piece are not comparable: each unit is sorted as its own group,
    // groups in the order they first appear by relevance, items without a unit price last.
    const groups = [...new Set(results.filter((r) => r.perUnit).sort((a, b) => a.rank - b.rank).map((r) => r.perUnit))];
    const group = (r) => (r.perUnit ? groups.indexOf(r.perUnit) : groups.length);
    results.sort((a, b) => offPercent(a) - offPercent(b) || group(a) - group(b) || compareItems(a, b));
  }
  else if (sortBy === 'price') results.sort((a, b) => offPercent(a) - offPercent(b) || (a.price ?? Infinity) - (b.price ?? Infinity));
  else results.sort((a, b) => a.rank - b.rank);
  // The catalogs are Hebrew; a Latin or Cyrillic query usually finds nothing useful.
  const hint = /[\u0590-\u05FF]/.test(query) || /^\d+$/.test(query)
    ? undefined
    : 'The store catalogs are in Hebrew and this query has no Hebrew letters; translate it to Hebrew (for example молоко or milk → חלב) and search again.';
  return { query, sortBy, ...(hint ? { hint } : {}), stores: status, sameProduct: groupByBarcode(results), results };
}

/**
 * The stores' fuzzy search fills short result lists with unrelated products
 * (beef tongue for "frozen salmon fillet"). Results sharing no word with the
 * query are dropped, even when that leaves nothing: Rami Levy's search reads
 * "בננות" (bananas) as "בנות" (girls) and answers with girls' socks. A Hebrew
 * plural also matches by its stem (בננות, בננ-), so "בננה" counts. Words are
 * matched from their start, and sizes and units do not count: "ליטר" alone
 * made kettles a match for "מים 1.5 ליטר". Barcode and number queries are not
 * filtered.
 * The catalogs are Hebrew, so a query with no Hebrew letters (a brand such as
 * "milka", or an untranslated "lactose free milk") must match every word, and
 * nothing is kept when no product does: one shared English word is not a match.
 */
export function relevantOnly(items, query) {
  if (/^\d+$/.test(query.trim())) return { kept: items, hidden: 0 };
  const terms = queryTerms(query);
  if (!terms.length) return { kept: items, hidden: 0 };
  const foreign = !/[\u0590-\u05FF]/.test(query);
  const related = (item) => {
    if (!foreign) return matchedTerms(item, terms) > 0;
    const text = `${item.name} ${item.brand ?? ''}`.toLocaleLowerCase();
    return terms.every((t) => t.forms.some((f) => text.includes(f)));
  };
  const loose = items.filter(related);
  // Of those, prefer the products that are about the query; one shared adjective is kept only when nothing else is.
  const about = foreign ? loose : loose.filter((item) => isAbout(item, terms));
  const kept = about.length ? about : loose;
  return { kept, hidden: items.length - kept.length, ...(!foreign && !about.length && loose.length ? { relevance: 'any-word' } : {}) };
}

/** Singular forms to retry a plural query with: בננות → בננה, עגבניות → עגבניה, תפוחים → תפוח. */
export function singularQueries(query) {
  const out = [];
  for (const w of String(query).split(/\s+/)) {
    const stem = stemOf(w);
    if (!stem) continue;
    const forms = w.endsWith('ות') ? [`${stem}ה`, stem] : [stem, `${stem}ה`];
    for (const f of forms) out.push(query.replace(w, f));
  }
  return [...new Set(out)].slice(0, 2);
}

/**
 * A store's results for a query with unrelated products removed. When nothing
 * fits, the query is retried without packaging words and a Hebrew plural in the
 * singular (`retriedAs`).
 */
export async function relevantSearch(store, query, opts = {}) {
  const bare = withoutPackaging(query);
  // Rami Levy's ranking rewards a literal "מארז" or "ארוז" (apple juice packs, packed chicken), and its names
  // rarely carry those words, so it is searched without them. Shufersal's names do carry them.
  const sent = store.id === 'rami-levy' && bare ? bare : query;
  const hit = await searchStore(store, sent, opts);
  const { kept, hidden, relevance } = relevantOnly(hit.value, query);
  if (kept.length) return { hit, items: kept, hidden, ...(relevance ? { relevance } : {}), ...(sent !== query ? { retriedAs: sent } : {}) };
  for (const alt of [...new Set([bare, ...singularQueries(bare ?? query)].filter((q) => q && q !== sent))]) {
    const retry = await searchStore(store, alt, opts).catch(() => null);
    const again = retry ? relevantOnly(retry.value, query) : { kept: [] };
    if (again.kept.length) return { hit: retry, items: again.kept, hidden, retriedAs: alt, ...(again.relevance ? { relevance: again.relevance } : {}) };
  }
  return { hit, items: [], hidden };
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
