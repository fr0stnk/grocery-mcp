import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { forwardedTools, HOST_ONLY_TOOLS } from '../src/app.js';
import { jarExpiry, readCookieJar, writeCookieJar } from '../src/shufersal-session.js';

test('the cookie jar is written privately, read back, and its expiry is the latest persistent cookie', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jar-')), 'nested', 'cookies.json');
  assert.equal(readCookieJar(file), null);
  const jar = { cookies: [{ name: 'a', expires: -1 }, { name: 'b', expires: 1_800_000_000 }, { name: 'c', expires: 1_700_000_000 }] };
  writeCookieJar(file, jar);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readCookieJar(file), jar);
  assert.equal(jarExpiry(jar), new Date(1_800_000_000_000).toISOString());
  assert.equal(jarExpiry({ cookies: [{ expires: -1 }] }), null);
  fs.writeFileSync(file, '{"cookies":[]}');
  assert.equal(readCookieJar(file), null, 'an empty jar is no session');
});

test('host-only adapter tools are never forwarded to clients', () => {
  const store = { id: 'shufersal', label: 'Shufersal', tools: [{ name: 'login_with_password', annotations: {} }, { name: 'status', annotations: { readOnlyHint: true } }], exposedName: (n) => `shufersal_${n}` };
  assert.ok(HOST_ONLY_TOOLS.has('login_with_password'));
  assert.deepEqual([...forwardedTools([store], { readOnly: false }).keys()], ['shufersal_status']);
});
