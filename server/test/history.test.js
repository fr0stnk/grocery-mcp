import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { dayOf, PriceHistory, priceHistory, startTracker } from '../src/history.js';

const DAY = 86_400_000;
const item = (store, productId, price, extra = {}) => ({ store, productId, barcode: '7290004131074', name: 'חלב 3%', price, priceBasis: 'unit', ...extra });

test('PriceHistory keeps one row per store, product and day, and summarizes against the usual price', async () => {
  let now = Date.parse('2026-10-01T09:00:00Z');
  const history = new PriceHistory(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hist-')), 'h.db'), { now: () => now });
  const prices = [7.5, 7.5, 7.9, 7.5, 7.5];
  for (const [i, price] of prices.entries()) {
    now = Date.parse('2026-10-01T09:00:00Z') + i * 10 * DAY;
    await history.record([item('shufersal', 'P_4131074', price), item('rami-levy', '3025', price - 0.3)]);
  }
  await history.record([item('shufersal', 'P_4131074', 6.9, { regularPrice: 7.5, promotions: [{ text: '2 ב-14', clubOnly: false }] })]);
  assert.equal(await history.record([{ store: 'shufersal', productId: 'x', price: null }]), 0, 'rows without a price are skipped');

  const out = await priceHistory(history, { barcode: '7290004131074' });
  const shufersal = out.products.find((p) => p.store === 'shufersal');
  assert.equal(shufersal.series.length, 5, 'the same day is updated, not duplicated');
  assert.deepEqual(shufersal.current, { price: 6.9, day: dayOf(now), promotion: '2 ב-14' });
  assert.deepEqual([shufersal.usualPrice, shufersal.vsUsual, shufersal.isLowestSeen, shufersal.change30Days], [7.5, -0.6, true, -0.6]);
  assert.deepEqual([shufersal.lowest.price, shufersal.highest.price], [6.9, 7.9]);
  assert.equal(out.products.find((p) => p.store === 'rami-levy').current.price, 7.2);

  const one = await priceHistory(history, { store: 'rami-levy', productId: '3025', days: 15 });
  assert.equal(one.products[0].series.length, 2, 'days limits the period');
  assert.match((await priceHistory(history, { barcode: '7290000000000' })).note, /No prices recorded/);
  await assert.rejects(priceHistory(history, {}), (e) => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(priceHistory(history, { barcode: 'abc' }), (e) => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(priceHistory(history, { preference: 'milk' }, { preferences: { get: () => null } }), (e) => e.code === 'NOT_FOUND');
  const byPreference = await priceHistory(history, { preference: 'milk' }, { preferences: { get: () => ({ name: 'milk', query: 'חלב' }) }, findIds: async () => [{ store: 'rami-levy', productId: '3025' }] });
  assert.equal(byPreference.products[0].productId, '3025');
  history.close();
});

test('the tracker searches every saved preference in every store and logs failures', async () => {
  const searched = [];
  const logs = [];
  const tracker = startTracker({
    preferences: { list: () => [{ name: 'milk', barcode: '7290004131074' }, { name: 'bread', query: 'לחם' }, { name: 'dup', barcode: '7290004131074' }] },
    stores: [{ id: 'shufersal' }, { id: 'rami-levy' }],
    search: async (store, q) => { if (store.id === 'rami-levy' && q === 'לחם') throw new Error('down'); searched.push(`${store.id}:${q}`); },
    firstDelayMs: 1e9,
    intervalMs: 1e9,
    log: (m) => logs.push(m),
  });
  await tracker.run();
  tracker.stop();
  assert.deepEqual(searched, ['shufersal:7290004131074', 'rami-levy:7290004131074', 'shufersal:לחם']);
  assert.ok(logs.some((m) => /rami-levy "לחם": down/.test(m)) && logs.some((m) => /3 searches for 2 preferences/.test(m)));
});
