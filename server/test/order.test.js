import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SearchCache } from '../src/cache.js';
import { addBasketToCart } from '../src/order.js';

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const product = (store, productId, extra = {}) => ({ store, productId, barcode: null, name: `name ${productId}`, price: 10, priceBasis: 'unit', inStock: true, ...extra });

/** A store whose searches answer from `catalog` (query -> items) and whose tool calls are recorded. */
function fakeStore(id, { catalog = {}, respond = () => text({ ok: true }), searchFails = false } = {}) {
  const calls = [];
  return {
    id,
    label: id,
    calls,
    search: { maxLimit: 20, run: async ({ query }) => { if (searchFails) throw new Error('down'); return catalog[query] ?? []; } },
    callTool: async (tool, args) => { calls.push([tool, args]); return respond(tool, args, calls.length); },
  };
}

async function seed(cache, store, query, items) {
  await cache.get(`${store}||${query}`, async () => items);
}

test('Shufersal checks every product the same way in a dry run, before anything is sent', async () => {
  const store = fakeStore('shufersal', {
    catalog: {
      7290102398065: [product('shufersal', 'P_7290102398065')],
      7296073409441: [product('shufersal', 'P_7296073409441'), product('shufersal', 'P_7296073409441_42', { name: 'variant' })],
      939995: [product('shufersal', 'P_939995', { name: 'פילה סלמון קפוא', priceBasis: 'kg', soldByWeight: true })],
      1111111: [product('shufersal', 'P_1111111', { inStock: false })],
    },
  });
  const out = await addBasketToCart([store], { store: 'shufersal', dry_run: true, items: [
    { productId: 'p_7290102398065', quantity: 2 },
    { productId: 'P_9999999999999' },
    { productId: 'P_939995' },
    { productId: 'P_1111111' },
    { productId: 'P_7296073409441_42' },
    { productId: 'P_ABC' },
    { productId: 'P_7290102398065', quantity: 1.5 },
  ] }, { cache: new SearchCache() });

  assert.deepEqual(store.calls, [], 'a dry run sends nothing to the adapter');
  assert.deepEqual(out.results.map((r) => r.status === 'rejected' ? r.code : r.status), [
    'would-add', 'PRODUCT_NOT_FOUND', 'UNSUPPORTED_SELLING_METHOD', 'OUT_OF_STOCK', 'would-add', 'UNSUPPORTED_PRODUCT_ID', 'INVALID_QUANTITY',
  ]);
  assert.deepEqual([out.requested, out.accepted, out.rejected, out.complete], [7, 2, 5, false]);
  assert.equal(out.results[4].name, 'variant', 'a variant code matches its exact variant');
  assert.deepEqual([out.results[0].productId, out.results[0].priceSource], ['P_7290102398065', 'server']);
});

test('Shufersal sends only checked items, in one bulk call', async () => {
  const cache = new SearchCache();
  await seed(cache, 'shufersal', 'חלב', [product('shufersal', 'P_7290102398065'), product('shufersal', 'P_4131074')]);
  const store = fakeStore('shufersal', { respond: () => text({ summary: 'Added 1 of 2.', lines: [{ code: 'P_7290102398065', status: 'added' }, { code: 'P_4131074', status: 'unavailable' }] }) });
  const out = await addBasketToCart([store], { store: 'shufersal', items: [{ productId: 'P_7290102398065', quantity: 2 }, { productId: 'P_4131074' }, { productId: 'P_9' }] }, { cache });

  assert.deepEqual(store.calls.map(([tool, args]) => [tool, args.items.map((i) => i.code), args.dry_run]), [['add_to_cart', ['P_7290102398065', 'P_4131074'], false]]);
  assert.deepEqual(out.results.map((r) => r.status === 'rejected' ? r.code : r.status), ['added', 'STORE_REJECTED', 'PRODUCT_NOT_FOUND']);
  assert.deepEqual([out.added, out.complete, out.storeSummary], [1, false, 'Added 1 of 2.']);

  const failing = fakeStore('shufersal', { respond: () => ({ isError: true, ...text('not signed in') }) });
  await assert.rejects(addBasketToCart([failing], { store: 'shufersal', items: [{ productId: 'P_7290102398065' }] }, { cache }), (e) => e.code === 'STORE_ERROR' && /not signed in/.test(e.message));
  const unreachable = fakeStore('shufersal', { searchFails: true });
  const down = await addBasketToCart([unreachable], { store: 'shufersal', dry_run: true, items: [{ productId: 'P_5' }] }, { cache: new SearchCache() });
  assert.equal(down.results[0].code, 'STORE_UNAVAILABLE');
});

test('Shufersal raises a product already in the cart instead of reporting it added unchanged', async () => {
  const cache = new SearchCache();
  await seed(cache, 'shufersal', 'חלב', [product('shufersal', 'P_4131074'), product('shufersal', 'P_7290102398065'), product('shufersal', 'P_5')]);
  const cart = { P_4131074: 1, P_7290102398065: 29, P_5: 2 };
  const store = fakeStore('shufersal', { respond: (tool, args) => {
    if (tool === 'add_to_cart') return text({ lines: args.items.map((i) => ({ code: i.code, status: 'already-in-cart', cartQuantity: cart[i.code] })) });
    if (args.code !== 'P_5') cart[args.code] = args.quantity;
    return text({ products: Object.entries(cart).map(([code, quantity]) => ({ code, quantity })) });
  } });
  const out = await addBasketToCart([store], { store: 'shufersal', items: [{ productId: 'P_4131074', quantity: 2 }, { productId: 'P_7290102398065', quantity: 2 }, { productId: 'P_5' }] }, { cache });

  assert.deepEqual(store.calls.slice(1), [['set_quantity', { code: 'P_4131074', quantity: 3 }], ['set_quantity', { code: 'P_5', quantity: 3 }]], 'over the limit is never sent');
  assert.deepEqual(out.results.map((r) => [r.status, r.code, r.cartQuantity]), [['added', undefined, 3], ['rejected', 'INVALID_QUANTITY', 29], ['rejected', 'STORE_REJECTED', 2]]);
  assert.deepEqual([out.added, out.complete], [1, false]);
});

test('Rami Levy adds every checked product in one call, with the server\'s own name and price', async () => {
  const cache = new SearchCache();
  await seed(cache, 'rami-levy', 'חלב', [
    product('rami-levy', '329258', { name: 'חלב 3% טרה 2 ליטר', price: 14.9 }),
    product('rami-levy', '1', { name: 'עגבניות', price: 30.6, priceBasis: 'kg' }),
    product('rami-levy', '2', { inStock: false }),
  ]);
  const store = fakeStore('rami-levy', {
    catalog: { 'from the client': [product('rami-levy', '777', { name: 'found by name', price: 5.5 })], fake: [] },
    respond: () => text({ ok: false, reason: 'items_rejected', rejected: [{ productId: '1', name: 'עגבניות' }], serverTotal: 34.8 }),
  });
  const out = await addBasketToCart([store], { store: 'rami-levy', items: [
    { productId: '329258', name: 'wrong name', price: 12, quantity: 2 },
    { productId: '1', quantity: 0.5 },
    { productId: '2' },
    { productId: '329258', quantity: 1.5 },
    { productId: '777', name: 'from the client', price: 5 },
    { productId: '888' },
    { productId: '999999999999', name: 'fake', price: 1 },
  ] }, { cache });

  assert.deepEqual(store.calls, [['rami_levy_add_items', { items: [
    { productId: '329258', name: 'חלב 3% טרה 2 ליטר', price: 14.9, qty: 2 },
    { productId: '1', name: 'עגבניות', price: 30.6, qty: 0.5 },
    { productId: '777', name: 'found by name', price: 5.5, qty: 1 },
  ] }]]);
  assert.deepEqual(out.results[0].priceChanged, { requested: 12, current: 14.9 });
  assert.deepEqual(out.results.map((r) => r.status === 'rejected' ? r.code : `${r.status}:${r.priceSource}`), [
    'added:server', 'STORE_REJECTED', 'OUT_OF_STOCK', 'INVALID_QUANTITY', 'added:server', 'PRODUCT_NOT_VERIFIED', 'PRODUCT_NOT_VERIFIED',
  ]);
  assert.deepEqual(out.results[4].priceChanged, { requested: 5, current: 5.5 }, 'a product found by name is priced by the server');
  assert.deepEqual([out.requested, out.added, out.rejected, out.complete, out.serverTotal], [7, 2, 5, false, 34.8]);
});

test('Rami Levy reports a failed sync as a store error, and dry runs change nothing', async () => {
  const items = [1, 2, 3].map((n) => ({ productId: String(n), name: `item ${n}`, price: 1 }));
  const seeded = async () => {
    const cache = new SearchCache();
    await seed(cache, 'rami-levy', 'x', items.map((i) => product('rami-levy', i.productId, { name: i.name, price: 1 })));
    return cache;
  };
  const expired = fakeStore('rami-levy', { respond: () => text({ ok: false, reason: 'auth_expired', status: 401 }) });
  await assert.rejects(addBasketToCart([expired], { store: 'rami-levy', items }, { cache: await seeded() }), (e) => e.code === 'STORE_ERROR' && /auth_expired/.test(e.message) && !e.retryable);

  const fine = fakeStore('rami-levy', { respond: () => text({ ok: true, serverTotal: 3, resetAfterOrder: { orderId: 5 } }) });
  const done = await addBasketToCart([fine], { store: 'rami-levy', items }, { cache: await seeded() });
  assert.deepEqual([fine.calls.length, done.added, done.complete, done.resetAfterOrder.orderId], [1, 3, true, 5]);

  const preview = fakeStore('rami-levy');
  const dry = await addBasketToCart([preview], { store: 'rami-levy', items, dry_run: true }, { cache: await seeded() });
  assert.deepEqual([preview.calls.length, dry.dryRun, dry.accepted, dry.complete], [0, true, 3, true]);
});

test('addBasketToCart rejects bad requests with stable codes', async () => {
  const shufersal = fakeStore('shufersal');
  const cases = [
    [{ store: 'victory', items: [{ productId: 'P_1' }] }, 'INVALID_ARGUMENT', /store must be/],
    [{ store: 'shufersal', items: [] }, 'INVALID_ARGUMENT', /non-empty/],
    [{ store: 'shufersal', items: [{ productId: 'P_1', quantity: 0 }] }, 'INVALID_QUANTITY', /quantity/],
    [{ store: 'rami-levy', items: [{ productId: '1', name: 'x', price: 1 }] }, 'STORE_UNAVAILABLE', /not configured/],
    [{ store: 'shufersal', items: Array.from({ length: 61 }, () => ({ productId: 'P_1' })) }, 'INVALID_ARGUMENT', /at most 60/],
  ];
  for (const [args, code, message] of cases) {
    await assert.rejects(addBasketToCart([shufersal], args, { cache: new SearchCache() }), (e) => e.code === code && message.test(e.message));
  }
});

test('a Rami Levy id seen in the last two days is re-checked by its barcode, with no name needed (review GROC-051-03)', async () => {
  const store = fakeStore('rami-levy', { catalog: { 7290110563462: [product('rami-levy', '354095', { name: 'חלב נטול לקטוז', price: 9.3, barcode: '7290110563462' })] } });
  const history = { lastSeen: async (id, productId) => (productId === '354095' ? { name: 'חלב', barcode: '7290110563462', price: 9.3 } : null) };
  const out = await addBasketToCart([store], { store: 'rami-levy', dry_run: true, items: [{ productId: '354095', quantity: 2 }, { productId: '1' }] }, { cache: new SearchCache(), history });
  assert.deepEqual(out.results.map((r) => [r.status, r.code, r.priceSource, r.price]), [['would-add', undefined, 'server', 9.3], ['rejected', 'PRODUCT_NOT_VERIFIED', undefined, undefined]]);
});

