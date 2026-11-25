import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bootstrap } from '../src/db/bootstrap.js';
import { migrate, openDatabase } from '../src/db/database.js';
import { ensureEnvironmentStoreAccount, ensureLocalOwner, pruneAudit, recordAudit, storeAccountFor, storeAccountsFor } from '../src/db/people.js';
import { DbPreferenceStore } from '../src/db/preferences.js';
import { createVault, masterKeys, newMasterKey } from '../src/db/vault.js';
import { PriceHistory, priceHistory } from '../src/history.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grocery-db-'));

test('the database migrates once, also when opened again, and is private to its owner', async () => {
  const file = path.join(tempDir(), 'nested', 'grocery.db');
  const db = await openDatabase(file);
  assert.deepEqual(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version), [1]);
  assert.deepEqual(migrate(db), [], 'nothing left to apply');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  for (const t of ['users', 'store_accounts', 'store_access', 'addresses', 'preferences', 'carts', 'cart_syncs', 'audit_log', 'prices']) assert.ok(tables.includes(t), t);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  db.close();
  const again = await openDatabase(file);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 1);
  assert.throws(() => migrate(again, [{ version: 2, name: 'broken', sql: 'CREATE TABLE nope (' }]), /migration 2 \(broken\) failed/);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 1, 'a failed migration is rolled back');
  again.close();
});

test('the vault seals with a per-value key, binds the context and survives a key rotation', () => {
  const k1 = newMasterKey(1);
  const vault = createVault({ GROCERY_MASTER_KEY: k1 });
  const sealed = vault.seal('{"cookies":[1]}', 'store_accounts:a:session');
  assert.match(sealed, /^gv1\.1\./);
  assert.notEqual(vault.seal('same', 'x'), vault.seal('same', 'x'), 'a fresh data key and IV each time');
  assert.equal(vault.open(sealed, 'store_accounts:a:session'), '{"cookies":[1]}');
  assert.throws(() => vault.open(sealed, 'store_accounts:b:session'), (e) => e.code === 'STORAGE_ERROR', 'copied to another row it does not open');
  assert.throws(() => vault.open(sealed.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 'store_accounts:a:session'), (e) => e.code === 'STORAGE_ERROR');
  const rotated = createVault({ GROCERY_MASTER_KEY: newMasterKey(2), GROCERY_MASTER_KEYS_OLD: k1 });
  assert.equal(rotated.open(sealed, 'store_accounts:a:session'), '{"cookies":[1]}');
  assert.match(rotated.seal('x', 'c'), /^gv1\.2\./);
  const none = createVault({});
  assert.equal(none.available, false);
  assert.throws(() => none.seal('x', 'c'), /GROCERY_MASTER_KEY is not set/);
  assert.throws(() => masterKeys({ GROCERY_MASTER_KEY: 'short' }), /32 bytes/);
});

test('people get store accounts they own, and shared ones with a role', async () => {
  const db = await openDatabase(path.join(tempDir(), 'g.db'));
  const owner = ensureLocalOwner(db, { GROCERY_OWNER_EMAIL: 'owner@example.com' });
  assert.equal(ensureLocalOwner(db).id, owner.id, 'the same owner on every start');
  const shufersal = ensureEnvironmentStoreAccount(db, 'shufersal', owner.id);
  assert.equal(ensureEnvironmentStoreAccount(db, 'shufersal', owner.id).id, shufersal.id);
  db.prepare("INSERT INTO users (id, idp_sub, created_at) VALUES ('u2', 'idp:2', '2026-11-25')").run();
  db.prepare("INSERT INTO store_access (store_account_id, user_id, role, created_at) VALUES (?, 'u2', 'shopper', '2026-11-25')").run(shufersal.id);
  assert.deepEqual(storeAccountsFor(db, owner.id).map((a) => [a.store, a.role, a.status]), [['shufersal', 'owner', 'environment']]);
  assert.equal(storeAccountFor(db, 'u2', 'shufersal').role, 'shopper', 'a shared store account');
  assert.equal(storeAccountFor(db, 'u2', 'rami-levy'), null);
  assert.equal('session_enc' in storeAccountsFor(db, owner.id)[0], false, 'secrets are never selected for listings');
  recordAudit(db, { userId: owner.id, storeAccountId: shufersal.id, tool: 'search_all_stores', outcome: 'ok', durationMs: 12, details: 'x'.repeat(900) });
  assert.equal(db.prepare('SELECT details FROM audit_log').get().details.length, 500);
  assert.equal(pruneAudit(db, Date.now() + 401 * 86_400_000), 1);
  db.close();
});

test('database preferences behave like the file store, per person', async () => {
  const db = await openDatabase(path.join(tempDir(), 'g.db'));
  const a = ensureLocalOwner(db);
  db.prepare("INSERT INTO users (id, idp_sub, created_at) VALUES ('u2', 'idp:2', '2026-11-25')").run();
  const mine = new DbPreferenceStore(db, a.id);
  const theirs = new DbPreferenceStore(db, 'u2');
  assert.deepEqual(mine.save({ name: 'Milk', barcode: '7290004131074', quantity: 2, usual: true }).created, true);
  assert.equal(mine.save({ name: 'milk', note: 'lactose-free only' }).created, false, 'names are case-insensitive');
  assert.deepEqual(mine.get('MILK'), { name: 'Milk', barcode: '7290004131074', quantity: 2, usual: true, note: 'lactose-free only', updatedAt: mine.get('milk').updatedAt });
  assert.deepEqual(theirs.list(), [], 'preferences are per person');
  assert.throws(() => mine.save({ name: 'x' }), (e) => e.code === 'INVALID_ARGUMENT');
  assert.deepEqual(mine.remove('milk'), { removed: 'Milk' });
  assert.throws(() => mine.remove('milk'), (e) => e.code === 'NOT_FOUND');
  db.close();
});

test('bootstrap imports preferences.json and price-history.db once and keeps them as .imported', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({ version: 1, items: { milk: { name: 'milk', barcode: '7290004131074', quantity: 2, usual: true, updatedAt: '2026-11-20T10:00:00.000Z' } } }));
  const old = new PriceHistory(path.join(dir, 'price-history.db'), { now: () => Date.parse('2026-11-24T10:00:00Z') });
  await old.record([{ store: 'shufersal', productId: 'P_4131074', barcode: '7290004131074', name: 'חלב', price: 7.35 }]);
  old.close();

  const db = await openDatabase(path.join(dir, 'grocery.db'));
  const logs = [];
  const first = bootstrap(db, { env: {}, storeIds: ['shufersal', 'rami-levy'], dataDir: dir, log: (m) => logs.push(m) });
  assert.deepEqual([first.accounts.map((a) => a.store), first.imported], [['shufersal', 'rami-levy'], { preferences: 1, prices: 1 }]);
  assert.ok(fs.existsSync(path.join(dir, 'preferences.json.imported')) && fs.existsSync(path.join(dir, 'price-history.db.imported')));
  const second = bootstrap(db, { env: {}, storeIds: ['shufersal', 'rami-levy'], dataDir: dir });
  assert.deepEqual([second.owner.id, second.imported, second.accounts.map((a) => a.id)], [first.owner.id, { preferences: 0, prices: 0 }, first.accounts.map((a) => a.id)]);
  assert.equal(new DbPreferenceStore(db, first.owner.id).get('milk').updatedAt, '2026-11-20T10:00:00.000Z');
  const history = new PriceHistory(undefined, { db, now: () => Date.parse('2026-11-25T10:00:00Z') });
  assert.equal((await priceHistory(history, { barcode: '7290004131074' })).products[0].current.price, 7.35, 'imported prices are queried in place');
  history.close();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prices').get().n, 1, 'closing the history leaves the shared database open');
  assert.ok(logs.some((m) => /imported 1 preferences/.test(m)));
  db.close();
});

test('a connected store account is found again at startup, and the duplicate from v0.10.x is removed', async () => {
  const { saveSession } = await import('../src/db/sessions.js');
  const { createVault, newMasterKey } = await import('../src/db/vault.js');
  const db = await openDatabase(path.join(tempDir(), 'g.db'));
  const vault = createVault({ GROCERY_MASTER_KEY: newMasterKey() });
  const owner = ensureLocalOwner(db, {});
  const rami = ensureEnvironmentStoreAccount(db, 'rami-levy', owner.id);
  saveSession(db, vault, rami.id, { bearerToken: 'b' }, { expiresAt: '2027-01-23T00:00:00.000Z' });
  assert.equal(ensureEnvironmentStoreAccount(db, 'rami-levy', owner.id).id, rami.id, 'the connected account, not a new one');
  // The duplicate an older version created next to the connected account.
  db.prepare("INSERT INTO store_accounts (id, store, owner_user_id, status, created_at, updated_at) VALUES ('dup', 'rami-levy', ?, 'environment', '2026-11-25', '2026-11-25')").run(owner.id);
  db.prepare("INSERT INTO store_access (store_account_id, user_id, role, created_at) VALUES ('dup', ?, 'owner', '2026-11-25')").run(owner.id);
  assert.equal(ensureEnvironmentStoreAccount(db, 'rami-levy', owner.id).id, rami.id);
  assert.deepEqual(db.prepare("SELECT id FROM store_accounts WHERE store = 'rami-levy'").all().map((r) => r.id), [rami.id], 'the empty duplicate is gone');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM store_access WHERE store_account_id = 'dup'").get().n, 0, 'with its access rows');
  db.close();
});

