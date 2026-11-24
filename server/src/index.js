#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGroceryServer } from './app.js';
import { createStores } from './config.js';
import { parseListen, startHttpServer } from './http.js';
import { withTimeout } from './stores.js';

const STARTUP_TIMEOUT_MS = 40_000;
const log = (message) => process.stderr.write(`[grocery] ${message}\n`);

const readOnly = /^(1|true|yes)$/i.test(process.env.GROCERY_READ_ONLY ?? '');
const httpListen = process.env.GROCERY_HTTP ? parseListen(process.env.GROCERY_HTTP) : null;
const stores = createStores();

// Start the adapters before serving, so their tools and instructions are
// known. A store that fails here is retried on its next use.
await withTimeout(
  Promise.allSettled(stores.map((s) => s.listTools().catch((e) => log(e.message)))),
  STARTUP_TIMEOUT_MS,
  'store startup timed out',
).catch((e) => log(e.message));

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled(stores.map((s) => s.close()));
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

if (httpListen) {
  await startHttpServer({ ...httpListen, makeServer: () => createGroceryServer(stores, { readOnly, log }), log });
} else {
  const server = createGroceryServer(stores, { readOnly, log });
  server.onclose = () => void shutdown(0);
  // The SDK's stdio transport does not close on end of input, and the child
  // adapters' pipes would keep this process alive after the client leaves.
  process.stdin.on('end', () => void shutdown(0));
  await server.connect(new StdioServerTransport());
}

const summary = stores.map((s) => `${s.id}=${s.tools ? `${s.tools.length} tools` : 'unavailable'}`).join(', ');
log(`ready${readOnly ? ' (read-only)' : ''}: ${summary}`);
