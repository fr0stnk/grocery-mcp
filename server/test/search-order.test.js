import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchCache } from '../src/cache.js';
import { searchAllStores } from '../src/search.js';

const store = (id, items) => ({ id, label: id, search: { maxLimit: 20, run: async () => items } });
const item = (store, name, price, pricePerUnit) => ({ store, productId: name, barcode: null, name, price, pricePerUnit });
const stores = () => [
  store('shufersal', [item('shufersal', 'S-best-match', 14, 7), item('shufersal', 'S-second', 2, 1)]),
  store('rami-levy', [item('rami-levy', 'R-best-match', 15, 7.5), item('rami-levy', 'R-second', 1, 0.5)]),
];
const names = (out) => out.results.map((r) => r.name);

test('results keep each store\'s relevance order by default, interleaved by rank', async () => {
  const out = await searchAllStores(stores(), { query: 'חלב' }, { cache: new SearchCache() });
  assert.equal(out.sortBy, 'relevance');
  assert.deepEqual(names(out), ['S-best-match', 'R-best-match', 'S-second', 'R-second']);
  assert.deepEqual(out.results.map((r) => r.rank), [1, 1, 2, 2]);
  assert.equal(out.hint, undefined);
});

test('sortBy unitPrice and price put the cheapest first', async () => {
  assert.deepEqual(names(await searchAllStores(stores(), { query: 'חלב', sortBy: 'unitPrice' }, { cache: new SearchCache() })), ['R-second', 'S-second', 'S-best-match', 'R-best-match']);
  assert.deepEqual(names(await searchAllStores(stores(), { query: 'חלב', sortBy: 'price' }, { cache: new SearchCache() })), ['R-second', 'S-second', 'S-best-match', 'R-best-match']);
  assert.equal((await searchAllStores(stores(), { query: 'חלב', sortBy: 'nonsense' }, { cache: new SearchCache() })).sortBy, 'relevance');
});

test('queries without Hebrew letters get a translation hint, barcodes do not', async () => {
  assert.match((await searchAllStores(stores(), { query: 'молоко без лактозы' }, { cache: new SearchCache() })).hint, /translate it to Hebrew/);
  assert.match((await searchAllStores(stores(), { query: 'lactose free milk' }, { cache: new SearchCache() })).hint, /translate/);
  assert.equal((await searchAllStores(stores(), { query: '7290102398065' }, { cache: new SearchCache() })).hint, undefined);
});

test('results sharing no word with the query are hidden and counted, unless nothing matches', async () => {
  const { relevantOnly } = await import('../src/search.js');
  const items = ['פילה סלמון קפוא', 'לשון בקר', 'שניצל עוף', 'הסלמון של הים'].map((name) => ({ name, brand: null }));
  const { kept, hidden } = relevantOnly(items, 'פילה סלמון קפוא');
  assert.deepEqual([kept.map((i) => i.name), hidden], [['פילה סלמון קפוא', 'הסלמון של הים'], 2]);
  assert.deepEqual(relevantOnly(items, 'קוויאר'), { kept: items, hidden: 0 }, 'no match at all keeps everything');
  assert.deepEqual(relevantOnly(items, '7290003996018').hidden, 0, 'number queries are not filtered');
  assert.equal(relevantOnly([{ name: 'MILKA שוקולד', brand: null }], 'milka').hidden, 0, 'case-insensitive');
  const bars = [{ name: 'חטיף FREE שוקולד', brand: 'FREE' }, { name: 'חטיף FREE בוטנים', brand: 'FREE' }];
  assert.deepEqual(relevantOnly(bars, 'lactose free milk'), { kept: [], hidden: 2 }, 'an untranslated query must match every word');
  assert.equal(relevantOnly(bars, 'free').kept.length, 2, 'a brand alone still finds its products');
  const twelve = [{ name: 'ביצים 12 יח L' }, { name: 'מלפפונים 10-12' }, { name: 'סודה 12 * 500 מל' }];
  assert.deepEqual(relevantOnly(twelve, 'ביצים 12').kept.map((i) => i.name), ['ביצים 12 יח L'], 'a shared number is not a match (G-05)');
});

