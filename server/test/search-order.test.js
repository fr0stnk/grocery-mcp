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
