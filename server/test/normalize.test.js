import assert from 'node:assert/strict';
import { test } from 'node:test';
import { barcodeOf, compareItems, normalizeRamiCatalog, normalizeRamiLevy, normalizeShufersal, parsePrice, parsePromotions, parseSize, StoreError } from '../src/normalize.js';
import { groupByBarcode } from '../src/search.js';

test('parseSize reads the sizes seen in live results', () => {
  const cases = {
    '2 ליטר': '2 L',
    "חלב תנובה 3% שומן 1 ל' קרטון בד\"צ": '1 L',
    'חלב מועשר 2 ל 3% מהדרין': '2 L',
    'חלב תנובה 1% 1 לי': '1 L',
    'חלב 3% טרה 2 ליטר': '2 L',
    'יוגורט 6*200 מ"ל': '1.2 L',
    'שוקו 1 ל׳': '1 L',
    'גבינה 250 גרם': '0.25 kg',
    'עגבניות 1.5 ק"ג': '1.5 kg',
    'במבה 80 ג\'': '0.08 kg',
    'אורז 1,5 קג': '1.5 kg',
  };
  for (const [text, label] of Object.entries(cases)) assert.equal(parseSize(text)?.label, label, text);
});

test('parseSize ignores percentages and words that only start with a unit letter', () => {
  assert.equal(parseSize('חלב 3% מהדרין'), null);
  assert.equal(parseSize('נייר טואלט 5 גלילים'), null);
  assert.equal(parseSize('חלב טרי 3% 1 ליטר רמי לוי')?.label, '1 L');
  assert.equal(parseSize(undefined), null);
});

test('parsePrice handles numbers and shekel strings', () => {
  assert.equal(parsePrice(14.9), 14.9);
  assert.equal(parsePrice('14.70 ₪'), 14.7);
  assert.equal(parsePrice('₪ 7,35'), 7.35);
  assert.equal(parsePrice('1,299.90 ₪'), 1299.9);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(null), null);
});

test('normalizeShufersal maps the live search shape', () => {
  const text = JSON.stringify([
    { code: 'P_7290102398065', name: 'חלב 3% בקרטון מהדרין', brand: 'טרה', unit: '2 ליטר', price: '14.70 ₪', inStock: true, sellingMethod: 'BY_UNIT' },
    { code: 'P_123', name: 'עגבניות', brand: '', unit: '1 ק"ג', price: '6.90 ₪', inStock: false, sellingMethod: 'BY_WEIGHT' },
  ]);
  const [milk, tomatoes] = normalizeShufersal(text);
  assert.deepEqual(milk, {
    store: 'shufersal', productId: 'P_7290102398065', barcode: '7290102398065', name: 'חלב 3% בקרטון מהדרין', brand: 'טרה',
    size: '2 L', price: 14.7, pricePerUnit: 7.35, perUnit: 'L', inStock: true,
  });
  assert.equal(tomatoes.brand, null);
  assert.equal(tomatoes.pricePerUnit, null);
  assert.equal(tomatoes.soldByWeight, true);
  assert.equal(tomatoes.inStock, false);
});

test('normalizeRamiLevy maps results and surfaces adapter errors', () => {
  const ok = JSON.stringify({ ok: true, results: [{ productId: '3025', name: "חלב תנובה 3% שומן 1 ל' קרטון בד\"צ", price: 7.2 }] });
  assert.deepEqual(normalizeRamiLevy(ok), [{
    store: 'rami-levy', productId: '3025', barcode: null, name: "חלב תנובה 3% שומן 1 ל' קרטון בד\"צ", brand: null,
    size: '1 L', price: 7.2, pricePerUnit: 7.2, perUnit: 'L', inStock: null,
  }]);
  assert.throws(() => normalizeRamiLevy(JSON.stringify({ ok: false, error: 'auth_expired' })), (e) => e instanceof StoreError && /auth_expired/.test(e.message));
  assert.throws(() => normalizeRamiLevy('<html>'), StoreError);
});

test('compareItems sorts by unit price, then price, unknowns last', () => {
  const rows = [
    { name: 'a', pricePerUnit: null, price: 1 },
    { name: 'b', pricePerUnit: 7.45, price: 14.9 },
    { name: 'c', pricePerUnit: 7.1, price: 7.1 },
    { name: 'd', pricePerUnit: null, price: null },
    { name: 'e', pricePerUnit: 7.1, price: 14.2 },
  ];
  assert.deepEqual(rows.sort(compareItems).map((r) => r.name), ['c', 'e', 'b', 'a', 'd']);
});

test('barcodeOf accepts retail barcodes and rejects internal codes', () => {
  assert.equal(barcodeOf('P_7290102398065'), '7290102398065');
  assert.equal(barcodeOf(7290102398065), '7290102398065');
  assert.equal(barcodeOf('12345678'), '12345678');
  assert.equal(barcodeOf('P_4131074'), null);
  assert.equal(barcodeOf('162'), null);
  assert.equal(barcodeOf(null), null);
});

test('parsePromotions reads Rami Levy multi-buy offers', () => {
  const sale = [
    { cmt: 4, scm: 10, label: 'פסטה רמי לוי 4 יח\' ב-10 ש"ח', to: '2026-11-28 23:59:59', active: 1, is_club: 0, is_personal: 0 },
    { cmt: 0, scm: 0, label: 'club gift', to: null, active: 1, is_club: 1 },
    { cmt: 2, scm: 5, label: 'expired', active: 0 },
  ];
  assert.deepEqual(parsePromotions(sale), [
    { text: 'פסטה רמי לוי 4 יח\' ב-10 ש"ח', quantity: 4, price: 10, unitPrice: 2.5, until: '2026-11-28', clubOnly: false, personal: false },
    { text: 'club gift', quantity: null, price: null, unitPrice: null, until: null, clubOnly: true, personal: false },
  ]);
  assert.deepEqual(parsePromotions(undefined), []);
});

test('normalizeRamiCatalog maps barcodes, weighed items and promotions', () => {
  const [milk, tomatoes, pasta] = normalizeRamiCatalog({
    data: [
      { id: 329258, barcode: 7290102398065, name: 'חלב 3% טרה 2 ליטר', price: { price: 14.9 }, prop: { by_kilo: 0 }, sale: [] },
      { id: 1, barcode: 162, name: 'עגבניות שרי פרימיום', price: { price: 30.6 }, prop: { by_kilo: 1 }, sale: [] },
      { id: 2, barcode: 7290000000001, name: 'פסטה פנה 500גר רמי לוי', price: { price: 4.2 }, prop: { by_kilo: 0 }, sale: [{ cmt: 4, scm: 10, label: '4 ב-10', active: 1 }] },
    ],
  });
  assert.deepEqual([milk.productId, milk.barcode, milk.size, milk.price, milk.pricePerUnit], ['329258', '7290102398065', '2 L', 14.9, 7.45]);
  assert.deepEqual([tomatoes.barcode, tomatoes.size, tomatoes.pricePerUnit, tomatoes.perUnit, tomatoes.soldByWeight], [null, null, 30.6, 'kg', true]);
  assert.equal(pasta.promotions[0].unitPrice, 2.5);
  assert.equal(milk.promotions, undefined);
  assert.throws(() => normalizeRamiCatalog({ status: 'error' }), StoreError);
});

test('groupByBarcode pairs the same product across stores', () => {
  const groups = groupByBarcode([
    { store: 'shufersal', productId: 'P_7290102398065', barcode: '7290102398065', name: 'חלב 3% בקרטון מהדרין', price: 14.7 },
    { store: 'rami-levy', productId: '329258', barcode: '7290102398065', name: 'חלב 3% טרה 2 ליטר', price: 14.9 },
    { store: 'rami-levy', productId: '3', barcode: '7290000000009', name: 'only here', price: 5 },
    { store: 'shufersal', productId: 'P_1', barcode: null, name: 'no barcode', price: 1 },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0], {
    barcode: '7290102398065',
    name: 'חלב 3% בקרטון מהדרין',
    offers: [
      { store: 'shufersal', productId: 'P_7290102398065', price: 14.7 },
      { store: 'rami-levy', productId: '329258', price: 14.9 },
    ],
    cheapestStore: 'shufersal',
    priceDifference: 0.2,
  });
});
