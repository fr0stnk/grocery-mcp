import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGroceryServer } from '../src/app.js';
import { createCartJournal } from '../src/db/cart-syncs.js';
import { databaseFile, migrate, openDatabase } from '../src/db/database.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { ensureEnvironmentStoreAccount, ensureLocalOwner } from '../src/db/people.js';
import { startHttpServer } from '../src/http.js';
import { executeRamiCart } from '../src/rami-cart.js';

const ADD = 'rami_levy_add_item';
const BATCH = 'rami_levy_add_items';
const REORDER = 'rami_levy_reorder_from_history';
const REMOVE = 'rami_levy_remove_item';
const CLEAR = 'rami_levy_clear_cart';
const VIEW = 'rami_levy_view_cart';
const BASKET = 'add_basket_to_cart';
const item = { productId: '42', name: 'חלב', price: 6 };
const added = (idempotency_key, values = {}) => ({ ...item, ...values, idempotency_key });
const body = (r) => JSON.parse(r.content[0].text);
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const deferred = () => Promise.withResolvers();

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-cart-sync-'));
  const file = databaseFile({ GROCERY_DATA_DIR: dir });
  const closeables = [];
  t.after(async () => {
    for (const close of closeables.reverse()) await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const open = async () => {
    const db = await openDatabase(file);
    closeables.push(() => db.close());
    return db;
  };
  const db = await open();
  const owner = ensureLocalOwner(db);
  const account = ensureEnvironmentStoreAccount(db, 'rami-levy', owner.id);
  const db2 = await open();
  const transportCalls = [];
  const stores = [{
    id: 'rami-levy', label: 'Rami Levy', storeAccountId: account.id, exposedName: (name) => name,
    cacheKey: account.id,
    search: {
      maxLimit: 20,
      run: async ({ query }) => {
        transportCalls.push(query);
        return [{ ...item, store: 'rami-levy', priceBasis: 'unit', inStock: true }];
      },
    },
    tools: [ADD, BATCH, REORDER, REMOVE, CLEAR, VIEW].map((name) => ({
      name, inputSchema: { type: 'object', properties: {} },
      description: 'ok:false with a transport reason means nothing changed. ',
    })),
    async callTool(name) {
      assert.equal(name, VIEW, 'cart writes go through the tracked executor');
      return text({ ok: true, scope: 'local only' });
    },
  }];
  const local = new Map();
  const invocations = [];
  let send = async (payload) => ({ ok: true, acceptedIds: Object.keys(payload), serverTotal: 10.5 });
  function onSend(fn) { send = fn; }
  const cartExecutor = async (store, operation, args, observeSync) => {
    assert.equal('idempotency_key' in args, false);
    invocations.push({ operation, args, accountId: store.storeAccountId });
    const accountCart = local.get(store.storeAccountId) ?? new Map();
    const cart = new Map(accountCart);
    const addedItems = operation === ADD ? [args] : operation === BATCH ? args.items : operation === REORDER ? [{ ...item, qty: 1 }] : [];
    for (const i of addedItems) cart.set(i.productId, (cart.get(i.productId) ?? 0) + i.qty);
    if (operation === REMOVE && !cart.delete(args.productId)) return text({ ok: false, reason: 'not_in_cart', productId: args.productId });
    if (operation === CLEAR) cart.clear();
    const reply = await observeSync(Object.fromEntries(cart), () => send(Object.fromEntries(cart)));
    if (!reply.ok) return text(reply);
    const refused = addedItems.filter((i) => !reply.acceptedIds.includes(i.productId));
    local.set(store.storeAccountId, new Map([...cart].filter(([id]) => reply.acceptedIds.includes(id))));
    return text({
      ok: !refused.length,
      ...(refused.length ? { reason: 'items_rejected', rejected: refused } : {}),
      ...(operation === ADD || operation === REMOVE || operation === CLEAR ? {} : { added: addedItems }),
      serverTotal: reply.serverTotal,
      resetAfterOrder: { orderId: 'fixture-order', createdAt: '2026-11-25T12:00:00Z' },
    });
  };

  async function connect({ database = db, journal = createCartJournal(database, file), store = stores[0], http = false, readOnly = false, userId = owner.id } = {}) {
    const makeServer = () => createGroceryServer([store], { cartJournal: journal, cartExecutor, userId, readOnly });
    const client = new Client({ name: 'cart-sync-test', version: '1' });
    if (http) {
      const running = await startHttpServer({ host: '127.0.0.1', port: 0, makeServer });
      closeables.push(() => new Promise((resolve) => running.close(resolve)));
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.address().port}/mcp`)));
    } else {
      const server = makeServer();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      closeables.push(() => server.close());
    }
    closeables.push(() => client.close());
    return client;
  }

  return { db, db2, open, file, owner, account, connect, local, invocations, transportCalls, onSend, store: stores[0] };
}

const call = (c, name, args = {}) => c.callTool({ name, arguments: args });
const code = (r) => body(r).error?.code;

test('cart keys replay across HTTP and another connection after restart, ahead of catalog lookup', async (t) => {
  const f = await fixture(t);
  const http = await f.connect({ http: true });
  const operation = { store: 'rami-levy', items: [item], idempotency_key: 'basket-key' };
  const preview = await call(http, BASKET, { ...operation, dry_run: true });
  assert.equal(body(preview).results[0].status, 'would-add');
  assert.equal(f.invocations.length, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM cart_syncs').get().n, 0);

  const first = await call(http, BASKET, operation);
  assert.equal(body(first).added, 1);
  assert.equal(body(first).serverTotal, 10.5);
  await http.close();
  f.db.prepare("INSERT INTO users (id, idp_sub, created_at) VALUES ('shopper', 'test:shopper', '2026-11-25')").run();
  const restarted = await f.connect({ database: await f.open(), userId: 'shopper' });
  const replay = { idempotency_key: 'basket-key', items: [{ price: 6, name: 'חלב', productId: '42', quantity: 1 }], dry_run: false, store: 'rami-levy' };
  const searches = f.transportCalls.length;
  assert.deepEqual(await call(restarted, BASKET, replay), first);
  assert.equal(f.transportCalls.length, searches);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.local.get(f.account.id).get('42'), 1);
  assert.equal(code(await call(restarted, BASKET, { ...replay, items: [{ ...item, price: 7 }] })), 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(code(await call(restarted, ADD, added('basket-key'))), 'IDEMPOTENCY_KEY_CONFLICT');
  await call(restarted, BASKET, { ...operation, idempotency_key: 'other-key' });
  assert.equal(f.local.get(f.account.id).get('42'), 2);
  const row = f.db.prepare("SELECT * FROM cart_syncs WHERE idempotency_key = 'basket-key'").get();
  assert.equal(row.user_id, f.owner.id);
  assert.equal(row.operation, BASKET);
  assert.equal(row.status, 'completed');
  assert.equal(f.db.prepare("SELECT user_id FROM cart_syncs WHERE idempotency_key = 'other-key'").get().user_id, 'shopper');
  assert.match(row.request_hash, /^[0-9a-f]{64}$/);
  assert.ok(row.finished_at >= row.at);
  assert.deepEqual(JSON.parse(row.result).accepted, [{ productId: '42', quantity: 1 }]);
});

test('concurrent writes across two database connections serialize by account, including unkeyed mutations', async (t) => {
  const f = await fixture(t);
  const c1 = await f.connect();
  const c2 = await f.connect({ database: f.db2 });
  const entered = deferred();
  const release = deferred();
  f.onSend(async (payload) => {
    entered.resolve();
    await release.promise;
    return { ok: true, acceptedIds: Object.keys(payload), serverTotal: null };
  });
  const first = call(c1, ADD, added('same'));
  await entered.promise;
  assert.equal(code(await call(c2, ADD, added('same', { qty: 1 }))), 'CART_SYNC_IN_PROGRESS');
  assert.equal(code(await call(c2, ADD, added('same', { qty: 2 }))), 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(code(await call(c2, ADD, added('different'))), 'CART_SYNC_IN_PROGRESS');
  assert.equal(code(await call(c2, CLEAR)), 'CART_SYNC_IN_PROGRESS');
  assert.equal(f.invocations.length, 1);

  f.db2.prepare('INSERT INTO store_accounts (id, store, owner_user_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('second', 'rami-levy', f.owner.id, 'environment', '2026-01-01', '2026-01-01');
  const separate = await f.connect({ database: f.db2, store: { ...f.store, storeAccountId: 'second' } });
  const second = call(separate, ADD, added('same'));
  while (f.invocations.length < 2) await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(body(a).ok, true);
  assert.equal(body(b).ok, true);
  assert.deepEqual(await call(c2, ADD, added('same')), a);
  assert.equal(f.local.get(f.account.id).get('42'), 1);
  assert.equal(f.local.get('second').get('42'), 1);
});

test('lost store confirmation is recorded as unknown and cannot resend after reconnect', async (t) => {
  const f = await fixture(t);
  let applied = 0;
  f.onSend(async (payload) => {
    applied = payload['42'];
    throw new Error('private network response');
  });
  const c = await f.connect();
  const result = await call(c, ADD, added('lost'));
  assert.equal(code(result), 'CART_SYNC_UNKNOWN');
  const restarted = await f.connect({ database: await f.open() });
  assert.deepEqual(await call(restarted, ADD, added('lost')), result);
  assert.equal(f.invocations.length, 1);
  assert.equal(applied, 1);
  const row = f.db.prepare('SELECT * FROM cart_syncs').get();
  assert.equal(row.status, 'unknown');
  assert.equal(row.error, 'CART_SYNC_UNKNOWN');
  assert.doesNotMatch(row.result, /private network response/);
  f.onSend(async (payload) => ({ ok: true, acceptedIds: Object.keys(payload), serverTotal: null }));
  assert.equal(body(await call(restarted, CLEAR)).ok, true, 'a new operation can run once the executor is done');
});

test('timing out the MCP caller keeps the real execution and account lock alive', async (t) => {
  const f = await fixture(t);
  const sender = await f.connect();
  const retry = await f.connect({ database: f.db2 });
  const entered = deferred();
  const release = deferred();
  f.onSend(async (payload) => {
    entered.resolve();
    await release.promise;
    return { ok: true, acceptedIds: Object.keys(payload), serverTotal: 6 };
  });
  const args = added('slow');
  const pending = sender.callTool({ name: ADD, arguments: args }, undefined, { timeout: 40 });
  const timedOut = assert.rejects(pending, /timed out/i);
  try {
    await entered.promise;
    await timedOut;
    assert.equal(code(await call(retry, ADD, args)), 'CART_SYNC_IN_PROGRESS');
    assert.equal(code(await call(retry, CLEAR)), 'CART_SYNC_IN_PROGRESS');
  } finally {
    release.resolve();
  }
  await new Promise((resolve) => setImmediate(resolve));
  const result = await call(retry, ADD, args);
  assert.equal(body(result).ok, true);
  assert.equal(f.invocations.length, 1);
  assert.equal(f.local.get(f.account.id).get('42'), 1);
});

test('a live executor in another process holds its account until exit, and an abandoned key becomes unknown', async (t) => {
  const f = await fixture(t);
  const script = `
    import {openDatabase} from ${JSON.stringify(new URL('../src/db/database.js', import.meta.url).href)};
    import {createCartJournal} from ${JSON.stringify(new URL('../src/db/cart-syncs.js', import.meta.url).href)};
    const [file, accountId, userId] = process.argv.slice(1);
    const journal = createCartJournal(await openDatabase(file), file);
    await journal.run({accountId,userId,key:'crash',operation:${JSON.stringify(ADD)},args:${JSON.stringify({...item, qty: 1})}}, (observe) =>
      observe({'42': 1}, () => new Promise(() => { console.log('applied'); setInterval(() => {}, 1000); })));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.file, f.account.id, f.owner.id],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  const exited = once(child, 'exit');
  await Promise.race([once(child.stdout, 'data'), exited.then(() => assert.fail('cart executor exited early'))]);
  const c = await f.connect({ database: f.db2 });
  assert.equal(code(await call(c, ADD, added('crash'))), 'CART_SYNC_IN_PROGRESS');
  assert.equal(code(await call(c, REMOVE, { productId: '42' })), 'CART_SYNC_IN_PROGRESS');
  child.kill('SIGKILL');
  await exited;
  assert.equal(code(await call(c, ADD, added('crash'))), 'CART_SYNC_UNKNOWN');
  assert.equal(f.invocations.length, 0);
  assert.equal(f.db.prepare("SELECT status FROM cart_syncs WHERE idempotency_key = 'crash'").get().status, 'unknown');
  assert.equal(body(await call(c, ADD, added('after-crash'))).ok, true);
});

test('partial, confirmed rejection, no-op, unkeyed and direct writes record their outcomes', async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  assert.equal(body(await call(c, VIEW)).scope, 'local only');
  const toolSchema = Object.fromEntries((await c.listTools()).tools.map((x) => [x.name, x.inputSchema]));
  for (const name of [ADD, BATCH, REORDER, BASKET]) assert.equal(toolSchema[name].properties.idempotency_key.maxLength, 128);
  for (const name of [REMOVE, CLEAR, VIEW]) assert.equal(toolSchema[name].properties.idempotency_key, undefined);

  const second = { productId: '55', name: 'לחם', price: 7 };
  const args = { items: [item, second], idempotency_key: 'partial' };
  f.onSend(async () => ({ ok: true, acceptedIds: ['42'], serverTotal: 6 }));
  const partial = await call(c, BATCH, args);
  assert.equal(body(partial).reason, 'items_rejected');
  assert.deepEqual(body(partial).resetAfterOrder, { orderId: 'fixture-order', createdAt: '2026-11-25T12:00:00Z' });
  assert.deepEqual(await call(c, BATCH, args), partial);
  assert.equal(code(await call(c, BATCH, { ...args, items: [second, item] })), 'IDEMPOTENCY_KEY_CONFLICT');
  const row = f.db.prepare("SELECT * FROM cart_syncs WHERE idempotency_key = 'partial'").get();
  assert.equal(row.status, 'partial');
  assert.equal(row.server_total, 6);
  assert.deepEqual(JSON.parse(row.result).rejected, [{ productId: '55', quantity: 1 }]);

  f.onSend(async () => ({ ok: false, reason: 'auth_expired', status: 401 }));
  assert.equal(body(await call(c, ADD, added('expired'))).reason, 'auth_expired');
  assert.equal(f.db.prepare("SELECT status FROM cart_syncs WHERE idempotency_key = 'expired'").get().status, 'no_write');
  f.onSend(async (payload) => ({ ok: true, acceptedIds: Object.keys(payload), serverTotal: null }));
  const reorder = await call(c, REORDER, { idempotency_key: 'reorder' });
  assert.deepEqual(await call(c, REORDER, { numOrders: 10, minOccurrences: 3, idempotency_key: 'reorder' }), reorder);
  assert.equal(code(await call(c, REORDER, { minOccurrences: 2, idempotency_key: 'reorder' })), 'IDEMPOTENCY_KEY_CONFLICT');
  assert.equal(body(await call(c, ADD, item)).ok, true);
  assert.equal(body(await call(c, ADD, item)).ok, true);
  assert.equal(f.local.get(f.account.id).get('42'), 4);
  assert.equal(body(await call(c, REMOVE, { productId: 'missing' })).reason, 'not_in_cart');
  assert.equal(body(await call(c, REMOVE, { productId: '42' })).ok, true);
  assert.equal(body(await call(c, CLEAR)).ok, true);
  assert.equal(f.local.get(f.account.id).size, 0);
  assert.deepEqual(f.db.prepare('SELECT status FROM cart_syncs WHERE idempotency_key IS NULL ORDER BY rowid').all().map((r) => r.status),
    ['completed', 'completed', 'no_write', 'completed', 'completed']);
});

test('invalid keys and unavailable journal fail before cart execution, while preview does not reserve', async (t) => {
  const f = await fixture(t);
  const c = await f.connect();
  for (const key of ['', ' ', 'x'.repeat(129), 3, null]) {
    assert.equal(code(await call(c, ADD, added(key))), 'INVALID_ARGUMENT');
  }
  assert.equal(code(await call(c, BASKET, { store: 'shufersal', items: [item], idempotency_key: 'key' })), 'INVALID_ARGUMENT');
  assert.equal(code(await call(c, ADD, added('invalid', { price: -1 }))), 'INVALID_ARGUMENT');
  assert.equal(f.db.prepare('SELECT count(*) n FROM cart_syncs').get().n, 0);
  const missing = await f.connect({ journal: null });
  assert.equal(code(await call(missing, ADD, item)), 'CART_SYNC_UNAVAILABLE');
  assert.equal(code(await call(missing, BASKET, { store: 'rami-levy', items: [item] })), 'CART_SYNC_UNAVAILABLE');
  assert.equal(body(await call(missing, BASKET, { store: 'rami-levy', items: [item], dry_run: true, idempotency_key: 'preview' })).results[0].status, 'would-add');
  f.db.exec('DROP TABLE cart_syncs');
  assert.equal(code(await call(c, ADD, item)), 'CART_SYNC_UNAVAILABLE');
  assert.equal(code(await call(c, ADD, added('key'))), 'CART_SYNC_UNAVAILABLE');
  assert.equal(f.invocations.length, 0);
});

test('failure to persist the result leaves the key reserved after the store confirms', async (t) => {
  const f = await fixture(t);
  f.onSend(async (payload) => {
    f.db2.exec(`CREATE TRIGGER cart_persist_failure BEFORE UPDATE ON cart_syncs WHEN NEW.status = 'completed'
      BEGIN SELECT RAISE(ABORT, 'test write failure'); END`);
    return { ok: true, acceptedIds: Object.keys(payload), serverTotal: 6 };
  });
  const c = await f.connect();
  assert.equal(code(await call(c, ADD, added('persistence-error'))), 'CART_SYNC_UNKNOWN');
  assert.equal(f.local.get(f.account.id).get('42'), 1);
  assert.equal(f.db.prepare("SELECT status FROM cart_syncs WHERE idempotency_key = 'persistence-error'").get().status, 'in_progress');
  assert.equal(code(await call(await f.connect({ database: f.db2 }), ADD, added('persistence-error'))), 'CART_SYNC_UNKNOWN');
  assert.equal(f.invocations.length, 1);
});

test('migration extends the existing journal and preserves the old cart rows', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-old-cart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'grocery.db');
  const old = new DatabaseSync(file);
  migrate(old, MIGRATIONS.slice(0, 2));
  const owner = ensureLocalOwner(old);
  const account = ensureEnvironmentStoreAccount(old, 'rami-levy', owner.id);
  old.prepare('INSERT INTO carts (store_account_id, product_id, quantity, updated_at) VALUES (?, ?, ?, ?)').run(account.id, '42', 3, '2026-11-25');
  old.prepare('INSERT INTO cart_syncs (id, store_account_id, at, result) VALUES (?, ?, ?, ?)').run('previous', account.id, '2026-11-25', '{"old":true}');
  old.close();
  const db = await openDatabase(file);
  assert.equal(db.prepare('SELECT quantity FROM carts').get().quantity, 3);
  assert.deepEqual({ ...db.prepare('SELECT status, result FROM cart_syncs').get() }, { status: 'legacy', result: '{"old":true}' });
  db.close();
});

test('executor uses the adapter cart path, observes its send, and sanitizes the public journal result', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-adapter-cart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cart.db');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE local_items (qty INTEGER); INSERT INTO local_items VALUES (3)");
  old.close();
  let closed = 0;
  let sends = 0;
  const fakeModules = async () => ({
    CartStore: class {
      constructor(fileName) { this.db = new DatabaseSync(fileName); }
      close() { this.db.close(); closed++; }
    },
    RamiLevyClient: class {
      async syncCart(payload) {
        sends++;
        assert.deepEqual(payload, { 42: '4.00' });
        return { ok: false, reason: 'rejected', status: 422, details: 'private body plus credentials' };
      }
    },
    ramiLevyToolHandlers(cart, client) {
      return {
        async addItem(args) {
          const qty = cart.db.prepare('SELECT qty FROM local_items').get().qty;
          return text({ ...await client.syncCart({ [args.productId]: (qty + args.qty).toFixed(2) }), extra: 'secret' });
        },
      };
    },
  });
  const store = { cwd: dir, args: [path.join(dir, 'index.js')], env: {
    RAMI_LEVY_DB_PATH: file, RAMI_LEVY_BEARER_TOKEN: 'fake-a', RAMI_LEVY_ECOM_TOKEN: 'fake-b', RAMI_LEVY_USER_AGENT: 'fake-c',
  } };
  const response = await executeRamiCart(store, ADD, { ...item, qty: 1 }, async (payload, send) => {
    assert.deepEqual(payload, { 42: '4.00' });
    return send();
  }, fakeModules);
  assert.deepEqual(body(response), { ok: false, reason: 'rejected', status: 422, details: 'Rami Levy did not return a usable cart confirmation.' });
  assert.deepEqual([sends, closed], [1, 1]);
  const reopened = new DatabaseSync(file);
  assert.equal(reopened.prepare('SELECT qty FROM local_items').get().qty, 3);
  reopened.close();
  await assert.rejects(executeRamiCart({ ...store, env: {} }, ADD, item), { code: 'STORE_UNAVAILABLE' });
});

test('the stdio process reopens the journal and preserves the adapter cart across runs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-stdio-cart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const adapter = path.join(dir, 'adapter');
  fs.mkdirSync(adapter);
  fs.writeFileSync(path.join(adapter, 'package.json'), '{"type":"module"}');
  const fixture = {
    'index.js': `
      import {Server} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
      import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
      import {ListToolsRequestSchema} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
      const server = new Server({name:'fake-rami',version:'1'}, {capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools:[{name:${JSON.stringify(ADD)}, inputSchema:{type:'object',properties:{}}}],
      }));
      await server.connect(new StdioServerTransport());
    `,
    'store.js': `
      import {DatabaseSync} from 'node:sqlite';
      export class CartStore {
        constructor(file) { this.db = new DatabaseSync(file); }
        close() { this.db.close(); }
      }
    `,
    'client.js': `
      export class RamiLevyClient {
        async syncCart(payload) { return {ok:true, acceptedIds:Object.keys(payload), serverTotal:12}; }
      }
    `,
    'tools.js': `
      export const ramiLevyToolHandlers = (cart, client) => ({ async addItem({productId, qty}) {
        const quantity = cart.db.prepare('SELECT qty FROM cart_items').get().qty + qty;
        const reply = await client.syncCart({[productId]:quantity});
        cart.db.prepare('UPDATE cart_items SET qty = ?, calls = calls + 1').run(quantity);
        return {content:[{type:'text',text:JSON.stringify({ok:reply.ok,itemCount:1,serverTotal:reply.serverTotal})}]};
      }});
    `,
  };
  for (const [name, code] of Object.entries(fixture)) fs.writeFileSync(path.join(adapter, name), code);
  const file = path.join(dir, 'grocery.db');
  const cartPath = path.join(dir, 'cart.db');
  const cart = new DatabaseSync(cartPath);
  cart.exec('CREATE TABLE cart_items (qty REAL, calls INTEGER); INSERT INTO cart_items VALUES (3, 0)');
  cart.close();

  async function run(args) {
    const c = new Client({ name: 'stdio-cart-test', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
      env: {
        GROCERY_STORES: 'rami-levy', GROCERY_DATABASE_FILE: file, GROCERY_PRICE_HISTORY: 'off',
        GROCERY_RAMI_LEVY_ENTRY: path.join(adapter, 'index.js'), RAMI_LEVY_DB_PATH: cartPath,
        RAMI_LEVY_BEARER_TOKEN: 'fake-a', RAMI_LEVY_ECOM_TOKEN: 'fake-b', RAMI_LEVY_USER_AGENT: 'fake-c',
      },
      stderr: 'pipe',
    });
    transport.stderr?.resume();
    try {
      await c.connect(transport);
      return await call(c, ADD, args);
    } finally {
      await c.close();
    }
  }

  const first = await run(added('stdio'));
  assert.equal(body(first).ok, true);
  assert.deepEqual(await run(added('stdio', { qty: 1 })), first);
  const reopened = new DatabaseSync(cartPath);
  assert.deepEqual({ ...reopened.prepare('SELECT * FROM cart_items').get() }, { qty: 4, calls: 1 });
  reopened.close();
});
