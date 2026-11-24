import { compareItems, StoreError } from './normalize.js';
import { withTimeout } from './stores.js';

export const SEARCH_TOOL = {
  name: 'search_all_stores',
  title: 'Search all stores',
  description:
    'Search Shufersal and Rami Levy at once. The catalogs are in Hebrew: use Hebrew requests as written, and translate Russian or English ones ' +
    'into a Hebrew query first (молоко / milk → חלב). Retry with a simpler Hebrew term if nothing is found. Returns one list sorted by price per liter or kilogram, ' +
    'then price, with per-store status. A store that fails is reported in `stores` and the other store still answers. ' +
    'Items with the same barcode in different stores are the same product and are grouped in `sameProduct` with the cheapest store; ' +
    'compare other items by name, size and pricePerUnit and say which you treat as equivalent. ' +
    '`promotions` lists multi-buy and club offers (unitPrice is the price per item under the offer); mention them when they change which store is cheaper.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: 'Hebrew search terms, e.g. "חלב 3%". Translate Russian or English requests; use Hebrew as written.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 10, description: 'Maximum results per store' },
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

export async function searchAllStores(stores, args = {}, { timeoutMs = 45_000 } = {}) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new StoreError('query is required');
  const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 20) : 10;
  const wanted = Array.isArray(args.stores) && args.stores.length ? new Set(args.stores) : null;
  const selected = wanted ? stores.filter((s) => wanted.has(s.id)) : stores;
  if (!selected.length) throw new StoreError(`No configured store matches ${JSON.stringify(args.stores)}`);

  const outcomes = await Promise.allSettled(
    selected.map(async (store) => {
      const { tool, maxLimit, normalize, run } = store.search;
      const timeoutMessage = `${store.label} did not answer within ${timeoutMs / 1000}s`;
      if (run) return withTimeout(run({ query, limit: Math.min(limit, maxLimit) }), timeoutMs, timeoutMessage);
      const result = await withTimeout(
        store.callTool(tool, { query, limit: Math.min(limit, maxLimit) }, timeoutMs),
        timeoutMs + 1_000,
        timeoutMessage,
      );
      const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (result.isError) throw new StoreError(text.slice(0, 500) || `${store.label} reported an error`);
      return normalize(text).slice(0, limit);
    }),
  );

  const status = {};
  const results = [];
  outcomes.forEach((outcome, i) => {
    const store = selected[i];
    if (outcome.status === 'fulfilled') {
      status[store.id] = { ok: true, count: outcome.value.length };
      results.push(...outcome.value);
    } else {
      const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      status[store.id] = { ok: false, error: reason };
    }
  });
  results.sort(compareItems);
  return { query, stores: status, sameProduct: groupByBarcode(results), results };
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
