import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareItems, normalizeRamiLevy, normalizeShufersal, parsePrice, parseSize, StoreError } from '../src/normalize.js';

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
    store: 'shufersal', productId: 'P_7290102398065', name: 'חלב 3% בקרטון מהדרין', brand: 'טרה',
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
    store: 'rami-levy', productId: '3025', name: "חלב תנובה 3% שומן 1 ל' קרטון בד\"צ", brand: null,
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
