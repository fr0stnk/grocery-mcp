import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compareBasket } from '../src/basket.js';
import { SearchCache } from '../src/cache.js';
import { bestCandidates, queryTerms } from '../src/match.js';
import { relevantOnly } from '../src/search.js';

// Live search results from both stores on 2026-11-25, as search_all_stores returned them (limit 20).
const catalog = JSON.parse(readFileSync(new URL('./fixtures/catalog-2026-11-25.json', import.meta.url), 'utf8'));
const store = (id) => ({ id, label: id, search: { maxLimit: 20, run: async ({ query }) => catalog[query]?.[id] ?? [] } });
const compare = (items) => compareBasket([store('shufersal'), store('rami-levy')], { items }, { cache: new SearchCache() });
const one = async (query, quantity = 1) => (await compare([{ query, quantity }])).items[0];
const names = (line) => [line.offers.shufersal?.name ?? null, line.offers['rami-levy']?.name ?? null];

test('sizes and units are not product words, and words match from their start', () => {
  assert.deepEqual(queryTerms('מים 1.5 ליטר').map((t) => t.word), ['מים']);
  assert.deepEqual(queryTerms('חמאה 200 גרם').map((t) => t.word), ['חמאה']);
  const kitchen = [{ name: "צ'ופר זכוכית 1.5 ליטר רמ" }, { name: 'קומקום 1.7 ליטר לבן' }, { name: 'מים מינרליים נביעות' }];
  assert.deepEqual(relevantOnly(kitchen, 'מים 1.5 ליטר').kept.map((x) => x.name), ['מים מינרליים נביעות'], 'GROC-002: glassware is not water');
  assert.equal(relevantOnly([{ name: 'קפה חמים' }], 'מים').kept.length, 0, 'a word inside another word is not a match');
});

test('GROC-001: a product named after the query word in third place is not that product', async () => {
  const banana = await one('בננה', 1.5);
  assert.equal(banana.offers.shufersal.excluded, 'INCOMPATIBLE_QUANTITY_BASIS', 'the banana bunch is sold per package, so 1.5 kg cannot be priced');
  assert.match(banana.offers.shufersal.name, /בננה/);
  assert.doesNotMatch(banana.offers.shufersal.name, /עגל/, 'veal "banana" cut');
  assert.equal(banana.offers['rami-levy'].name, 'בננה');
  assert.deepEqual(bestCandidates([{ name: 'שריר עגל בננה קפוא' }], 'בננה'), []);
});

test('GROC-002: water never resolves to glassware, and a six-pack is marked as unrequested', async () => {
  const water = await one('מים 1.5 ליטר');
  assert.equal(water.offers.shufersal, null);
  assert.deepEqual(water.offers['rami-levy'].unrequested, ['שישייה']);
  assert.equal(water.cheapestStore, null);
  assert.match(water.notEquivalent, /not asked for/);
});

test('GROC-003: a stated percentage is a hard constraint', async () => {
  const impossible = await one('חלב 99% 1 ליטר');
  assert.deepEqual(names(impossible), [null, null]);
  const lowFat = await one('חלב תנובה 1% 1 ליטר');
  for (const name of names(lowFat)) assert.match(name, /(^|\s)1%/);
});

test('GROC-004: unrequested variants lose to the plain product, even with a shared barcode', async () => {
  const zero = await one('קוקה קולה זירו 1.5 ליטר');
  for (const name of names(zero)) assert.doesNotMatch(name, /לימון/);
  const regular = await one('קוקה קולה 1.5 ליטר');
  assert.doesNotMatch(regular.offers.shufersal.name, /דיאט|זירו/);
  // Rami Levy sells no plain 1.5 L Coca-Cola in these results: its closest product is flagged and left out of every comparison.
  assert.deepEqual(regular.offers['rami-levy'].unrequested, ['דיאט']);
  assert.equal(regular.cheapestStore, null);
});

test('GROC-005: lines that are not like for like have no cheapest store and stay out of the split', async () => {
  const out = await compare(['בננות', 'תפוח עץ', 'מלפפון', 'עגבניות', 'לחם ללא גלוטן', 'חלב 3% 1 ליטר'].map((query) => ({ query, quantity: 1 })));
  const [bananas, apples, cucumber, tomatoes, bread, milk] = out.items;
  for (const line of [bananas, apples, cucumber, tomatoes, bread]) {
    assert.ok(line.notEquivalent, line.query);
    assert.equal(line.cheapestStore, null, line.query);
  }
  assert.match(tomatoes.notEquivalent, /package vs unit|not asked for/, 'an estimated package and a unit price are different amounts');
  assert.deepEqual(out.split.leftOut, ['בננות', 'תפוח עץ', 'מלפפון', 'עגבניות', 'לחם ללא גלוטן']);
  assert.equal(out.split.total, Math.min(milk.offers.shufersal.lineTotal, milk.offers['rami-levy'].lineTotal));
  assert.equal(out.comparable.items, 1);
});

test('GROC-006: ordinary eggs, fresh chicken and plain rice are preferred to premium, frozen and wholegrain', async () => {
  for (const name of names(await one('ביצים רגילות L 12'))) assert.doesNotMatch(name, /אומגה/);
  for (const name of names(await one('ביצים L 12'))) assert.doesNotMatch(name, /אומגה/);
  for (const name of names(await one('חזה עוף'))) assert.doesNotMatch(name, /קפוא/);
  for (const name of names(await one('אורז בסמטי 1 קילו'))) assert.doesNotMatch(name, /מלא/);
  const soy = await one('חלב סויה ללא סוכר');
  for (const name of names(soy)) assert.match(name, /סויה/, 'not milk chocolate');
});

test('identical products still match by barcode', async () => {
  for (const query of ['חלב 3% 1 ליטר', 'חמאה 200 גרם', 'חלב ללא לקטוז']) assert.equal((await one(query)).identical, true, query);
});
