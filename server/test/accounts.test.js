import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccountMonitor, tokenExpiry } from '../src/accounts.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-25T12:00:00Z');
const jwt = (claims) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const monitorWith = (expSeconds) => new AccountMonitor({ env: { RAMI_LEVY_ECOM_TOKEN: expSeconds == null ? undefined : jwt({ exp: expSeconds }) }, now: () => NOW });

test('tokenExpiry reads a JWT exp and ignores anything else', () => {
  assert.equal(tokenExpiry(jwt({ exp: 1800000000 })).toISOString(), '2027-01-15T08:00:00.000Z');
  assert.equal(tokenExpiry(jwt({ sub: 'x' })), null);
  assert.equal(tokenExpiry('opaque-token'), null);
  assert.equal(tokenExpiry('a.%%%.c'), null);
  assert.equal(tokenExpiry(undefined), null);
});

test('warnings start a week before the Rami Levy token expires', () => {
  assert.deepEqual(monitorWith((NOW + 30 * DAY) / 1000).warnings(), []);
  assert.deepEqual(monitorWith(null).warnings(), []);
  assert.match(monitorWith((NOW + 3.5 * DAY) / 1000).warnings()[0], /expires in 3 days \(2026-11-29\)/);
  assert.match(monitorWith((NOW + 1.2 * DAY) / 1000).warnings()[0], /expires in 1 day \(/);
  assert.match(monitorWith((NOW - 2 * DAY) / 1000).warnings()[0], /expired on 2026-11-23.*search still works/);
});

test('only login-type failures are remembered, and a success clears them', () => {
  const monitor = monitorWith(null);
  monitor.observe('rami-levy', false, 'network timeout');
  assert.deepEqual(monitor.warnings(), []);
  monitor.observe('rami-levy', false, '{"ok":false,"error":"auth_expired"}');
  monitor.observe('shufersal', false, 'Not signed in - run: npm run login');
  assert.equal(monitor.warnings().length, 2);
  assert.match(monitor.warnings()[1], /^Shufersal login failed at 2026-11-25T12:00:00.000Z: Not signed in/);
  monitor.observe('shufersal', true);
  assert.deepEqual(monitor.warnings().map((w) => w.split(' ')[0]), ['Rami']);
});

test('status checks each store live and explains how to renew', async () => {
  const monitor = monitorWith((NOW + 40 * DAY) / 1000);
  const stores = [
    { id: 'shufersal', label: 'Shufersal', callTool: async (tool) => { assert.equal(tool, 'status'); return text({ signedIn: true, productCount: 2 }); } },
    { id: 'rami-levy', label: 'Rami Levy', callTool: async () => text({ ok: false, error: 'auth_expired' }) },
  ];
  const out = await monitor.status(stores);
  assert.equal(out.stores.shufersal.loggedIn, true);
  assert.equal(out.stores.shufersal.howToRenew, undefined);
  assert.equal(out.stores['rami-levy'].loggedIn, false);
  assert.match(out.stores['rami-levy'].howToRenew, /set_rami_levy_tokens/);
  assert.deepEqual(out.stores['rami-levy'].token, { expiresAt: new Date(NOW + 40 * DAY).toISOString(), daysLeft: 40 });
  assert.match(out.warnings[0], /Rami Levy login failed/);
  assert.equal(out.checkedAt, new Date(NOW).toISOString());

  const broken = await monitorWith(null).status([{ id: 'shufersal', label: 'Shufersal', callTool: async () => { throw new Error('Shufersal failed to start'); } }]);
  assert.deepEqual([broken.stores.shufersal.loggedIn, broken.stores.shufersal.detail], [false, 'Shufersal failed to start']);
  const hung = await monitorWith(null).status([{ id: 'rami-levy', label: 'Rami Levy', callTool: () => new Promise(() => {}) }], { timeoutMs: 50 });
  assert.match(hung.stores['rami-levy'].detail, /timed out/);
  assert.equal(hung.stores['rami-levy'].token.expiresAt, null);
});
