import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchCache } from '../src/cache.js';
import { searchAllStores } from '../src/search.js';

const store = (id, items) => ({ id, label: id, search: { maxLimit: 20, run: async () => items } });
const item = (store, name, price, pricePerUnit) => ({ store, productId: name, barcode: null, name, price, pricePerUnit });
const stores = () => [
  store('shufersal', [item('shufersal', 'חלב S-best-match', 14, 7), item('shufersal', 'חלב S-second', 2, 1)]),
  store('rami-levy', [item('rami-levy', 'חלב R-best-match', 15, 7.5), item('rami-levy', 'חלב R-second', 1, 0.5)]),
];
const names = (out) => out.results.map((r) => r.name);

test('results keep each store\'s relevance order by default, interleaved by rank', async () => {
  const out = await searchAllStores(stores(), { query: 'חלב' }, { cache: new SearchCache() });
  assert.equal(out.sortBy, 'relevance');
  assert.deepEqual(names(out), ['חלב S-best-match', 'חלב R-best-match', 'חלב S-second', 'חלב R-second']);
  assert.deepEqual(out.results.map((r) => r.rank), [1, 1, 2, 2]);
  assert.equal(out.hint, undefined);
});

test('sortBy unitPrice and price put the cheapest first', async () => {
  assert.deepEqual(names(await searchAllStores(stores(), { query: 'חלב', sortBy: 'unitPrice' }, { cache: new SearchCache() })), ['חלב R-second', 'חלב S-second', 'חלב S-best-match', 'חלב R-best-match']);
  assert.deepEqual(names(await searchAllStores(stores(), { query: 'חלב', sortBy: 'price' }, { cache: new SearchCache() })), ['חלב R-second', 'חלב S-second', 'חלב S-best-match', 'חלב R-best-match']);
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
  assert.deepEqual([kept.map((i) => i.name), hidden], [['פילה סלמון קפוא'], 3], 'a specific query keeps products with half its naming words');
  assert.deepEqual(relevantOnly(items.slice(1), 'פילה סלמון קפוא').kept.map((i) => i.name), ['הסלמון של הים'], 'with no such product, one naming word is enough');
  assert.deepEqual(relevantOnly(items, 'קוויאר'), { kept: [], hidden: 4 }, 'no match at all keeps nothing');
  assert.deepEqual(relevantOnly(items, '7290003996018').hidden, 0, 'number queries are not filtered');
  assert.equal(relevantOnly([{ name: 'MILKA שוקולד', brand: null }], 'milka').hidden, 0, 'case-insensitive');
  const bars = [{ name: 'חטיף FREE שוקולד', brand: 'FREE' }, { name: 'חטיף FREE בוטנים', brand: 'FREE' }];
  assert.deepEqual(relevantOnly(bars, 'lactose free milk'), { kept: [], hidden: 2 }, 'an untranslated query must match every word');
  assert.equal(relevantOnly(bars, 'free').kept.length, 2, 'a brand alone still finds its products');
  const twelve = [{ name: 'ביצים 12 יח L' }, { name: 'מלפפונים 10-12' }, { name: 'סודה 12 * 500 מל' }];
  assert.deepEqual(relevantOnly(twelve, 'ביצים 12').kept.map((i) => i.name), ['ביצים 12 יח L'], 'a shared number is not a match (G-05)');
});

test('Hebrew plurals match by stem and are retried in the singular when nothing fits (review BUG-001/003)', async () => {
  const { relevantOnly, relevantSearch, singularQueries } = await import('../src/search.js');
  assert.deepEqual(singularQueries('בננות'), ['בננה', 'בננ']);
  assert.deepEqual(singularQueries('תפוחים ירוקים'), ['תפוח ירוקים', 'תפוחה ירוקים']);
  assert.deepEqual(singularQueries('חלב'), []);
  const girls = [{ name: 'קרליין דיאודורנט בנות' }, { name: 'שלישיית גרבי בנות' }];
  assert.deepEqual(relevantOnly(girls, 'בננות'), { kept: [], hidden: 2 }, '"בנות" is not "בננות"');
  assert.equal(relevantOnly([{ name: 'בננה' }], 'בננות').kept.length, 1, 'the stem matches the singular');
  const catalog = { 'בננות': girls, 'בננה': [{ name: 'בננה', store: 'rami-levy', productId: '35', price: 8.9 }] };
  const store = { id: 'rami-levy', label: 'Rami Levy', search: { maxLimit: 20, run: async ({ query }) => catalog[query] ?? [] } };
  const out = await relevantSearch(store, 'בננות', { cache: new SearchCache() });
  assert.deepEqual([out.items.map((i) => i.name), out.hidden, out.retriedAs], [['בננה'], 2, 'בננה']);
  const none = await relevantSearch(store, 'קוויאר', { cache: new SearchCache() });
  assert.deepEqual([none.items, none.retriedAs], [[], undefined]);
});

test('sortBy unitPrice keeps kg, litre and piece prices in separate groups (review GROC-051-06)', async () => {
  const mixed = [
    store('shufersal', [{ store: 'shufersal', productId: 'a', name: 'בננה', price: 11.9, pricePerUnit: 11.9, perUnit: 'kg' }, { store: 'shufersal', productId: 'b', name: 'משקה בננה', price: 9.9, pricePerUnit: 9.9, perUnit: 'L' }]),
    store('rami-levy', [{ store: 'rami-levy', productId: 'c', name: 'בננה', price: 8.9, pricePerUnit: 8.9, perUnit: 'kg' }, { store: 'rami-levy', productId: 'd', name: 'בננה צ\'יפס', price: 7, pricePerUnit: null, perUnit: null }]),
  ];
  const out = await searchAllStores(mixed, { query: 'בננה', sortBy: 'unitPrice' }, { cache: new SearchCache() });
  assert.deepEqual(out.results.map((r) => `${r.pricePerUnit}/${r.perUnit}`), ['8.9/kg', '11.9/kg', '9.9/L', 'null/null']);
});

test('emoji and exclamation marks are dropped from a query (GROC-043)', async () => {
  const { cleanQuery } = await import('../src/match.js');
  assert.equal(cleanQuery('🥛 חלב!!!'), 'חלב');
  assert.equal(cleanQuery('חלב 3% 1 ליטר'), 'חלב 3% 1 ליטר');
  assert.equal(cleanQuery("קוטג' 5%"), "קוטג' 5%");
  const seen = [];
  const one = [{ id: 'shufersal', label: 'shufersal', search: { maxLimit: 20, run: async ({ query }) => { seen.push(query); return [item('shufersal', 'חלב 3%', 7, 7)]; } } }];
  const out = await searchAllStores(one, { query: '🥛 חלב!!!' }, { cache: new SearchCache() });
  assert.deepEqual([seen[0], out.results.length], ['חלב', 1]);
  const { relevantOnly } = await import('../src/search.js');
  assert.equal(relevantOnly([{ name: 'חלב 3%' }], 'חלב!!!').kept.length, 1, 'punctuation glued to a word does not hide matches');
});

