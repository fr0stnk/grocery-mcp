import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createStores } from '../src/config.js';
import { normalizeRamiCatalog, normalizeShufersalRaw, parseShufersalPromotion } from '../src/normalize.js';
import { cookieHeader, fetchShufersalSearch } from '../src/shufersal-search.js';

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); }))));
const NOW = Date.parse('2026-11-25T12:00:00Z');

function cookieFile(cookies) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shufersal-')), 'cookies.json');
  fs.writeFileSync(file, JSON.stringify({ savedAt: 'x', cookies }));
  return file;
}
const live = (name, extra = {}) => ({ name, value: `${name}-v`, domain: '.shufersal.co.il', path: '/', expires: -1, secure: false, ...extra });

// Shapes taken from a live search, product names kept.
const PASTA = {
  code: 'P_7296073011224', sku: '7296073011224', ean: null, name: 'פסטה פוסילי', brandName: 'MORINI', unitDescription: '500 גרם',
  sellingMethod: { code: 'BY_UNIT' }, price: { value: 7.9 }, pricePerUnit: { value: 1.58 }, valueForComparison: 100, unitForComparison: 'גרם',
  stock: { stockLevelStatus: { code: 'inStock' } }, promotionMsg: "3 יח'  ב- 15 ₪",
};
const TOMATOES = {
  code: 'P_7296073440345', sku: '7296073440345', name: 'עגבניות ארוזות', brandName: 'קטיף', unitDescription: 'כ-4 יחידות',
  sellingMethod: { code: 'BY_PACKAGE' }, price: { value: 8.9 }, pricePerUnit: { value: 8.9 }, valueForComparison: 1, unitForComparison: 'ק"ג',
  stock: { stockLevelStatus: { code: 'inStock' } }, promotionMsg: null,
};

test('cookieHeader follows the adapter rules for domain, path, expiry and secure', () => {
  const file = cookieFile([
    live('JSESSIONID'),
    live('host', { domain: 'www.shufersal.co.il' }),
    live('other', { domain: 'example.com' }),
    live('expired', { expires: NOW / 1000 - 10 }),
    live('later', { expires: NOW / 1000 + 3600 }),
    live('deep', { path: '/checkout' }),
    live('secure', { secure: true }),
  ]);
  assert.equal(cookieHeader(file, 'https://www.shufersal.co.il/online/he/search/results', NOW), 'JSESSIONID=JSESSIONID-v; host=host-v; later=later-v; secure=secure-v');
  assert.equal(cookieHeader(file, 'http://www.shufersal.co.il/online', NOW), 'JSESSIONID=JSESSIONID-v; host=host-v; later=later-v');
});

test('fetchShufersalSearch sends the session and reports problems clearly', async () => {
  const seen = [];
  let reply = [200, 'application/json;charset=UTF-8', JSON.stringify({ results: [PASTA] })];
  const server = createServer((req, res) => { seen.push(req); res.writeHead(reply[0], { 'content-type': reply[1] }); res.end(reply[2]); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const file = cookieFile([live('JSESSIONID', { domain: '127.0.0.1' })]);

  const results = await fetchShufersalSearch('פסטה', { cookieFile: file, limit: 5, origin });
  assert.equal(results[0].code, 'P_7296073011224');
  assert.equal(decodeURIComponent(seen[0].url), '/online/he/search/results?q=פסטה:relevance&limit=5');
  assert.equal(seen[0].headers.cookie, 'JSESSIONID=JSESSIONID-v');
  assert.equal(seen[0].headers['x-requested-with'], 'XMLHttpRequest');

  reply = [302, 'text/html', ''];
  await assert.rejects(fetchShufersalSearch('x', { cookieFile: file, origin }), /HTTP 302 \(text\/html\); the session may have expired/);
  reply = [200, 'application/json', '{"oops":1}'];
  await assert.rejects(fetchShufersalSearch('x', { cookieFile: file, origin }), /no results array/);
  await assert.rejects(fetchShufersalSearch('x', { origin }), /no saved session file/);
  await assert.rejects(fetchShufersalSearch('x', { cookieFile: '/nonexistent/cookies.json', origin }), /cannot read the saved session: ENOENT/);
  await assert.rejects(fetchShufersalSearch('x', { cookieFile: cookieFile([]), origin }), /no valid cookies/);
});

test('normalizeShufersalRaw keeps barcode, stock, brand, size and promotions', () => {
  const [pasta, tomatoes, missing, noSize] = normalizeShufersalRaw([
    PASTA,
    TOMATOES,
    { ...PASTA, code: 'P_1', sku: '1', stock: { stockLevelStatus: { code: 'outOfStock' } }, promotionMsg: null },
    { ...PASTA, code: 'P_2', unitDescription: 'מארז', name: 'פסטה מיוחדת', promotionMsg: null },
    null,
  ]);
  assert.deepEqual(pasta, {
    store: 'shufersal', productId: 'P_7296073011224', barcode: '7296073011224', name: 'פסטה פוסילי', brand: 'MORINI',
    size: '0.5 kg', price: 7.9, priceBasis: 'unit', pricePerUnit: 15.8, perUnit: 'kg', inStock: true,
    promotions: [{ text: "3 יח' ב- 15 ₪", quantity: 3, price: 15, unitPrice: 5, until: null, clubOnly: false, personal: false }],
  });
  assert.deepEqual([tomatoes.soldByWeight, tomatoes.priceBasis, tomatoes.priceEstimated, tomatoes.pricePerUnit, tomatoes.perUnit, tomatoes.inStock], [true, 'package', true, 8.9, 'kg', true]);
  assert.deepEqual([missing.inStock, missing.barcode], [false, null]);
  assert.deepEqual([noSize.size, noSize.pricePerUnit, noSize.perUnit], [null, 15.8, 'kg'], 'the store comparison price fills in');
  assert.throws(() => normalizeShufersalRaw({}), /no results array/);
});

test('parseShufersalPromotion reads multi-buy offers and keeps other wordings as text', () => {
  assert.deepEqual(parseShufersalPromotion("2 יח' ב-25 ₪").map((p) => [p.quantity, p.price, p.unitPrice]), [[2, 25, 12.5]]);
  assert.deepEqual(parseShufersalPromotion('השני ב-50% הנחה')[0], { text: 'השני ב-50% הנחה', quantity: null, price: null, unitPrice: null, until: null, clubOnly: false, personal: false });
  assert.equal(parseShufersalPromotion("3 יח' ב- 10 ₪ למועדון")[0].clubOnly, true);
  assert.deepEqual(parseShufersalPromotion(null), []);
});

test('Rami Levy items are in stock only when the branch is listed', () => {
  const data = { data: [{ id: 1, name: 'a', price: { price: 1 }, available_in: [412, 1214] }, { id: 2, name: 'b', price: { price: 1 }, available_in: [412] }, { id: 3, name: 'c', price: { price: 1 } }] };
  assert.deepEqual(normalizeRamiCatalog(data, { branch: '1214' }).map((p) => p.inStock), [true, false, null]);
  assert.deepEqual(normalizeRamiCatalog(data).map((p) => p.inStock), [null, null, null]);
});

test('the configured Shufersal search reads directly and falls back to the adapter', async () => {
  let status = 200;
  const server = createServer((req, res) => {
    res.writeHead(status, { 'content-type': status === 200 ? 'application/json' : 'text/html' });
    res.end(status === 200 ? JSON.stringify({ results: [PASTA] }) : '<html>login</html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  const env = { GROCERY_STORES: 'shufersal', SHUFERSAL_COOKIE_FILE: cookieFile([live('s', { domain: '127.0.0.1' })]), GROCERY_SHUFERSAL_ORIGIN: `http://127.0.0.1:${server.address().port}` };
  const [store] = createStores(env);
  let fallbacks = 0;
  const fallback = async () => { fallbacks += 1; return ['from adapter']; };
  assert.equal((await store.search.run({ query: 'פסטה', limit: 5, fallback }))[0].promotions[0].unitPrice, 5);
  status = 302;
  assert.deepEqual(await store.search.run({ query: 'פסטה', limit: 5, fallback }), ['from adapter']);
  assert.equal(fallbacks, 1);
  assert.equal(createStores({ ...env, GROCERY_SHUFERSAL_SEARCH: 'adapter' })[0].search.run, undefined);
});

test('weighed Shufersal items are priced per kilogram when Shufersal says so', () => {
  const SALMON = { code: 'P_939995', sku: '939995', name: 'פילה סלמון קפוא', unitDescription: 'מחיר לפי משקל', sellingMethod: { code: 'BY_WEIGHT' },
    price: { value: 69.9 }, pricePerUnit: { value: 69.9 }, valueForComparison: 1, unitForComparison: 'ק"ג', stock: { stockLevelStatus: { code: 'inStock' } } };
  const [salmon, unclear] = normalizeShufersalRaw([SALMON, { ...SALMON, code: 'P_2', pricePerUnit: { value: 50 } }]);
  assert.deepEqual([salmon.priceBasis, salmon.pricePerUnit, salmon.perUnit, salmon.soldByWeight, salmon.priceEstimated], ['kg', 69.9, 'kg', true, undefined]);
  assert.deepEqual([unclear.priceBasis, unclear.priceEstimated, unclear.pricePerUnit], ['package', true, 50]);
});
