import { compareItems, StoreError } from './normalize.js';
import { withTimeout } from './stores.js';

export const SEARCH_TOOL = {
  name: 'search_all_stores',
  title: 'Search all stores',
  description:
    'Search Shufersal and Rami Levy at once. The catalogs are in Hebrew: translate the user\'s request into a Hebrew query first ' +
    '(молоко / milk → חלב), and retry with a simpler Hebrew term if nothing is found. Returns one list sorted by price per liter or kilogram, ' +
    'then price, with per-store status. A store that fails is reported in `stores` and the other store still answers. ' +
    'Products are not matched across stores: compare by name, size and pricePerUnit, and tell the user which items you treat as equivalent.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, description: 'Hebrew search terms, e.g. "חלב 3%". Translate Russian or English requests first.' },
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
      const { tool, maxLimit, normalize } = store.search;
      const result = await withTimeout(
        store.callTool(tool, { query, limit: Math.min(limit, maxLimit) }, timeoutMs),
        timeoutMs + 1_000,
        `${store.label} did not answer within ${timeoutMs / 1000}s`,
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
  return { query, stores: status, results };
}
