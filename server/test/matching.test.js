import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compareBasket, constraintsOf, fitOf, packsFor, pickMatches, statedIn } from '../src/basket.js';
import { normalizeRamiCatalog, normalizeShufersalRaw } from '../src/normalize.js';
import { SearchCache } from '../src/cache.js';
import { bestCandidates, queryTerms, withoutPackaging } from '../src/match.js';
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

test('GROC-003: a percentage another product contradicts excludes it; unknown only counts where no product states one', () => {
  const threePct = constraintsOf('חלב 3%');
  const labelled = [{ name: 'חלב 1% בקרטון', price: 6.9 }, { name: 'חלב טרי בקרטון', price: 7 }];
  assert.equal(fitOf(labelled[0], threePct), '1%, not 3%', 'a contradiction always excludes');
  assert.deepEqual(statedIn(labelled, threePct), ['percent']);
  assert.match(fitOf(labelled[1], threePct, { strict: statedIn(labelled, threePct) }), /no percentage stated/, 'the store labels fat, so an unlabelled milk is not taken on trust');
  const unlabelled = [{ name: 'חלב טרי בקרטון', price: 7 }, { name: 'חלב בבקבוק', price: 8 }];
  assert.deepEqual(statedIn(unlabelled, threePct), []);
  const pick = pickMatches({ shufersal: unlabelled }, { constraints: threePct, query: 'חלב 3%' }).matches.shufersal;
  assert.deepEqual([pick.name, pick.fit], ['חלב טרי בקרטון', 'unverified'], 'a store that states no percentages keeps its milks, unverified');
});

test('GROC-003: a percentage no product has is missing', async () => {
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

// Raw rows as Shufersal's search and Rami Levy's catalog returned them on 2026-11-25.
const shufersalRaw = (extra) => ({ stock: { stockLevelStatus: { code: 'inStock' } }, promotionMsg: null, ...extra });
const NEVIOT_S = shufersalRaw({ code: 'P_7290110114855', sku: '7290110114855', name: 'מים מינרליים נביעות', brandName: 'נביעות', unitDescription: '6*1.5 ליטר', sellingMethod: { code: 'BY_UNIT' }, price: { value: 16.5 }, pricePerUnit: { value: 0.18 }, valueForComparison: 100, unitForComparison: 'מ"ל' });
const NEVIOT_R = { id: 386532, barcode: '7290110114855', name: 'מים מינרליים נביעות שישייה 1.5 ליטר', price: { price: 16.5 }, prop: { by_kilo: 0 } };
const TOMATO_S = shufersalRaw({ code: 'P_7296073440314', sku: '7296073440314', name: 'עגבניה טרייה ארוזה', unitDescription: 'כ- 8 יחידות', sellingMethod: { code: 'BY_PACKAGE' }, price: { value: 8.9 }, minWeight: 900, maxWeight: 1100, pricePerUnit: { value: 8.9 }, valueForComparison: 1, unitForComparison: 'ק"ג' });
const NO_WEIGHT_S = shufersalRaw({ code: 'P_7296073440345', sku: '7296073440345', name: 'עגבניה ארוזה קטנה', unitDescription: 'כ-4 יחידות', sellingMethod: { code: 'BY_PACKAGE' }, price: { value: 8.9 }, pricePerUnit: { value: 8.9 }, valueForComparison: 1, unitForComparison: 'ק"ג' });
const TOMATO_R = { id: 2, barcode: null, name: 'עגבניה', price: { price: 8.9 }, prop: { by_kilo: 1 } };
const rawStores = (shufersal, rami) => [
  { id: 'shufersal', label: 'Shufersal', search: { maxLimit: 20, run: async () => normalizeShufersalRaw(shufersal) } },
  { id: 'rami-levy', label: 'Rami Levy', search: { maxLimit: 20, run: async () => normalizeRamiCatalog({ data: rami }) } },
];
const compareRaw = (stores, items) => compareBasket(stores, { items }, { cache: new SearchCache() });

test('GROC-010: a six-pack has the same total and pack size whichever store describes it', async () => {
  const [s] = normalizeShufersalRaw([NEVIOT_S]);
  const [r] = normalizeRamiCatalog({ data: [NEVIOT_R] });
  for (const x of [s, r]) assert.deepEqual([x.size, x.packCount, x.itemSize], ['9 L', 6, '1.5 L'], x.store);
  const [line] = (await compareRaw(rawStores([NEVIOT_S], [NEVIOT_R]), [{ query: 'מים מינרליים 1.5 ליטר', quantity: 1 }])).items;
  assert.equal(line.identical, true, 'the same barcode in both stores');
  assert.deepEqual(line.unrequested, ['6×1.5 L']);
  assert.equal(line.cheapestStore, null, 'same price');
  assert.ok(!line.notEquivalent, 'the same six-pack is compared exactly');
});

test('GROC-010: a single bottle beats a six-pack where a store has one, and the pair is not like for like', async () => {
  const bottle = shufersalRaw({ code: 'P_1', name: 'מים מינרליים נביעות', unitDescription: '1.5 ליטר', sellingMethod: { code: 'BY_UNIT' }, price: { value: 3.9 } });
  const [line] = (await compareRaw(rawStores([NEVIOT_S, bottle], [NEVIOT_R]), [{ query: 'מים מינרליים 1.5 ליטר', quantity: 1 }])).items;
  assert.equal(line.offers.shufersal.productId, 'P_1');
  assert.equal(line.identical, false);
  assert.match(line.notEquivalent, /not asked for|9 L vs 1.5 L|1.5 L vs 9 L/);
});

test('GROC-009: Shufersal packaged produce is priced per kg and bought in whole packs', async () => {
  const [tomato, plain] = normalizeShufersalRaw([TOMATO_S, NO_WEIGHT_S]);
  assert.deepEqual([tomato.priceBasis, tomato.pricePerUnit, tomato.perUnit, tomato.packWeightKg, tomato.packPrice, tomato.priceEstimated], ['kg', 8.9, 'kg', 1, 8.9, true]);
  assert.equal(plain.priceBasis, 'package', 'a pack without a weight range keeps the estimated package price');
  const stores = rawStores([TOMATO_S], [TOMATO_R]);
  const [oneKg] = (await compareRaw(stores, [{ query: 'עגבניה', quantity: 1 }])).items;
  assert.deepEqual([oneKg.offers.shufersal.packs, oneKg.offers.shufersal.lineTotal, oneKg.offers['rami-levy'].lineTotal], [1, 8.9, 8.9]);
  assert.ok(!oneKg.notEquivalent, 'kg against kg');
  const out = await compareRaw(stores, [{ query: 'עגבניה', quantity: 2.5 }]);
  const [twoHalf] = out.items;
  assert.deepEqual([packsFor(2.5, 1), twoHalf.offers.shufersal.packs, twoHalf.offers.shufersal.lineTotal], [3, 3, 26.7], '2.5 packs round half up to 3');
  assert.equal(twoHalf.offers['rami-levy'].lineTotal, 22.25);
  assert.equal(out.comparable.items, 1);
  assert.deepEqual([packsFor(0.2, 1), packsFor(1.4, 1)], [1, 1]);
});

test('GROC-007: a plural query falls back to the singular where the plural finds only variants', async () => {
  const lists = {
    'rami-levy': {
      'עגבניות': [{ store: 'rami-levy', productId: '453030', name: 'עגבניות שרי לובלו רמי לוי', price: 10.7, priceBasis: 'unit' }],
      'עגבניה': [{ store: 'rami-levy', productId: '2', name: 'עגבניה', price: 8.9, priceBasis: 'kg', soldByWeight: true }],
    },
  };
  const searched = [];
  const rami = { id: 'rami-levy', label: 'Rami Levy', search: { maxLimit: 20, run: async ({ query }) => { searched.push(query); return lists['rami-levy'][query] ?? []; } } };
  const [line] = (await compareBasket([rami], { items: [{ query: 'עגבניות', quantity: 1 }] }, { cache: new SearchCache() })).items;
  assert.deepEqual([line.offers['rami-levy'].productId, line.offers['rami-levy'].unrequested], ['2', undefined]);
  assert.ok(searched.includes('עגבניה'));
  searched.length = 0;
  await compareBasket([rami], { items: [{ query: 'עגבניה', quantity: 1 }] }, { cache: new SearchCache() });
  assert.deepEqual(searched, ['עגבניה'], 'a singular query with a plain match searches once');
});

test('GROC-015: packaging words are not product words, and a store is retried without them', async () => {
  assert.deepEqual(queryTerms('בצל אדום ארוז').map((t) => t.word), ['בצל', 'אדום']);
  assert.equal(withoutPackaging('מארז תפוחים סמיט'), 'תפוחים סמיט');
  assert.equal(withoutPackaging('חלב 3%'), null);
  const rami = (id, name, price, extra = {}) => ({ store: 'rami-levy', productId: id, name, price, priceBasis: 'unit', ...extra });
  const catalog = {
    'בצל אדום ארוז': [rami('300330', 'טבעות בצל קפואות', 14.9), rami('500', 'עוף טרי ארוז', 30)],
    'בצל אדום': [rami('78', 'בצל אדום', 6.9, { priceBasis: 'kg' })],
    'מארז תפוחים סמיט': [rami('423294', 'מארז 3יח מיץ תפוחים', 12), rami('9', 'מארז פיתות', 8), rami('18', 'תפוח עץ ירוק גרנד סמיט', 12.9, { priceBasis: 'kg' })],
    'מארז ענבים': [rami('471702', 'מארז פיתות', 8), rami('7', 'מארז עלי חסה ערבית', 9.9)],
    'ענבים': [],
  };
  const store = { id: 'rami-levy', label: 'Rami Levy', search: { maxLimit: 20, run: async ({ query }) => catalog[query] ?? [] } };
  const out = await compareBasket([store], { items: ['בצל אדום ארוז', 'מארז תפוחים סמיט', 'מארז ענבים'].map((query) => ({ query, quantity: 1 })) }, { cache: new SearchCache() });
  const [onion, apples, grapes] = out.items.map((l) => l.offers['rami-levy']?.productId ?? null);
  assert.deepEqual([onion, apples, grapes], ['78', '18', null], 'red onion, Smith apples, and no lettuce or pitas for grapes');
});
