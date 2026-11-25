import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareBasket, constraintsOf, fitOf, lineCost, pickMatches } from '../src/basket.js';
import { normalizeShufersalRaw } from '../src/normalize.js';
import { createLimiter, SearchCache } from '../src/cache.js';

const p = (store, productId, barcode, price, extra = {}) => ({ store, productId, barcode, name: productId, price, ...extra });
// Fixtures named only by id get the query in their name, as real search results would carry it.
const named = (list, query) => (list ?? []).map((x) => (x.name === x.productId ? { ...x, name: `${query} ${x.productId}` } : x));

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

  const bananas = {
    shufersal: [p('shufersal', 'banana', null, 11.9), p('shufersal', 'b2', null, 13), p('shufersal', 'b3', null, 9), p('shufersal', 'drink', '777', 12.5)],
    'rami-levy': [p('rami-levy', 'banana', null, 8.9), p('rami-levy', 'drink', '777', 9.9)],
  };
  const fresh = pickMatches(bananas);
  assert.deepEqual([fresh.identical, fresh.matches.shufersal.productId, fresh.matches['rami-levy'].productId], [false, 'banana', 'banana'], 'a shared barcode ranked 4th does not beat the top result');
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
    'rami-levy': { 'חלב': [p('rami-levy', '10', '111', 7.2)], 'פסטה': [p('rami-levy', '20', '222', 4.2, { promotions: [{ text: '4 for 10', quantity: 4, price: 10 }] })], 'אבוקדו': [p('rami-levy', '30', null, 12.9, { soldByWeight: true, priceBasis: 'kg', pricePerUnit: 12.9, perUnit: 'kg' })] },
  };
  const store = (id) => ({ id, label: id, search: { maxLimit: 20, run: async ({ query }) => named(catalog[id][query], query) } });
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
  const ok = { id: 'rami-levy', label: 'Rami Levy', search: { maxLimit: 20, run: async () => [p('rami-levy', '10', '111', 7.2, { name: 'חלב 3%' })] } };
  const down = { id: 'shufersal', label: 'Shufersal', search: { maxLimit: 20, run: async () => { throw new Error('login required'); } } };
  const out = await compareBasket([down, ok], { items: [{ query: 'חלב' }] }, { cache: new SearchCache() });
  assert.deepEqual(out.stores.shufersal, { ok: false, error: 'login required' });
  assert.equal(out.totals['rami-levy'].total, 7.2);
  assert.equal(out.items[0].offers.shufersal, null);
  assert.equal(out.comparable.items, 0);
});

test('constraintsOf reads size, count and grade, and fitOf rejects products that contradict them', () => {
  assert.deepEqual(constraintsOf('חלב 3% 1 ליטר'), { size: { amount: 1, unit: 'L', label: '1 L' }, percent: 3 });
  assert.deepEqual(constraintsOf('ביצים 12 L'), { count: 12, grade: 'L' });
  assert.deepEqual(constraintsOf('חלב 3%'), { percent: 3 }, 'a percentage is not a count');
  const eggs = constraintsOf('ביצים 12 L');
  assert.equal(fitOf({ name: 'ביצים 12 יח גדול L' }, eggs), 'match');
  assert.equal(fitOf({ name: 'ביצים 18 יח L' }, eggs), '18 units, not 12');
  assert.equal(fitOf({ name: 'ביצים 12 יח M' }, eggs), 'grade M, not L');
  assert.equal(fitOf({ name: 'ביצים ארוזות L' }, eggs), 'unknown');
  assert.equal(fitOf({ name: 'חלב', size: '2 L' }, constraintsOf('חלב 1 ליטר')), 'size 2 L, not 1 L');
  assert.equal(fitOf({ name: 'חלב', size: '1 L' }, constraintsOf('חלב 1 ליטר')), 'match');
});

test('compareBasket honours the requested size, count and grade (review G-01)', async () => {
  const catalog = {
    shufersal: {
      'חלב 3% 1 ליטר': [p('shufersal', 'P_2L', '222', 14.7, { size: '2 L' }), p('shufersal', 'P_1L', '111', 7.35, { size: '1 L' })],
      'ביצים 12 L': [p('shufersal', 'P_18', null, 21.81, { name: 'ביצים 18 יח L', count: 18 }), p('shufersal', 'P_ML', null, 13, { name: 'ביצים 12 יח M', count: 12 })],
    },
    'rami-levy': {
      'חלב 3% 1 ליטר': [p('rami-levy', '20', '222', 14.9, { size: '2 L' }), p('rami-levy', '10', '111', 7.2, { size: '1 L' })],
      'ביצים 12 L': [p('rami-levy', '40', null, 14.5, { name: 'ביצים 12 יח גדול L', count: 12 }), p('rami-levy', '41', null, 12, { name: 'ביצים ארוזות L' })],
    },
  };
  const store = (id) => ({ id, label: id, search: { maxLimit: 20, run: async ({ query }) => named(catalog[id][query], query) } });
  const out = await compareBasket([store('shufersal'), store('rami-levy')], { items: [{ query: 'חלב 3% 1 ליטר', quantity: 2 }, { query: 'ביצים 12 L' }] }, { cache: new SearchCache() });
  const [milk, eggs] = out.items;
  assert.deepEqual([milk.identical, milk.offers.shufersal.productId, milk.offers['rami-levy'].productId], [true, 'P_1L', '10'], '1 L, not the 2 L ranked first');
  assert.deepEqual(milk.constraints, { size: '1 L', percent: 3 });
  assert.equal(eggs.offers.shufersal, null, 'neither 18 L nor 12 M eggs are 12 L eggs');
  assert.equal(eggs.offers['rami-levy'].productId, '40');
  assert.deepEqual(out.totals.shufersal.missing, ['ביצים 12 L']);
  assert.ok(out.notes.some((n) => /rather than offering a different one/.test(n)));
});

test('compareBasket does not multiply kilograms by a unit or package price (review G-02)', async () => {
  const catalog = {
    shufersal: { 'עגבניות': [p('shufersal', 'P_PKG', null, 8.9, { priceBasis: 'package', priceEstimated: true, soldByWeight: true })] },
    'rami-levy': { 'עגבניות': [p('rami-levy', '50', null, 10.7, { priceBasis: 'unit' })], 'בננה': [p('rami-levy', '51', null, 6.9, { priceBasis: 'kg', soldByWeight: true })] },
  };
  catalog.shufersal['בננה'] = [p('shufersal', 'P_B', null, 7.9, { priceBasis: 'kg', soldByWeight: true })];
  const store = (id) => ({ id, label: id, search: { maxLimit: 20, run: async ({ query }) => named(catalog[id][query], query) } });
  const out = await compareBasket([store('shufersal'), store('rami-levy')], { items: [{ query: 'עגבניות', quantity: 1.5 }, { query: 'בננה', quantity: 1.5 }] }, { cache: new SearchCache() });
  const [tomatoes, bananas] = out.items;
  assert.deepEqual([tomatoes.offers.shufersal.excluded, tomatoes.offers['rami-levy'].excluded, tomatoes.cheapestStore], ['INCOMPATIBLE_QUANTITY_BASIS', 'INCOMPATIBLE_QUANTITY_BASIS', null]);
  assert.deepEqual([bananas.offers.shufersal.lineTotal, bananas.offers['rami-levy'].lineTotal], [11.85, 10.35]);
  assert.deepEqual(out.totals.shufersal, { total: 11.85, itemsFound: 1, missing: [], notComparable: ['עגבניות'] });
  assert.deepEqual([out.comparable.items, out.split.total], [1, 10.35]);
});

test('Shufersal egg packs keep their count and a price per egg (review G-06)', () => {
  const [eggs] = normalizeShufersalRaw([{ code: 'P_1201589', name: 'ביצים טריות L', unitDescription: '12 יחידות', sellingMethod: { code: 'BY_UNIT' }, price: { value: 14.54 } }]);
  assert.deepEqual([eggs.size, eggs.count, eggs.pricePerUnit, eggs.perUnit], ['12 pcs', 12, 1.21, 'pc']);
});

test('compareBasket prices a past order: barcode first, name as fallback, grams as kilograms (review 5.2)', async () => {
  const order = {
    order: { code: '05782658', created: '2026-11-23 16:06', total: 749.17 },
    items: [
      { code: 'P_4131074', name: 'חלב בקרטון 3% שומן', quantity: 2, sellingMethod: 'BY_UNIT', unit: 'unit' },
      { code: 'P_939995', name: 'פילה סלמון קפוא', quantity: 1150, sellingMethod: 'BY_PACKAGE', unit: 'g' },
      { code: 'P_7290000000001', name: 'מוצר ייחודי', quantity: 1, sellingMethod: 'BY_UNIT', unit: 'unit' },
      { code: 'P_7296073453673', name: 'גבינה מגורדת', quantity: 250, sellingMethod: 'BY_PACKAGE', unit: 'g' },
    ],
  };
  const catalog = {
    shufersal: {
      '7290004131074': [p('shufersal', 'P_4131074', '7290004131074', 7.35)],
      'פילה סלמון קפוא': [p('shufersal', 'P_939995', null, 69.9, { priceBasis: 'kg', soldByWeight: true })],
      '7290000000001': [p('shufersal', 'P_7290000000001', '7290000000001', 12)],
      '7296073453673': [p('shufersal', 'P_7296073453673', '7296073453673', 19.75, { priceBasis: 'package', priceEstimated: true, soldByWeight: true })],
    },
    'rami-levy': {
      '7290004131074': [p('rami-levy', '3025', '7290004131074', 7.2)],
      'פילה סלמון קפוא': [p('rami-levy', '417111', null, 81.4, { priceBasis: 'kg', soldByWeight: true })],
      'מוצר ייחודי': [p('rami-levy', '900', null, 10)],
      'גבינה מגורדת': [p('rami-levy', '901', null, 39, { priceBasis: 'kg', soldByWeight: true })],
    },
  };
  const calls = [];
  const store = (id) => ({
    id, label: id,
    search: { maxLimit: 20, run: async ({ query }) => named(catalog[id][query], query) },
    callTool: async (tool, args) => { calls.push([id, tool, args]); return { content: [{ type: 'text', text: JSON.stringify(order) }] }; },
  });
  const out = await compareBasket([store('shufersal'), store('rami-levy')], { source: { store: 'shufersal' } }, { cache: new SearchCache() });
  assert.deepEqual(calls, [['shufersal', 'get_order', { order: 'latest' }]]);
  assert.deepEqual(out.source, { store: 'shufersal', order: '05782658', created: '2026-11-23 16:06', paid: 749.17 });
  const [milk, salmon, unique, cheese] = out.items;
  assert.deepEqual([cheese.quantity, cheese.packs, cheese.offers.shufersal.lineTotal, cheese.offers['rami-levy'].lineTotal], [0.25, 1, 19.75, 9.75], 'one pack, or its weight where sold by kg');
  assert.deepEqual([milk.identical, milk.offers.shufersal.lineTotal, milk.offers['rami-levy'].lineTotal], [true, 14.7, 14.4]);
  assert.deepEqual([salmon.quantity, salmon.offers.shufersal.lineTotal, salmon.offers['rami-levy'].lineTotal], [1.15, 80.39, 93.61]);
  assert.deepEqual([unique.offers['rami-levy'].productId, unique.offers['rami-levy'].matchedBy, unique.identical], ['900', 'name', false]);
  assert.equal(unique.sourceLine.code, 'P_7290000000001');
  assert.ok(out.notes.some((n) => /Prices are today's/.test(n)) && out.notes.some((n) => /matchedBy: name/.test(n)));
  await assert.rejects(compareBasket([store('shufersal')], {}, { cache: new SearchCache() }), /non-empty list/);
  await assert.rejects(compareBasket([store('shufersal')], { source: { store: 'rami-levy' } }, { cache: new SearchCache() }), (e) => e.code === 'STORE_UNAVAILABLE');
});

test('comparable leaves out different sizes and counts; kg quantities prefer per-kg products (review GROC-051-01/02)', async () => {
  const catalog = {
    shufersal: {
      'ביצים': [p('shufersal', 'E18', null, 21.81, { name: 'ביצים ארוזות L', count: 18 })],
      'חלב': [p('shufersal', 'M1', '111', 7.35, { size: '1 L' })],
      'בננות': [p('shufersal', 'drink', '777', 12.5, { name: 'משקה בננה' }), p('shufersal', 'B', null, 11.9, { name: 'בננה', priceBasis: 'kg', soldByWeight: true })],
    },
    'rami-levy': {
      'ביצים': [p('rami-levy', 'E12', null, 14.5, { name: 'ביצים 12 יח L', count: 12 })],
      'חלב': [p('rami-levy', 'M2', '111', 7.2, { size: '1 L' })],
      'בננות': [p('rami-levy', 'drink', '777', 9.9, { name: 'משקה חלב בננה' }), p('rami-levy', 'B', null, 8.9, { name: 'בננה', priceBasis: 'kg', soldByWeight: true })],
    },
  };
  const store = (id) => ({ id, label: id, search: { maxLimit: 20, run: async ({ query }) => named(catalog[id][query], query) } });
  const out = await compareBasket([store('shufersal'), store('rami-levy')], { items: [{ query: 'ביצים' }, { query: 'חלב' }, { query: 'בננות', quantity: 1.5 }] }, { cache: new SearchCache() });
  const [eggs, milk, bananas] = out.items;
  assert.equal(eggs.notEquivalent, '18 vs 12 units');
  assert.equal(milk.notEquivalent, undefined);
  assert.deepEqual([bananas.offers.shufersal.productId, bananas.offers['rami-levy'].productId, bananas.identical], ['B', 'B', false], 'fresh bananas per kg, not the shared-barcode drink');
  assert.deepEqual(out.comparable, { items: 2, identicalItems: 1, leftOut: [{ query: 'ביצים', reason: '18 vs 12 units' }], shufersal: 25.2, 'rami-levy': 20.55, cheaperStore: 'rami-levy', difference: 4.65 });
  assert.deepEqual([out.totals.shufersal.total, out.totals['rami-levy'].total], [47.01, 35.05], 'store totals still include every item');
});

