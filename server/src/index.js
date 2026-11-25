#!/usr/bin/env node
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AccountMonitor } from './accounts.js';
import { createGroceryServer } from './app.js';
import { createStores } from './config.js';
import { PreferenceStore } from './preferences.js';
import { bootstrap } from './db/bootstrap.js';
import { databaseFile, openDatabase } from './db/database.js';
import { recordAudit } from './db/people.js';
import { DbPreferenceStore } from './db/preferences.js';
import { createVault } from './db/vault.js';
import { PriceHistory, startTracker } from './history.js';
import { recordSearchesWith, searchStore } from './search.js';
import { parseListen, startHttpServer } from './http.js';
import { withTimeout } from './stores.js';
import { BUILD, FULL_VERSION } from './version.js';

const STARTUP_TIMEOUT_MS = 40_000;
const log = (message) => process.stderr.write(`[grocery] ${message}\n`);

const readOnly = /^(1|true|yes)$/i.test(process.env.GROCERY_READ_ONLY ?? '');
const httpListen = process.env.GROCERY_HTTP ? parseListen(process.env.GROCERY_HTTP) : null;
const stores = createStores();
const monitor = new AccountMonitor();
const historyOff = /^(0|false|no|off)$/i.test(process.env.GROCERY_PRICE_HISTORY ?? '');

// The database holds people, store accounts, preferences, prices and the audit
// log. If it cannot be opened, the server still runs on the older files.
let preferences = new PreferenceStore();
let history = historyOff ? null : new PriceHistory();
let audit = () => {};
try {
  const file = databaseFile();
  const db = await openDatabase(file);
  const { owner, accounts } = bootstrap(db, { storeIds: stores.map((s) => s.id), dataDir: path.dirname(file), log });
  const accountOf = new Map(accounts.map((a) => [a.store, a.id]));
  preferences = new DbPreferenceStore(db, owner.id);
  history = historyOff ? null : new PriceHistory(undefined, { db });
  audit = ({ tool, store, outcome, durationMs, details }) =>
    recordAudit(db, { userId: owner.id, storeAccountId: accountOf.get(store) ?? null, tool, outcome, durationMs, details });
  const vault = createVault();
  log(`database ${file}: ${accounts.length} store accounts${vault.available ? `, master key v${vault.keyVersion}` : ', no master key yet (GROCERY_MASTER_KEY)'}`);
} catch (error) {
  log(`database unavailable, using the preferences and price files: ${error.message}`);
}
if (history) recordSearchesWith((items) => history.record(items));

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
  await startHttpServer({ ...httpListen, makeServer: () => createGroceryServer(stores, { readOnly, log, preferences, monitor, history, audit }), log });
  // Only the long-running server tracks prices; one-shot stdio runs just record what they search.
  if (history) startTracker({ preferences, stores, search: (store, q) => searchStore(store, q), log });
} else {
  const server = createGroceryServer(stores, { readOnly, log, preferences, monitor, history, audit });
  server.onclose = () => void shutdown(0);
  // The SDK's stdio transport does not close on end of input, and the child
  // adapters' pipes would keep this process alive after the client leaves.
  process.stdin.on('end', () => void shutdown(0));
  await server.connect(new StdioServerTransport());
}

const summary = stores.map((s) => `${s.id}=${s.tools ? `${s.tools.length} tools` : 'unavailable'}`).join(', ');
log(`ready ${FULL_VERSION}${BUILD.buildDate ? ` built ${BUILD.buildDate}` : ''}${readOnly ? ' (read-only)' : ''}: ${summary}`);
