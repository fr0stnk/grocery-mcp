import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareBasket, lineCost, pickMatches } from '../src/basket.js';
import { createLimiter, SearchCache } from '../src/cache.js';

const p = (store, productId, barcode, price, extra = {}) => ({ store, productId, barcode, name: productId, price, ...extra });

test('SearchCache reuses fresh results, refetches after the TTL and falls back to stale data', async () => {
  let now = 0;
  const cache = new SearchCache({ ttlMs: 100, staleMs: 1000, now: () => now });
  let calls = 0;
  const load = async () => ++calls;
  assert.deepEqual([(await cache.get('k', load)).value, calls], [1, 1]);
  now = 50;
  const hit = await cache.get('k', load);
  assert.deepEqual([hit.value, hit.cached, calls], [1, true, 1]);
  now = 150;
  assert.deepEqual([(await cache.get('k', load)).value, calls], [2, 2]);
  now = 400;
  const stale = await cache.get('k', async () => { throw new Error('store down'); });
  assert.deepEqual([stale.value, stale.stale, stale.error], [2, true, 'store down']);
  now = 2000;
  await assert.rejects(cache.get('k', async () => { throw new Error('store down'); }), /store down/);
});

test('SearchCache merges concurrent loads of one key, and the limiter caps concurrency', async () => {
  const cache = new SearchCache();
  let calls = 0;
  const slow = () => new Promise((r) => setTimeout(() => r(++calls), 20));
  const [a, b] = await Promise.all([cache.get('x', slow), cache.get('x', slow)]);
  assert.deepEqual([a.value, b.value, calls], [1, 1, 1]);

  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => limit(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
  })));
  assert.equal(peak, 2);
});

test('pickMatches prefers a barcode sold in every store, ranked by relevance', () => {
  const lists = {
    shufersal: [p('shufersal', 'S1', '111', 9), p('shufersal', 'S2', '222', 7), p('shufersal', 'S3', '333', 5)],
    'rami-levy': [p('rami-levy', 'R1', '333', 4), p('rami-levy', 'R2', '222', 6), p('rami-levy', 'R3', '999', 3)],
  };
  const { matches, identical } = pickMatches(lists);
  assert.equal(identical, true);
  assert.deepEqual([matches.shufersal.productId, matches['rami-levy'].productId], ['S2', 'R2']);
});

test('pickMatches honors a pinned barcode, skips out-of-stock items and falls back to the top result', () => {
  const lists = {
    shufersal: [p('shufersal', 'S0', '111', 9, { inStock: false }), p('shufersal', 'S1', '444', 8)],
    'rami-levy': [p('rami-levy', 'R1', '555', 4)],
  };
  const fallback = pickMatches(lists);
  assert.deepEqual([fallback.identical, fallback.matches.shufersal.productId, fallback.matches['rami-levy'].productId], [false, 'S1', 'R1']);
  const pinned = pickMatches(lists, { barcode: '555' });
  assert.deepEqual([pinned.identical, pinned.matches.shufersal, pinned.matches['rami-levy'].productId], [false, null, 'R1']);
});

test('lineCost applies the best qualifying multi-buy and ignores club and personal offers', () => {
  const pasta = { price: 4.2, promotions: [
    { text: '4 for 10', quantity: 4, price: 10, clubOnly: false, personal: false },
    { text: 'club 2 for 5', quantity: 2, price: 5, clubOnly: true, personal: false },
  ] };
  assert.deepEqual(lineCost(pasta, 3), { lineTotal: 12.6 });
  assert.deepEqual(lineCost(pasta, 5), { lineTotal: 14.2, promotion: '4 for 10' });
  assert.deepEqual(lineCost({ price: 30.6 }, 0.5), { lineTotal: 15.3 });
});

test('compareBasket totals each store, compares common items and reports the split', async () => {
  const catalog = {
    shufersal: { 'חלב': [p('shufersal', 'P_1', '111', 7.35)], 'פסטה': [p('shufersal', 'P_2', '222', 5)], 'אבוקדו': [] },
    'rami-levy': { 'חלב': [p('rami-levy', '10', '111', 7.2)], 'פסטה': [p('rami-levy', '20', '222', 4.2, { promotions: [{ text: '4 for 10', quantity: 4, price: 10 }] })], 'אבוקדו': [p('rami-levy', '30', null, 12.9, { soldByWeight: true, pricePerUnit: 12.9, perUnit: 'kg' })] },
  };
  const store = (id) => ({ id, label: id, search: { maxLimit: 20, run: async ({ query }) => catalog[id][query] ?? [] } });
  const out = await compareBasket([store('shufersal'), store('rami-levy')], {
    items: [{ query: 'חלב', quantity: 2 }, { query: 'פסטה', quantity: 4 }, { query: 'אבוקדו', quantity: 1.5 }],
  }, { cache: new SearchCache() });

  assert.deepEqual(out.totals.shufersal, { total: 34.7, itemsFound: 2, missing: ['אבוקדו'] });
  assert.deepEqual(out.totals['rami-levy'], { total: 43.75, itemsFound: 3, missing: [] });
  assert.equal(out.items[1].offers['rami-levy'].promotion, '4 for 10');
  assert.deepEqual(out.comparable, { items: 2, identicalItems: 2, shufersal: 34.7, 'rami-levy': 24.4, cheaperStore: 'rami-levy', difference: 10.3 });
  assert.deepEqual(out.split, { total: 43.75, savingsOnCommonItems: 0 });
  assert.ok(out.notes.some((n) => /kilograms/.test(n)));
  assert.equal(out.stores.shufersal.ok, true);
  await assert.rejects(compareBasket([store('shufersal')], { items: [] }, { cache: new SearchCache() }), /non-empty/);
  await assert.rejects(compareBasket([store('shufersal')], { items: [{ query: 'x', quantity: 0 }] }, { cache: new SearchCache() }), /quantity/);
});

test('compareBasket reports a failing store and keeps the other', async () => {
  const ok = { id: 'rami-levy', label: 'Rami Levy', search: { maxLimit: 20, run: async () => [p('rami-levy', '10', '111', 7.2)] } };
  const down = { id: 'shufersal', label: 'Shufersal', search: { maxLimit: 20, run: async () => { throw new Error('login required'); } } };
  const out = await compareBasket([down, ok], { items: [{ query: 'חלב' }] }, { cache: new SearchCache() });
  assert.deepEqual(out.stores.shufersal, { ok: false, error: 'login required' });
  assert.equal(out.totals['rami-levy'].total, 7.2);
  assert.equal(out.items[0].offers.shufersal, null);
  assert.equal(out.comparable.items, 0);
});
