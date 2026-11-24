import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBasketToCart } from '../src/order.js';

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

function fakeStore(id, respond) {
  const calls = [];
  return { id, calls, callTool: async (tool, args) => { calls.push([tool, args]); return respond(tool, args, calls.length); } };
}

test('Shufersal gets one bulk add_to_cart call, including dry runs', async () => {
  const store = fakeStore('shufersal', () => text({ added: 2 }));
  const out = await addBasketToCart([store], { store: 'shufersal', items: [{ productId: 'p_7290102398065', quantity: 2 }, { productId: 'P_4131074' }], dry_run: true });
  assert.deepEqual(store.calls, [['add_to_cart', { items: [{ code: 'P_7290102398065', quantity: 2 }, { code: 'P_4131074', quantity: 1 }], dry_run: true }]]);
  assert.deepEqual(out, { store: 'shufersal', dryRun: true, requested: 2, result: { added: 2 } });

  const failing = fakeStore('shufersal', () => ({ isError: true, ...text('not signed in') }));
  await assert.rejects(addBasketToCart([failing], { store: 'shufersal', items: [{ productId: 'P_1' }] }), /Shufersal: not signed in/);
});

test('Rami Levy adds item by item and reports each result', async () => {
  const store = fakeStore('rami-levy', (tool, args) => (args.productId === 'bad' ? { isError: true, ...text('unknown product') } : text({ ok: true })));
  const out = await addBasketToCart([store], { store: 'rami-levy', items: [
    { productId: '329258', name: 'חלב 3% טרה 2 ליטר', price: 14.9, quantity: 2 },
    { productId: 'bad', name: 'x', price: 1 },
    { productId: '1', name: 'עגבניות', price: 30.6, quantity: 0.5 },
  ] });
  assert.deepEqual(store.calls[0], ['rami_levy_add_item', { productId: '329258', name: 'חלב 3% טרה 2 ליטר', price: 14.9, qty: 2 }]);
  assert.deepEqual([out.requested, out.added, out.failed], [3, 2, 1]);
  assert.deepEqual(out.results[1], { productId: 'bad', name: 'x', quantity: 1, added: false, error: 'unknown product' });
});

test('Rami Levy stops starting adds when the time budget runs out, and dry runs change nothing', async () => {
  let clock = 0;
  const store = fakeStore('rami-levy', () => { clock += 60_000; return text({ ok: true }); });
  const items = [1, 2, 3].map((n) => ({ productId: String(n), name: `item ${n}`, price: 1 }));
  const out = await addBasketToCart([store], { store: 'rami-levy', items }, { now: () => clock });
  assert.equal(store.calls.length, 2);
  assert.deepEqual([out.added, out.failed], [2, 1]);
  assert.match(out.results[2].error, /time budget/);

  const preview = fakeStore('rami-levy', () => text({ ok: true }));
  const dry = await addBasketToCart([preview], { store: 'rami-levy', items, dry_run: true });
  assert.deepEqual([preview.calls.length, dry.dryRun, dry.wouldAdd.length], [0, true, 3]);
});

test('addBasketToCart validates the store and every item', async () => {
  const shufersal = fakeStore('shufersal', () => text({}));
  const cases = [
    [{ store: 'victory', items: [{ productId: 'P_1' }] }, /store must be/],
    [{ store: 'shufersal', items: [] }, /non-empty/],
    [{ store: 'shufersal', items: [{ productId: '329258' }] }, /not a Shufersal code/],
    [{ store: 'shufersal', items: [{ productId: 'P_1', quantity: 1.5 }] }, /whole units/],
    [{ store: 'shufersal', items: [{ productId: 'P_1', quantity: 0 }] }, /quantity/],
    [{ store: 'rami-levy', items: [{ productId: '1' }] }, /name and price/],
    [{ store: 'rami-levy', items: [{ productId: '1', name: 'x', price: 1 }] }, /not configured/],
    [{ store: 'shufersal', items: Array.from({ length: 61 }, () => ({ productId: 'P_1' })) }, /at most 60/],
  ];
  for (const [args, message] of cases) await assert.rejects(addBasketToCart([shufersal], args), message);
});
