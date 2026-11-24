// The low-level Server is used because store tools are forwarded with their
// JSON Schemas unchanged, which McpServer's zod-based registration cannot do.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { SEARCH_TOOL, searchAllStores } from './search.js';

const FORWARD_TIMEOUT_MS = 110_000;

export function buildInstructions(stores, { readOnly }) {
  return [
    'Grocery tools for two Israeli supermarkets: Shufersal and Rami Levy.',
    'Use search_all_stores to compare prices across stores. It does not match products between stores, so compare by name, size and pricePerUnit, and say which items you treat as equivalent.',
    'Language: users may write in Hebrew, Russian or English, and both store catalogs are in Hebrew. Search with Hebrew terms: use Hebrew requests as written, and translate Russian or English ones first (молоко / milk → חלב, яйца / eggs → ביצים, творог → קוטג\' or גבינה לבנה). If a search returns nothing, retry with a shorter or more common Hebrew term or a synonym before saying it is unavailable. Answer in the user\'s language. Show each product\'s Hebrew name as returned, with a short translation unless the user writes Hebrew, and prices in ₪.',
    readOnly
      ? 'This server is read-only: searching, carts, orders and status can be viewed, but nothing can be added, changed or removed.'
      : 'Each store keeps its own cart. Store tools are prefixed shufersal_ and rami_levy_. None of them can check out or pay.',
    ...stores.filter((s) => s.instructions).map((s) => `${s.label} tools:\n${s.instructions.trim()}`),
  ].join('\n\n');
}

/** Store tools as clients see them: prefixed name, store label, merged annotations. */
export function forwardedTools(stores, { readOnly }) {
  const routes = new Map();
  for (const store of stores) {
    for (const tool of store.tools ?? []) {
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

export function createGroceryServer(stores, { readOnly = false, log = () => {} } = {}) {
  const server = new Server(
    { name: 'grocery-mcp', version: '0.2.0' },
    { capabilities: { tools: { listChanged: true } }, instructions: buildInstructions(stores, { readOnly }) },
  );

  async function refreshMissingTools() {
    const missing = stores.filter((s) => !s.tools && s.client);
    if (!missing.length) return;
    await Promise.allSettled(missing.map((s) => s.listTools()));
    await server.sendToolListChanged().catch(() => {});
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [SEARCH_TOOL, ...[...forwardedTools(stores, { readOnly }).values()].map((r) => r.listed)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name === SEARCH_TOOL.name) {
      try {
        const result = await searchAllStores(stores, args);
        void refreshMissingTools();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    }

    const route = forwardedTools(stores, { readOnly }).get(name);
    if (!route) {
      const hidden = readOnly && forwardedTools(stores, { readOnly: false }).has(name);
      const text = hidden ? `${name} changes data and this server is read-only.` : `Unknown tool: ${name}`;
      return { isError: true, content: [{ type: 'text', text }] };
    }
    try {
      log(`call ${name}`);
      return await route.store.callTool(route.tool.name, args, FORWARD_TIMEOUT_MS);
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `${route.store.label}: ${error.message}` }] };
    }
  });

  return server;
}
