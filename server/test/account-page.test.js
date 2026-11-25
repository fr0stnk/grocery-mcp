import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { ensureEnvironmentStoreAccount, ensureLocalOwner } from '../src/db/people.js';
import { getAddress, getProfile, normalizePhone, saveAddress, saveProfile } from '../src/db/profile.js';
import { loadSession } from '../src/db/sessions.js';
import { createVault, newMasterKey } from '../src/db/vault.js';
import { allowedListenHost, startAccountServer } from '../src/web/account.js';

const NOW = Date.parse('2026-11-26T10:00:00Z');
const jwt = (exp) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 's'].join('.');
const CURL = `curl 'https://www.rami-levy.co.il/api/v2/cart' -H 'authorization: Bearer bearer-x' -H 'ecomtoken: ${jwt(NOW / 1000 + 50 * 86400)}' -H 'user-agent: UA test'`;

async function setup() {
  const db = await openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acct-')), 'g.db'));
  const vault = createVault({ GROCERY_MASTER_KEY: newMasterKey() });
  const owner = ensureLocalOwner(db, {});
  const rami = ensureEnvironmentStoreAccount(db, 'rami-levy', owner.id);
  ensureEnvironmentStoreAccount(db, 'shufersal', owner.id);
  return { db, vault, owner, rami };
}

test('profile and address are stored with the phone and the address line encrypted', async () => {
  const { db, vault, owner } = await setup();
  assert.equal(normalizePhone('050-123-4567'), '+972501234567');
  assert.equal(normalizePhone('+972 50 1234567'), '+972501234567');
  assert.throws(() => normalizePhone('12'), (e) => e.code === 'INVALID_ARGUMENT');
  saveProfile(db, vault, owner.id, { firstName: 'Dana', lastName: 'Levi', email: 'dana@example.com', phone: '050-123-4567' });
  assert.deepEqual(getProfile(db, vault, owner.id), { firstName: 'Dana', lastName: 'Levi', email: 'dana@example.com', phone: '+972501234567' });
  assert.equal(db.prepare('SELECT phone_enc FROM users WHERE id = ?').get(owner.id).phone_enc.includes('972'), false);
  assert.throws(() => saveProfile(db, vault, owner.id, { firstName: 'Dana', lastName: 'Levi', email: 'nope', phone: '0501234567' }), /email address/);
  assert.throws(() => saveProfile(db, vault, owner.id, { firstName: 'Dana', email: 'dana@example.com' }), /last name, phone are required/);
  assert.equal(getAddress(db, vault, owner.id), null);
  const first = saveAddress(db, vault, owner.id, { city: 'תל אביב', street: 'הרצל', houseNumber: '12', apartment: '4', notes: 'Code 1234' });
  assert.throws(() => saveAddress(db, vault, owner.id, { city: 'חיפה', street: 'הנמל', houseNumber: '3' }), /apartment are required/);
  assert.deepEqual({ ...first, id: undefined }, { id: undefined, city: 'תל אביב', street: 'הרצל', houseNumber: '12', apartment: '4', floor: null, entrance: null, notes: 'Code 1234' });
  const row = db.prepare('SELECT * FROM addresses').get();
  assert.equal(row.address_enc.includes('1234'), false, 'the house number and notes are encrypted');
  assert.equal(saveAddress(db, vault, owner.id, { city: 'חיפה', street: 'הנמל', houseNumber: '3', apartment: '1' }).id, first.id, 'one default address, updated in place');
  assert.throws(() => saveAddress(db, vault, owner.id, { city: 'חיפה' }), /required/);
  db.close();
});

test('the account page listens only on loopback or the tailnet', () => {
  for (const ok of ['127.0.0.1', '::1', 'localhost', '100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1']) assert.equal(allowedListenHost(ok), true, ok);
  for (const bad of ['0.0.0.0', '::', '192.168.1.10', '100.128.0.1', '8.8.8.8', 'example.com']) assert.equal(allowedListenHost(bad), false, bad);
  return assert.rejects(startAccountServer({ host: '0.0.0.0', port: 0 }), /only listen on loopback or the tailnet/);
});

test('the account page saves forms with CSRF tokens, refuses others, and connects Rami Levy', async () => {
  const { db, vault, owner, rami } = await setup();
  const changes = [];
  const server = await startAccountServer({ host: '127.0.0.1', port: 0, db, vault, ownerId: owner.id, onSessionChange: (s) => changes.push(s), now: () => NOW });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Listening on port 0 picks a free port; the Host check needs the real one.
  server.close();
  const real = await startAccountServer({ host: '127.0.0.1', port: Number(base.split(':').pop()), db, vault, ownerId: owner.id, onSessionChange: (s) => changes.push(s), now: () => NOW });
  try {
    let page = await (await fetch(`${base}/account`)).text();
    assert.match(page, /Grocery account/);
    const token = (action) => new RegExp(`action="/account/${action}">\\s*<input type="hidden" name="csrf" value="([^"]+)"`).exec(page)[1];
    const post = (action, fields, headers = {}) => fetch(`${base}/account/${action}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) });

    assert.equal((await post('profile', { csrf: 'forged', firstName: 'X' })).status, 403);
    assert.equal((await post('profile', { csrf: token('profile'), firstName: 'X' }, { origin: 'https://evil.example' })).status, 403);
    const rebound = await new Promise((resolve, reject) => {
      http.get(`${base}/account`, { headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(rebound, 421, 'DNS rebinding: an unknown Host is refused');
    const tunnelled = await new Promise((resolve, reject) => {
      http.get(`${base}/account`, { headers: { host: 'localhost:9999' } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
    });
    assert.equal(tunnelled, 200, 'an SSH tunnel arrives as localhost on its own port');

    const saved = await post('profile', { csrf: token('profile'), firstName: '<b>Dana</b>', lastName: 'Levi', email: 'dana@example.com', phone: '0501234567' });
    assert.equal(saved.status, 200);
    const html = await saved.text();
    assert.match(html, /Profile saved/);
    assert.match(html, /&lt;b&gt;Dana&lt;\/b&gt;/, 'values are escaped');
    assert.match(saved.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(saved.headers.get('referrer-policy'), 'same-origin', 'so browsers send the real Origin on the page\'s own forms');
    assert.equal((await post('profile', { csrf: token('profile'), firstName: 'X', lastName: 'Y', email: 'x@example.com', phone: '0501234567' }, { origin: base })).status, 200, 'a same-origin form, as Chrome sends it');
    assert.equal(saved.headers.get('cache-control'), 'no-store');

    const bad = await post('connect-rami-levy', { csrf: token('connect-rami-levy'), curl: 'fetch(...)' });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /not a cURL command/);
    const connected = await post('connect-rami-levy', { csrf: token('connect-rami-levy'), curl: CURL });
    page = await connected.text();
    assert.match(page, /Rami Levy connected; the login lasts until 2027-01-15/);
    assert.match(page, /Connected/);
    assert.deepEqual(loadSession(db, vault, rami.id), { bearerToken: 'bearer-x', ecomToken: jwt(NOW / 1000 + 50 * 86400), userAgent: 'UA test' });
    const disconnected = await post('disconnect', { csrf: token('disconnect'), account: rami.id });
    assert.match(await disconnected.text(), /Rami Levy disconnected/);
    assert.equal(loadSession(db, vault, rami.id), null);
    assert.deepEqual(changes, ['rami-levy', 'rami-levy']);
    assert.equal((await post('nothing', { csrf: 'x' })).status, 404);
  } finally {
    real.close();
    db.close();
  }
});
