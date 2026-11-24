import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRamiCatalog, normalizeRamiLevy, normalizeShufersal } from './normalize.js';
import { fetchRamiCatalog } from './rami-catalog.js';
import { StoreClient } from './stores.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The container image keeps the same layout as the repository, so these
// defaults work in both places.
export const STORE_DEFS = {
  shufersal: {
    label: 'Shufersal',
    toolPrefix: 'shufersal_',
    entryEnv: 'GROCERY_SHUFERSAL_ENTRY',
    entry: 'upstream/shufersal-cart/bin/shufersal-mcp.mjs',
    search: { tool: 'search_products', maxLimit: 20, normalize: normalizeShufersal },
  },
  'rami-levy': {
    label: 'Rami Levy',
    toolPrefix: 'rami_levy_',
    entryEnv: 'GROCERY_RAMI_LEVY_ENTRY',
    entry: 'upstream/rami-levy-mcp/dist/index.js',
    // Searches the public catalog directly (barcodes, promotions, no login);
    // GROCERY_RAMI_LEVY_SEARCH=adapter uses the adapter's search tool instead.
    search: { tool: 'rami_levy_search_products', maxLimit: 30, normalize: normalizeRamiLevy, catalog: true },
    // The adapter declares no tool annotations. Without readOnlyHint, clients
    // such as ChatGPT treat every tool as a write and ask for confirmation.
    annotations: {
      rami_levy_search_products: { readOnlyHint: true },
      rami_levy_view_cart: { readOnlyHint: true },
      rami_levy_suggest_reorder: { readOnlyHint: true },
      rami_levy_list_orders: { readOnlyHint: true },
      rami_levy_view_order: { readOnlyHint: true },
      rami_levy_check_status: { readOnlyHint: true },
      rami_levy_remove_item: { destructiveHint: true },
      rami_levy_clear_cart: { destructiveHint: true },
    },
  },
};

function searchFor(def, env) {
  if (!def.search.catalog || env.GROCERY_RAMI_LEVY_SEARCH === 'adapter') return def.search;
  return {
    ...def.search,
    run: async ({ query, limit }) => {
      const data = await fetchRamiCatalog(query, {
        url: env.GROCERY_RAMI_LEVY_CATALOG_URL || undefined,
        store: env.RAMI_LEVY_STORE || '412',
        userAgent: env.RAMI_LEVY_USER_AGENT,
        cookie: env.RAMI_LEVY_COOKIE,
      });
      return normalizeRamiCatalog(data).slice(0, limit);
    },
  };
}

export function createStores(env = process.env) {
  const ids = (env.GROCERY_STORES || Object.keys(STORE_DEFS).join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = ids.filter((id) => !STORE_DEFS[id]);
  if (unknown.length) throw new Error(`Unknown store in GROCERY_STORES: ${unknown.join(', ')}. Known: ${Object.keys(STORE_DEFS).join(', ')}`);

  return ids.map((id) => {
    const def = STORE_DEFS[id];
    const entry = path.resolve(repoRoot, env[def.entryEnv] || def.entry);
    return new StoreClient({
      id,
      label: def.label,
      toolPrefix: def.toolPrefix,
      search: searchFor(def, env),
      annotations: def.annotations,
      command: process.execPath,
      args: [entry],
      cwd: path.resolve(path.dirname(entry), '..'),
      // The SDK passes only a few variables to children by default; the
      // adapters read their credentials and data paths from the environment.
      env: { ...env },
    });
  });
}
