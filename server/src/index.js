#!/usr/bin/env node
// The low-level Server is used because store tools are forwarded with their
// JSON Schemas unchanged, which McpServer's zod-based registration cannot do.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createStores } from './config.js';
import { SEARCH_TOOL, searchAllStores } from './search.js';
import { withTimeout } from './stores.js';

const STARTUP_TIMEOUT_MS = 40_000;
const FORWARD_TIMEOUT_MS = 120_000;
const log = (message) => process.stderr.write(`[grocery] ${message}\n`);

const stores = createStores();

// Start the adapters before answering initialize, so their instructions can
// be included. A store that fails here is retried on its next use.
await withTimeout(
  Promise.allSettled(stores.map((s) => s.listTools().catch((e) => log(e.message)))),
  STARTUP_TIMEOUT_MS,
  'store startup timed out',
).catch((e) => log(e.message));

const instructions = [
  'Grocery tools for two Israeli supermarkets: Shufersal and Rami Levy.',
  'Use search_all_stores to compare prices across stores. It does not match products between stores, so compare by name, size and pricePerUnit, and say which items you treat as equivalent.',
  'Each store keeps its own cart. Store tools are prefixed shufersal_ and rami_levy_. None of them can check out or pay.',
  ...stores.filter((s) => s.instructions).map((s) => `${s.label} tools:\n${s.instructions.trim()}`),
].join('\n\n');

const server = new Server(
  { name: 'grocery-mcp', version: '0.1.0' },
  { capabilities: { tools: { listChanged: true } }, instructions },
);

function forwardedTools() {
  const routes = new Map();
  for (const store of stores) {
    for (const tool of store.tools ?? []) {
      routes.set(store.exposedName(tool.name), { store, tool });
    }
  }
  return routes;
}

async function refreshMissingTools() {
  const missing = stores.filter((s) => !s.tools && s.client);
  if (!missing.length) return;
  await Promise.allSettled(missing.map((s) => s.listTools()));
  await server.sendToolListChanged().catch(() => {});
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    SEARCH_TOOL,
    ...[...forwardedTools()].map(([name, { store, tool }]) => ({
      ...tool,
      name,
      description: `[${store.label}] ${tool.description ?? ''}`.trim(),
    })),
  ],
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

  const route = forwardedTools().get(name);
  if (!route) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  try {
    return await route.store.callTool(route.tool.name, args, FORWARD_TIMEOUT_MS);
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `${route.store.label}: ${error.message}` }] };
  }
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled(stores.map((s) => s.close()));
  process.exit(code);
}
server.onclose = () => void shutdown(0);
// The SDK's stdio transport does not close on end of input, and the child
// adapters' pipes would keep this process alive after the client leaves.
process.stdin.on('end', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

await server.connect(new StdioServerTransport());
log(`ready: ${stores.map((s) => `${s.id}=${s.tools ? `${s.tools.length} tools` : 'unavailable'}`).join(', ')}`);
