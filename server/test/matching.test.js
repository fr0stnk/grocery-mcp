import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compareBasket, constraintsOf, fitOf, packsFor, pickMatches, statedIn } from '../src/basket.js';
import { normalizeRamiCatalog, normalizeShufersalRaw, parseCount, parseSize } from '../src/normalize.js';
import { SearchCache } from '../src/cache.js';
import { bestCandidates, queryTerms, withoutPackaging } from '../src/match.js';
import { relevantOnly, searchAllStores } from '../src/search.js';

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
  // GROC-041: 3 kg against 2.5 kg at the same ₪8.9/kg is not a cheaper store, only more tomatoes.
  assert.deepEqual([out.comparable.items, twoHalf.notEquivalent, twoHalf.cheapestStore], [0, '3 kg vs 2.5 kg', null]);
  assert.deepEqual([twoHalf.unitPriceComparison.amount, twoHalf.unitPriceComparison.cheaperStore], [2.5, null]);
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
    'תפוחים סמיט': [rami('423294', 'מארז 3יח מיץ תפוחים', 12), rami('18', 'תפוח עץ ירוק גרנד סמיט', 12.9, { priceBasis: 'kg' })],
    'ענבים': [rami('433785', 'מיץ ענבים אדום', 12.9), rami('65', 'ענבים ירוקים', 17.9, { priceBasis: 'kg' })],
  };
  const sent = [];
  const store = { id: 'rami-levy', label: 'Rami Levy', search: { maxLimit: 20, run: async ({ query }) => { sent.push(query); return catalog[query] ?? []; } } };
  const out = await compareBasket([store], { items: ['בצל אדום ארוז', 'מארז תפוחים סמיט', 'מארז ענבים'].map((query) => ({ query, quantity: 1 })) }, { cache: new SearchCache() });
  const [onion, apples, grapes] = out.items.map((l) => l.offers['rami-levy']?.productId ?? null);
  assert.deepEqual([onion, apples, grapes], ['78', '18', '65'], 'red onion, Smith apples, green grapes: no rings, juice, lettuce or pitas');
  assert.ok(sent.every((q) => !/מארז|ארוז/.test(q)), 'Rami Levy is searched without packaging words');
  const search = await searchAllStores([store], { query: 'בצל אדום ארוז' }, { cache: new SearchCache() });
  assert.deepEqual([search.results[0].productId, search.stores['rami-levy'].retriedAs], ['78', 'בצל אדום']);
});

test('GROC-016: compare_basket says to translate a query with no Hebrew letters', async () => {
  const out = await compare([{ query: 'lactose free milk', quantity: 1 }, { query: 'חלב 3% 1 ליטר', quantity: 1 }]);
  assert.ok(out.notes.some((n) => /no Hebrew letters: lactose free milk\. .*Translate/.test(n)));
  assert.ok(!(await compare([{ query: 'חלב 3% 1 ליטר', quantity: 1 }])).notes.some((n) => /Translate/.test(n)));
});

test('GROC-042: an untranslated query is not priced into any total', async () => {
  const store = (id, items) => ({ id, label: id, search: { maxLimit: 20, run: async () => items } });
  const magenta = { store: 'shufersal', productId: 'P_1', barcode: null, name: 'MAGENTA MILK', price: 2499, priceBasis: 'unit' };
  const out = await compareBasket([store('shufersal', [magenta]), store('rami-levy', [])], { items: [{ query: 'milk', quantity: 1 }] }, { cache: new SearchCache() });
  assert.equal(out.items[0].offers.shufersal.excluded, 'UNTRANSLATED_QUERY');
  assert.deepEqual([out.totals.shufersal.total, out.totals.shufersal.notComparable], [0, ['milk']]);
  assert.ok(!out.notes.some((n) => /fractional/i.test(n)));
});

test('GROC-040: a stated count keeps out products that state none (egg salad, egg noodles)', async () => {
  const store = (id, items) => ({ id, label: id, search: { maxLimit: 20, run: async () => items.map((x, i) => ({ store: id, productId: `${id}${i}`, barcode: null, priceBasis: 'unit', ...x })) } });
  const shufersal = [{ name: 'ביצים ארוזות L 18', count: 18, price: 21.81 }, { name: 'ביצי משק טריות L 12', count: 12, price: 14.54 }, { name: 'סלט ביצים', size: '0.25 kg', price: 22.9 }, { name: 'תבנית ביצים למקרר', price: 21.9 }];
  const rami = [{ name: 'ביצים 30יח בינוני M', count: 30, price: 33.4 }, { name: 'ביצים 12 יח גדול L', count: 12, price: 14.5 }, { name: "אטריות ביצים 300 ג'", size: '0.3 kg', price: 7.8 },
    { name: 'סלט ביצים 200גר', size: '0.2 kg', price: 19.2 }, { name: 'פתיתי ביצים', price: 9.9 }, { name: 'אטריות ביצים דקות 400 גר', size: '0.4 kg', price: 7.4 }];
  const out = await compareBasket([store('shufersal', shufersal), store('rami-levy', rami)], { items: [{ query: 'ביצים 30' }, { query: 'ביצים L 30 יחידות' }] }, { cache: new SearchCache() });
  const [thirty, large] = out.items;
  assert.deepEqual([thirty.offers.shufersal, thirty.offers['rami-levy']?.name], [null, 'ביצים 30יח בינוני M'], 'the 30-pack, not a cheaper noodle pack taking it for an outlier');
  assert.deepEqual([large.offers.shufersal, large.offers['rami-levy']], [null, null], 'no 30 L eggs: missing, not egg salad');
  assert.deepEqual(thirty.nearest, { shufersal: { productId: 'shufersal0', name: 'ביצים ארוזות L 18', count: 18, price: 21.81, pricePerUnit: 1.21, perUnit: 'pc', wanted: '30-pack' } });
  assert.equal(large.nearest['rami-levy'].productId, 'rami-levy1', 'the nearest keeps the requested grade: 12 L, not 30 M');
  assert.deepEqual([out.totals.shufersal.total, out.totals['rami-levy'].total, out.split?.total], [0, 33.4, 33.4], 'a nearest product is in no total');
  assert.ok(out.notes.some((n) => /^shufersal has no 30-pack for ביצים 30; the nearest is 18 at ₪21.81 \(₪1.21 each\).*Ask the user/.test(n)));
});

test('GROC-044: a product in another form than the query names is flagged, and loses to one in that form', () => {
  const [bleach] = bestCandidates([{ name: "אקונומיקה בריח לימון סנו ז'אוול 1 ליטר" }], "סנו ג'אוול מרסס לימון");
  assert.deepEqual(bleach.lacks, ['מרסס']);
  const picked = bestCandidates([{ name: 'סבון אסלה לימון' }, { name: 'ג׳ל ניקוי אסלה לימון' }, { name: 'גל ניקוי אסלה לימון ליים' }], 'גל ניקוי אסלה לימון ליים');
  assert.deepEqual(picked.map((x) => [x.name, x.lacks]), [['גל ניקוי אסלה לימון ליים', undefined]]);
  assert.equal(bestCandidates([{ name: 'תרסיס לניקוי חלונות' }], 'ספריי לניקוי חלונות')[0].lacks, undefined, 'another spelling of the same form');
});

test('a store without the requested size reports the nearest one, per litre', async () => {
  const shop = { id: 'rami-levy', label: 'Rami Levy', search: { maxLimit: 20, run: async () => [
    { store: 'rami-levy', productId: '2', barcode: null, name: 'חלב 3% 2 ליטר', size: '2 L', price: 14.9, priceBasis: 'unit' },
    { store: 'rami-levy', productId: '3', barcode: null, name: 'חלב 3% 3 ליטר', size: '3 L', price: 21, priceBasis: 'unit' },
  ] } };
  const out = await compareBasket([shop], { items: [{ query: 'חלב 3% 1 ליטר' }] }, { cache: new SearchCache() });
  assert.deepEqual([out.items[0].offers['rami-levy'], out.items[0].nearest['rami-levy'].size, out.items[0].nearest['rami-levy'].pricePerUnit], [null, '2 L', 7.45]);
  assert.ok(out.notes.some((n) => /Rami Levy has no 1 L .*\(₪7.45 per L\)/.test(n)));
});

test('GROC-008: a flavoured bread loses to plain bread, and is flagged when it is all a store has', () => {
  const breads = [{ name: 'לחם מחמצת עגבניות', price: 20.9 }, { name: 'לחם מחמצת', price: 18.9 }];
  assert.deepEqual(bestCandidates(breads, 'לחם').map((x) => x.name), ['לחם מחמצת']);
  assert.deepEqual(bestCandidates([breads[0]], 'לחם')[0].unrequested, ['עגבניות']);
  assert.equal(bestCandidates([{ name: 'עגבניות ארוזות' }], 'עגבניות')[0].unrequested, undefined, 'a flavour the query asks for is not a variant');
});

// Live search results for the everyday-basket review, 2026-11-26.
const catalog2 = JSON.parse(readFileSync(new URL('./fixtures/catalog-2026-11-26.json', import.meta.url), 'utf8'));
const one2 = async (query, quantity = 1) => {
  const s = (id) => ({ id, label: id, search: { maxLimit: 20, run: async ({ query: q }) => catalog2[q]?.[id] ?? [] } });
  return (await compareBasket([s('shufersal'), s('rami-levy')], { items: [{ query, quantity }] }, { cache: new SearchCache() })).items[0];
};

test('GROC-018: a construct-state query matches the staple, and derived products are variants', async () => {
  for (const name of names(await one2('תפוחי אדמה'))) assert.match(name, /^תפוח אדמה/, 'potatoes, not potato pastries or burekas');
  assert.doesNotMatch((await one2('חומוס')).offers.shufersal.name, /מוקפא/);
  const pickles = await one2('מלפפונים');
  assert.ok(pickles.offers['rami-levy'].unrequested?.length, 'pickles in brine are flagged');
  assert.ok((await one2('לחם זיתים')).offers['rami-levy'].unrequested, 'breadcrumbs are flagged');
  assert.deepEqual((await one2('פחמים')).offers.shufersal.unrequested, ['מדליק'], 'lighter fluid is flagged');
  assert.equal((await one2('מטרנה')).identical, true, 'formula in both stores, not a fruit pouch');
});

test('GROC-019: window cleaner is a liquid, gadgets are variants, and offers more than 3× apart are not like for like', async () => {
  const line = await one2('מנקה חלונות');
  assert.match(line.offers.shufersal.name, /לניקוי חלונות/, 'a liquid or spray, not the ₪143 or ₪295 gadgets');
  assert.equal(line.identical, true, 'the same spray in both stores');
  const p = (store, name, price, extra = {}) => ({ store, productId: name, name, price, priceBasis: 'unit', ...extra });
  const st = (id, list) => ({ id, label: id, search: { maxLimit: 20, run: async () => list } });
  const far = (await compareBasket([st('shufersal', [p('shufersal', 'מנקה חלונות', 40)]), st('rami-levy', [p('rami-levy', 'מנקה חלונות', 10)])], { items: [{ query: 'מנקה חלונות', quantity: 1 }] }, { cache: new SearchCache() })).items[0];
  assert.match(far.notEquivalent, /^price 4× the other store's/);
  assert.equal(far.cheapestStore, null);
});

test('GROC-026: the same price per kg in a bigger pack is a size difference, compared at an equal amount', async () => {
  const S = normalizeShufersalRaw([shufersalRaw({ code: 'P_7296073753117', sku: '7296073753117', name: 'תפוח אדמה לבן ארוז', sellingMethod: { code: 'BY_PACKAGE' }, price: { value: 5.9 }, minWeight: 3000, maxWeight: 3200, pricePerUnit: { value: 5.9 }, valueForComparison: 1, unitForComparison: 'ק"ג' })]);
  const R = normalizeRamiCatalog({ data: [{ id: 13, name: 'תפוח אדמה לבן', price: { price: 5.9 }, prop: { by_kilo: 1 } }] });
  const st = (id, list) => ({ id, label: id, search: { maxLimit: 20, run: async () => list } });
  const out = await compareBasket([st('shufersal', S), st('rami-levy', R)], { items: [{ query: 'תפוחי אדמה', quantity: 1 }] }, { cache: new SearchCache() });
  const [line] = out.items;
  assert.equal(line.notEquivalent, '3.1 kg vs 1 kg', 'not a price outlier');
  assert.deepEqual([line.unitPriceComparison.amount, line.unitPriceComparison.shufersal, line.unitPriceComparison['rami-levy'], line.unitPriceComparison.cheaperStore], [1, 5.9, 5.9, null]);
  assert.equal(out.overall.itemsCompared, 1);
});

test('GROC-020: "מידה 4" is a size that must match, not a count of four', async () => {
  assert.deepEqual(constraintsOf('חיתולים מידה 4'), { stage: 'מידה 4' });
  const line = await one2('חיתולים מידה 4');
  for (const name of names(line)) assert.match(name, /מידה 4(?!\+)/);
});

test('GROC-021: sliced bread and product lines named "בייבי" are not variants', async () => {
  assert.equal((await one2('לחם פרוס')).identical, true);
  assert.equal(bestCandidates([{ name: 'חיתולים בייבי סופרים מידה 4' }], 'חיתולים')[0].unrequested, undefined);
});

test('GROC-022: items differing only in pack size are compared by unit price in overall', async () => {
  const s = (id) => ({ id, label: id, search: { maxLimit: 20, run: async ({ query: q }) => catalog2[q]?.[id] ?? [] } });
  const out = await compareBasket([s('shufersal'), s('rami-levy')], { items: ['חיתולים מידה 4', 'לחם פרוס', 'מנקה חלונות'].map((query) => ({ query, quantity: 1 })) }, { cache: new SearchCache() });
  const [diapers, bread, cleaner] = out.items;
  assert.deepEqual([diapers.unitPriceComparison.perUnit, diapers.unitPriceComparison.amount, diapers.unitPriceComparison.estimated], ['pc', 28, true]);
  assert.equal(bread.unitPriceComparison, undefined, 'like for like already');
  assert.equal(cleaner.unitPriceComparison, undefined, 'the same spray, like for like');
  assert.deepEqual([out.comparable.items, out.overall.itemsCompared, out.overall.itemsInBasket], [2, 3, 3]);
  assert.equal(out.overall.shufersal, Math.round((out.comparable.shufersal + diapers.unitPriceComparison.shufersal) * 100) / 100);
  assert.match(out.overall.note, /unit price at an equal amount/);
});

test('GROC-027: plain Bamba beats birthday, sweet, mixed and Munch editions', () => {
  const rami = ['במבה ביסלי גריל מיקס 70 גרם', 'במבה מאנצ\' צ\'דר 60 גר', 'במבה מתוקה בטעם תות אסם 30 גרם', 'במבה יום הולדת חטיף בוטנים אסם 80 גרם', 'במבה חטיף בוטנים אסם 80 גרם'].map((name) => ({ name, price: 2.8 }));
  assert.deepEqual(bestCandidates(rami, 'במבה').map((x) => x.name), ['במבה חטיף בוטנים אסם 80 גרם']);
});

test('GROC-024: a pack of tea bags is read as bags × weight, and bag counts are counts', () => {
  assert.deepEqual(parseSize('25 שקיקים*2 גרם'), { amount: 0.05, unit: 'kg', label: '0.05 kg', pack: 25, each: '0.002 kg', bags: true });
  assert.equal(parseCount('20 שקיקים'), 20);
});

test('GROC-028/029: moist wipes, concentrates and flavoured tea are variants', () => {
  assert.deepEqual(bestCandidates([{ name: 'נייר טואלט לח' }, { name: 'נייר טואלט רמי לוי 30 יח' }], 'נייר טואלט').map((x) => x.name), ['נייר טואלט רמי לוי 30 יח']);
  assert.deepEqual(bestCandidates([{ name: 'מרכך כביסה מרוכז' }, { name: 'מרכך כביסה 4 ליטר' }], 'מרכך כביסה').map((x) => x.name), ['מרכך כביסה 4 ליטר']);
  assert.deepEqual(bestCandidates([{ name: 'תה שחור אוכמניות' }, { name: 'תה ירוק נענע' }, { name: 'תה ויסוצקי קלאסיק' }], 'תה').map((x) => x.name), ['תה ויסוצקי קלאסיק']);
  assert.equal(bestCandidates([{ name: 'מגבונים לחים' }], 'מגבונים לחים')[0].unrequested, undefined);
});

test('GROC-030: a shared adjective later in the name is not relevance, unless nothing else matches', () => {
  const tea = [{ name: 'תה שחור גולדן צילוני' }, { name: 'ענבים שחורים' }, { name: 'ליפטון תה שחור 100 מעטפות' }];
  assert.deepEqual(relevantOnly([...tea, { name: 'סוכר גולדן קלאסי' }], 'תה שחור גולדן צילוני').kept.map((x) => x.name), ['תה שחור גולדן צילוני'], 'GROC-038: half the naming words, so no golden sugar');
  assert.deepEqual(relevantOnly([{ name: 'פרי ניר שמן זית כתית' }], 'שמן זית').kept.length, 1, 'a two-word brand before the product is kept by the two-word rule');
  assert.deepEqual(relevantOnly([{ name: 'ענבים שחורים' }, { name: 'שוקולד מריר' }], 'ענבים').kept.map((x) => x.name), ['ענבים שחורים'], 'a single-word query is unchanged');
  assert.deepEqual(relevantOnly([{ name: 'ענבים שחורים' }, { name: '17 256 שחור' }], 'ליפטון תה שחור').kept, [], 'GROC-038: an adjective alone is never relevance, even as a fallback');
  const fallback = relevantOnly([{ name: 'תה ירוק' }], 'ליפטון תה שחור גולדן');
  assert.deepEqual([fallback.kept.length, fallback.relevance], [1, 'any-word'], 'one naming word is the reported fallback');
});

test('GROC-032/033: tea bags are not a multipack, rolls and envelopes are counts, and "טעם" alone is not a variant', () => {
  const [tea] = normalizeShufersalRaw([shufersalRaw({ code: 'P_4605246003523', name: 'תה שחור גולדן צילוני', unitDescription: '25 שקיקים*2 גרם', sellingMethod: { code: 'BY_UNIT' }, price: { value: 14.9 } })]);
  assert.deepEqual([tea.size, tea.packCount], ['0.05 kg', undefined]);
  assert.equal(bestCandidates([tea], 'תה')[0].unrequested, undefined);
  const [rolls] = normalizeShufersalRaw([shufersalRaw({ code: 'P_1', name: 'נייר טואלט דו שכבתי', unitDescription: '32 גלילים', sellingMethod: { code: 'BY_UNIT' }, price: { value: 29.9 } })]);
  assert.deepEqual([rolls.count, rolls.size], [32, '32 pcs']);
  assert.equal(parseCount('ליפטון תה שחור 100 מעטפות'), 100);
  assert.equal(bestCandidates([{ name: 'תה שחור קלאסי טעם עשיר ויסוצקי 120 שקיקים' }], 'תה שחור')[0].unrequested, undefined);
  assert.ok(bestCandidates([{ name: 'תה בטעם לימון' }], 'תה')[0].unrequested);
});

test('GROC-035: sorted by price, a product with another percentage does not top a percentage query', async () => {
  const st = (id, list) => ({ id, label: id, search: { maxLimit: 20, run: async () => list } });
  const list = [{ store: 'rami-levy', productId: '1', name: 'חלב תנובה 1% 1 לי', price: 6.8, pricePerUnit: 6.8, perUnit: 'L' }, { store: 'rami-levy', productId: '3', name: 'חלב תנובה 3% שומן 1 ל', price: 7.2, pricePerUnit: 7.2, perUnit: 'L' }];
  for (const sortBy of ['unitPrice', 'price']) {
    const out = await searchAllStores([st('rami-levy', list)], { query: 'חלב 3%', sortBy }, { cache: new SearchCache() });
    assert.deepEqual(out.results.map((r) => r.productId), ['3', '1'], sortBy);
  }
});

test('GROC-037: bags written without a multiplication sign, and Earl Grey is a flavour', () => {
  assert.deepEqual(parseSize('תה ארל גריי ליפטון 100שקיקים 1.6גרם'), { amount: 0.16, unit: 'kg', label: '0.16 kg', pack: 100, each: '0.0016 kg', bags: true });
  assert.deepEqual(bestCandidates([{ name: 'תה שחור ארל גריי' }, { name: 'תה שחור קלאסי' }], 'תה שחור').map((x) => x.name), ['תה שחור קלאסי']);
});

test('GROC-039: a bag count followed by a box weight is the box, not each bag', () => {
  assert.deepEqual(parseSize("ליפטון ארל גריי 25 מעטפות 40גר'"), { amount: 0.04, unit: 'kg', label: '0.04 kg', bags: true });
  assert.equal(parseSize('תה ארל גריי ליפטון 100שקיקים 1.6גרם').amount, 0.16, 'a few grams is each bag');
  assert.equal(parseSize('25 שקיקים*50 גרם').amount, 1.25, 'a multiplication sign always means each');
  assert.deepEqual(bestCandidates([{ name: 'ירח מתוק מעדן חלב+אורז3%' }], 'חלב 3%'), [], 'rice pudding is not milk');
  assert.ok(bestCandidates([{ name: 'חלב מעדן וניל' }], 'חלב')[0].unrequested, 'a dessert named after milk is a variant');
});
