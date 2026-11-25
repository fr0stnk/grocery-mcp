// The low-level Server is used because store tools are forwarded with their
// JSON Schemas unchanged, which McpServer's zod-based registration cannot do.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ACCOUNT_TOOL, AccountMonitor } from './accounts.js';
import { BASKET_TOOL, compareBasket } from './basket.js';
import { ADD_BASKET_TOOL, addBasketToCart } from './order.js';
import { PREFERENCE_TOOLS, runPreferenceTool } from './preferences.js';
import { PRICE_HISTORY_TOOL, priceHistory } from './history.js';
import { SEARCH_TOOL, searchAllStores, searchStore } from './search.js';
import { BUILD, FULL_VERSION } from './version.js';

const FORWARD_TIMEOUT_MS = 110_000;

export function buildInstructions(stores, { readOnly }) {
  return [
    'Grocery tools for two Israeli supermarkets: Shufersal and Rami Levy.',
    'Use search_all_stores to compare prices of one product type across stores. Identical products are matched by barcode in sameProduct; compare the rest by name, size and pricePerUnit, and say which items you treat as equivalent.',
    'For a shopping list, use compare_basket with all items at once: it returns each store\'s total, missing items, a fair comparison over items both stores have, and the split total. Mention items where identical is false, and that delivery fees are not included. To order, show the chosen store\'s list and pass its offers to add_basket_to_cart in one call instead of adding items one by one.',
    'For questions about which version or commit is running, use server_info.',
    'Logins: when a result carries accountWarnings, tell the user in one short sentence and offer account_status for details and how to renew.',
    'Household preferences: list_preferences shows saved products (for example "milk" pinned to an exact barcode). Use them for "the usual milk" or "our usual basket" (compare_basket with usual: true). When the user picks a product they want again, offer to save it with save_preference, using its barcode.',
    'Language: users may write in Hebrew, Russian or English, and both store catalogs are in Hebrew. Search with Hebrew terms: use Hebrew requests as written, and translate Russian or English ones first (молоко / milk → חלב, яйца / eggs → ביצים, творог → קוטג\' or גבינה לבנה). If a search returns nothing, retry with a shorter or more common Hebrew term or a synonym before saying it is unavailable. Answer in the user\'s language. Show each product\'s Hebrew name as returned, with a short translation unless the user writes Hebrew, and prices in ₪.',
    readOnly
      ? 'This server is read-only: searching, carts, orders and status can be viewed, but nothing can be added, changed or removed.'
      : 'Each store keeps its own cart. Store tools are prefixed shufersal_ and rami_levy_. None of them can check out or pay.',
    ...stores.filter((s) => s.instructions).map((s) => `${s.label} tools:\n${s.instructions.trim()}`),
  ].join('\n\n');
}

/** Store tools as clients see them: prefixed name, store label, merged annotations. */
/** Adapter tools only this server may call; a model must never be offered them (they take passwords). */
export const HOST_ONLY_TOOLS = new Set(['login_with_password']);

export function forwardedTools(stores, { readOnly }) {
  const routes = new Map();
  for (const store of stores) {
    for (const tool of store.tools ?? []) {
      if (HOST_ONLY_TOOLS.has(tool.name)) continue;
      const annotations = { ...tool.annotations, ...store.annotations?.[tool.name] };
      if (readOnly && annotations.readOnlyHint !== true) continue;
      routes.set(store.exposedName(tool.name), {
        store,
        tool,
        listed: {
          ...tool,
          name: store.exposedName(tool.name),
          description: `[${store.label}] ${tool.description ?? ''}`.trim(),
          ...(Object.keys(annotations).length ? { annotations } : {}),
        },
      });
    }
  }
  return routes;
}

/** A short log summary of one of our own tool calls, without personal data. */
function describeCall(name, args, result) {
  const storeState = Object.entries(result.stores ?? {})
    .map(([id, st]) => `${id}=${st.ok ? (st.stale ? 'stale' : st.cached ? 'cached' : 'live') : 'error'}`)
    .join(' ');
  if (name === SEARCH_TOOL.name) return `"${String(args.query ?? '').slice(0, 60)}" ${storeState}`;
  if (name === BASKET_TOOL.name) return `${result.items?.length ?? 0} items ${storeState}`;
  if (name === ADD_BASKET_TOOL.name) return `${result.store} ${result.dryRun ? 'dry run ' : ''}${result.requested} items${result.added != null ? `, ${result.added} added` : ''}`;
  return '';
}

const STARTED_AT = new Date();

export const SERVER_INFO_TOOL = {
  name: 'server_info',
  title: 'Server version and build',
  description:
    'Report what is running: version, git commit, build time, image tag, the pinned store adapter commits, uptime, ' +
    'read-only mode and each store\'s connection. Use it when the user asks which version or commit is deployed.',
  annotations: { readOnlyHint: true },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export function serverInfo(stores, { readOnly }) {
  return {
    name: 'grocery-mcp',
    ...BUILD,
    fullVersion: FULL_VERSION,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
    readOnly,
    stores: Object.fromEntries(stores.map((s) => [s.id, { connected: Boolean(s.client), tools: s.tools?.length ?? 0 }])),
  };
}

/** Each store's top search result for a query, for history of a preference saved without a barcode. */
async function topIds(stores, query) {
  const found = await Promise.allSettled(stores.map((s) => searchStore(s, query)));
  return found.flatMap((f, i) => (f.status === 'fulfilled' && f.value.value[0] ? [{ store: stores[i].id, productId: f.value.value[0].productId }] : []));
}

/** The server's own tools with their handlers; write tools are left out in read-only mode. */
function ownTools(stores, preferences, monitor, { readOnly, history }) {
  const tools = [
    [SERVER_INFO_TOOL, () => serverInfo(stores, { readOnly })],
    [ACCOUNT_TOOL, () => monitor.status(stores)],
    [SEARCH_TOOL, (args) => searchAllStores(stores, args)],
    [BASKET_TOOL, (args) => compareBasket(stores, args, { preferences })],
    [ADD_BASKET_TOOL, (args) => addBasketToCart(stores, args, { history })],
    ...PREFERENCE_TOOLS.map((tool) => [tool, (args) => runPreferenceTool(preferences, tool.name, args)]),
    ...(history ? [[PRICE_HISTORY_TOOL, (args) => priceHistory(history, args, { preferences, findIds: (q) => topIds(stores, q) })]] : []),
  ];
  return new Map(tools.filter(([tool]) => !readOnly || tool.annotations?.readOnlyHint === true).map(([tool, run]) => [tool.name, { tool, run }]));
}

/** Feeds search and basket outcomes to the monitor and attaches its warnings to the result. */
function withAccountWarnings(name, result, monitor) {
  if (name !== SEARCH_TOOL.name && name !== BASKET_TOOL.name) return result;
  for (const [store, status] of Object.entries(result.stores ?? {})) {
    if (!status.ok) monitor.observe(store, false, status.error);
    // Shufersal search needs the login; Rami Levy's catalog search does not.
    else if (store === 'shufersal' && !status.cached) monitor.observe(store, true);
  }
  const warnings = monitor.warnings();
  return warnings.length ? { ...result, accountWarnings: warnings } : result;
}

export function createGroceryServer(stores, { readOnly = false, log = () => {}, preferences = null, monitor = new AccountMonitor(), history = null, audit = () => {} } = {}) {
  const record = (entry) => {
    try {
      audit(entry);
    } catch (error) {
      log(`audit not recorded: ${error.message}`);
    }
  };
  const server = new Server(
    { name: 'grocery-mcp', version: FULL_VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: buildInstructions(stores, { readOnly }) },
  );

  async function refreshMissingTools() {
    const missing = stores.filter((s) => !s.tools && s.client);
    if (!missing.length) return;
    await Promise.allSettled(missing.map((s) => s.listTools()));
    await server.sendToolListChanged().catch(() => {});
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...[...ownTools(stores, preferences, monitor, { readOnly, history }).values()].map((t) => t.tool), ...[...forwardedTools(stores, { readOnly }).values()].map((r) => r.listed)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const own = ownTools(stores, preferences, monitor, { readOnly, history }).get(name);
    if (own) {
      const started = Date.now();
      try {
        const result = withAccountWarnings(name, await own.run(args), monitor);
        const summary = describeCall(name, args, result);
        log(`call ${name} ${summary} in ${Date.now() - started} ms`);
        record({ tool: name, store: typeof args.store === 'string' ? args.store : null, outcome: 'ok', durationMs: Date.now() - started, details: summary });
        void refreshMissingTools();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        // Errors of our own tools carry a stable code the client can act on.
        const body = { error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message, retryable: Boolean(error.retryable) } };
        record({ tool: name, store: typeof args.store === 'string' ? args.store : null, outcome: body.error.code, durationMs: Date.now() - started });
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
      }
    }

    const route = forwardedTools(stores, { readOnly }).get(name);
    if (!route) {
      const hidden = readOnly && (forwardedTools(stores, { readOnly: false }).has(name) || ownTools(stores, preferences, monitor, { readOnly: false, history }).has(name));
      const text = hidden ? `${name} changes data and this server is read-only.` : `Unknown tool: ${name}`;
      return { isError: true, content: [{ type: 'text', text }] };
    }
    const started = Date.now();
    try {
      log(`call ${name}`);
      const result = await route.store.callTool(route.tool.name, args, FORWARD_TIMEOUT_MS);
      const body = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      const failed = result.isError || /"ok"\s*:\s*false/.test(body);
      if (failed) monitor.observe(route.store.id, false, body);
      record({ tool: name, store: route.store.id, outcome: failed ? 'STORE_ERROR' : 'ok', durationMs: Date.now() - started });
      return result;
    } catch (error) {
      monitor.observe(route.store.id, false, error.message);
      record({ tool: name, store: route.store.id, outcome: 'STORE_ERROR', durationMs: Date.now() - started });
      return { isError: true, content: [{ type: 'text', text: `${route.store.label}: ${error.message}` }] };
    }
  });

  return server;
}
