import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { ensureEnvironmentStoreAccount, ensureLocalOwner } from '../src/db/people.js';
import { clearSession, effectiveStatus, loadSession, markChecked, saveSession } from '../src/db/sessions.js';
import { createVault, newMasterKey } from '../src/db/vault.js';
import { jwtExpiry, ramiSessionFromCurl, shellWords } from '../src/rami-curl.js';

const NOW = Date.parse('2026-11-25T12:00:00Z');
const jwt = (expSeconds) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url'), 'sig'].join('.');
const ECOM = jwt(NOW / 1000 + 60 * 86_400);

const curl = (extra = '') => `curl 'https://www.rami-levy.co.il/api/v2/cart' \\
  -H 'accept: application/json, text/plain, */*' \\
  -H 'authorization: Bearer opaque-bearer-value' \\
  -H 'ecomtoken: ${ECOM}' \\
  -H 'user-agent: Mozilla/5.0 (Macintosh) Test' \\
  -b 'cf_clearance=abc; other=1' ${extra}`;

test('shellWords reads DevTools quoting', () => {
  assert.deepEqual(shellWords(`curl 'a b' "c \\"d\\"" $'e\\'f' g\\ h`), ['curl', 'a b', 'c "d"', "e'f", 'g h']);
  assert.throws(() => shellWords("curl 'open"), /unclosed quote/);
});

test('a Rami Levy session is read from Copy as cURL, with its expiry and without leaking values in errors', () => {
  const { session, expiresAt } = ramiSessionFromCurl(curl(), { now: NOW });
  assert.deepEqual(session, { bearerToken: 'opaque-bearer-value', ecomToken: ECOM, userAgent: 'Mozilla/5.0 (Macintosh) Test', cookie: 'cf_clearance=abc; other=1' });
  assert.equal(expiresAt, new Date(jwtExpiry(ECOM)).toISOString());
  assert.equal(jwtExpiry('opaque'), null);
  assert.throws(() => ramiSessionFromCurl('fetch(...)'), /not a cURL command/);
  assert.throws(() => ramiSessionFromCurl(curl().replace('www.rami-levy.co.il', 'evil.example')), /for evil\.example, not Rami Levy/);
  assert.throws(() => ramiSessionFromCurl(curl().replace(/-H 'ecomtoken[^']*' \\\n/, '')), /missing from the copied request: ecomtoken/);
  const expired = curl().replace(ECOM, jwt(NOW / 1000 - 10));
  assert.throws(() => ramiSessionFromCurl(expired, { now: NOW }), (e) => /already expired/.test(e.message) && !e.message.includes('opaque-bearer-value'));
});

test('sessions are sealed per store account, and their status follows the expiry', async () => {
  const db = await openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')), 'g.db'));
  const vault = createVault({ GROCERY_MASTER_KEY: newMasterKey() });
  const owner = ensureLocalOwner(db, {});
  const rami = ensureEnvironmentStoreAccount(db, 'rami-levy', owner.id);
  const shufersal = ensureEnvironmentStoreAccount(db, 'shufersal', owner.id);
  assert.equal(loadSession(db, vault, rami.id), null);

  saveSession(db, vault, rami.id, { bearerToken: 'b', ecomToken: 'e' }, { expiresAt: '2026-12-10T00:00:00.000Z', now: NOW });
  const row = db.prepare('SELECT * FROM store_accounts WHERE id = ?').get(rami.id);
  assert.equal(row.session_enc.includes('"b"'), false, 'stored encrypted');
  assert.deepEqual(loadSession(db, vault, rami.id), { bearerToken: 'b', ecomToken: 'e' });
  db.prepare('UPDATE store_accounts SET session_enc = (SELECT session_enc FROM store_accounts WHERE id = ?) WHERE id = ?').run(rami.id, shufersal.id);
  assert.throws(() => loadSession(db, vault, shufersal.id), (e) => e.code === 'STORAGE_ERROR', "one account's session does not open as another's");

  assert.deepEqual([row.status, effectiveStatus(row, NOW), effectiveStatus(row, Date.parse('2026-12-05T00:00:00Z')), effectiveStatus(row, Date.parse('2026-12-11T00:00:00Z'))], ['connected', 'connected', 'expiring', 'expired']);
  markChecked(db, rami.id, { ok: false, error: 'HTTP 401', now: NOW });
  assert.deepEqual(Object.values(db.prepare('SELECT status, last_error FROM store_accounts WHERE id = ?').get(rami.id)), ['error', 'HTTP 401']);
  clearSession(db, rami.id, { now: NOW });
  assert.deepEqual([loadSession(db, vault, rami.id), db.prepare('SELECT status FROM store_accounts WHERE id = ?').get(rami.id).status], [null, 'disconnected']);
  assert.throws(() => saveSession(db, vault, 'missing', {}), (e) => e.code === 'NOT_FOUND');
  db.close();
});
