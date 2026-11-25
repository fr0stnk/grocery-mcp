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
import { loadSession } from './db/sessions.js';
import { tokenExpiry } from './accounts.js';
import { startAccountServer } from './web/account.js';
import { PriceHistory, startTracker } from './history.js';
import { recordSearchesWith, searchStore } from './search.js';
import { parseListen, startHttpServer } from './http.js';
import { withTimeout } from './stores.js';
import { BUILD, FULL_VERSION } from './version.js';

const STARTUP_TIMEOUT_MS = 40_000;
/** How a saved store session becomes that adapter's environment. */
const SESSION_ENV = {
  'rami-levy': (s) => ({
    RAMI_LEVY_BEARER_TOKEN: s.bearerToken,
    RAMI_LEVY_ECOM_TOKEN: s.ecomToken,
    RAMI_LEVY_USER_AGENT: s.userAgent,
    ...(s.cookie ? { RAMI_LEVY_COOKIE: s.cookie } : {}),
  }),
};
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

  // A store login saved on the account page replaces the one from .env for that
  // store's adapter. Adapters read their environment when they start, so a
  // change closes the adapter and the next call starts it with the new login.
  const applySession = (storeId) => {
    const store = stores.find((s) => s.id === storeId);
    const account = accounts.find((a) => a.store === storeId);
    if (!store || !account || !vault.available || !SESSION_ENV[storeId]) return false;
    const session = loadSession(db, vault, account.id);
    store.env = { ...process.env, ...(session ? SESSION_ENV[storeId](session) : {}) };
    if (storeId === 'rami-levy') monitor.ramiTokenExpiry = tokenExpiry(store.env.RAMI_LEVY_ECOM_TOKEN);
    return Boolean(session);
  };
  for (const s of stores) if (applySession(s.id)) log(`${s.id}: using the login saved on the account page`);

  if (process.env.GROCERY_ACCOUNT_HTTP && httpListen) {
    const { host, port } = parseListen(process.env.GROCERY_ACCOUNT_HTTP);
    await startAccountServer({
      host, port, db, vault, ownerId: owner.id, log,
      extraHosts: (process.env.GROCERY_ACCOUNT_HOSTS ?? '').split(','),
      onSessionChange: (storeId) => {
        applySession(storeId);
        void stores.find((s) => s.id === storeId)?.close();
        log(`${storeId}: login changed on the account page; the adapter restarts on its next call`);
      },
    });
  }
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
