import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareBasket } from '../src/basket.js';
import { SearchCache } from '../src/cache.js';
import { cheapestSlotFee, createDelivery, fetchShufersalDeliveryFee, SITE_TERMS } from '../src/delivery.js';

const p = (store, productId, barcode, price, name) => ({ store, productId, barcode, name, price });

test('cheapestSlotFee takes the lowest selectable window and ignores malformed ones', () => {
  const body = {
    20261127: [{ selectable: true, price: { value: 35.9 } }, { selectable: false, price: { value: 9.9 } }, { selectable: true, price: { value: 29.9 } }],
    20261128: [{ selectable: true, price: null }, null],
  };
  assert.equal(cheapestSlotFee(body), 29.9);
  assert.equal(cheapestSlotFee({}), null);
  assert.equal(cheapestSlotFee(null), null);
});

test('createDelivery prefers configured values, then a live read, then the site, and caches only successes', async () => {
  let calls = 0;
  let live = null;
  let clock = 0;
  const delivery = createDelivery({}, { fetchShufersalFee: async () => { calls += 1; return live; }, now: () => clock });

  assert.deepEqual(await delivery('shufersal'), { fee: null, minimumOrder: null, source: 'unknown' });
  live = 35.9;
  assert.deepEqual(await delivery('shufersal'), { fee: 35.9, minimumOrder: null, source: 'live' });
  await delivery('shufersal');
  assert.equal(calls, 2, 'a failed read is not cached, a successful one is');
  clock = 61 * 60_000;
  await delivery('shufersal');
  assert.equal(calls, 3, 'the cache expires after an hour');

  assert.deepEqual(await delivery('rami-levy'), { ...SITE_TERMS['rami-levy'], source: 'site' });
  assert.equal(await delivery('elsewhere'), null);

  const configured = createDelivery(
    { GROCERY_SHUFERSAL_DELIVERY_FEE: '24.9', GROCERY_SHUFERSAL_SERVICE_FEE: '0', GROCERY_RAMI_LEVY_MINIMUM_ORDER: '150', GROCERY_RAMI_LEVY_DELIVERY_FEE: 'x' },
    { fetchShufersalFee: async () => assert.fail('a configured fee needs no live read') },
  );
  assert.deepEqual(await configured('shufersal'), { fee: 24.9, serviceFee: 0, minimumOrder: null, source: 'configured' });
  assert.deepEqual(await configured('rami-levy'), { fee: 35.9, minimumOrder: 150, source: 'site', checked: SITE_TERMS['rami-levy'].checked });

  const failing = createDelivery({}, { fetchShufersalFee: async () => { throw new Error('network'); } });
  assert.equal((await failing('shufersal')).source, 'unknown');
});

const catalog = {
  shufersal: { חלב: [p('shufersal', 'S1', '111', 6, 'חלב 3%')], לחם: [p('shufersal', 'S2', '222', 10, 'לחם אחיד')] },
  'rami-levy': { חלב: [p('rami-levy', 'R1', '111', 5, 'חלב 3%')], לחם: [p('rami-levy', 'R2', '222', 12, 'לחם אחיד')] },
};
const store = (id) => ({ id, label: id === 'shufersal' ? 'Shufersal' : 'Rami Levy', search: { maxLimit: 20, run: async ({ query }) => catalog[id][query] ?? [] } });
const items = [{ query: 'חלב', quantity: 2 }, { query: 'לחם' }];

test('compare_basket adds one delivery fee per order and flags a basket below the minimum', async () => {
  const delivery = async (id) => (id === 'shufersal' ? { fee: 35.9, minimumOrder: null, source: 'live' } : { fee: 29.9, minimumOrder: 50, source: 'site' });
  const out = await compareBasket([store('shufersal'), store('rami-levy')], { items }, { cache: new SearchCache(), delivery });

  assert.equal(out.totals.shufersal.total, 22);
  assert.equal(out.totals.shufersal.totalWithDelivery, 57.9);
  assert.deepEqual(out.totals.shufersal.delivery, { fee: 35.9, minimumOrder: null, source: 'live' });
  assert.equal(out.totals['rami-levy'].totalWithDelivery, 51.9);
  assert.equal(out.totals['rami-levy'].delivery.belowMinimum, true);
  assert.ok(out.notes.some((n) => n.includes('Rami Levy has a minimum order of ₪50')));

  assert.deepEqual(out.overall.withDelivery, { shufersal: 57.9, 'rami-levy': 51.9, cheaperStore: 'rami-levy', difference: 6 });
  // The split buys milk at Rami Levy and bread at Shufersal, so it pays both fees.
  assert.deepEqual(out.split.withDelivery, { total: 85.8, deliveryFees: 65.8, stores: ['rami-levy', 'shufersal'] });
  assert.ok(out.notes.some((n) => n.startsWith('Splitting the order costs a second delivery fee')));
  assert.ok(!out.notes.some((n) => n.startsWith('Delivery fees, minimum order')));
});

test('compare_basket leaves delivery out where a fee is unknown, and keeps the old note without a provider', async () => {
  const delivery = async (id) => (id === 'shufersal' ? { fee: null, minimumOrder: null, source: 'unknown' } : { fee: 29.9, minimumOrder: 50, source: 'site' });
  const out = await compareBasket([store('shufersal'), store('rami-levy')], { items }, { cache: new SearchCache(), delivery });
  assert.equal(out.totals.shufersal.totalWithDelivery, undefined);
  assert.equal(out.totals['rami-levy'].totalWithDelivery, 51.9);
  assert.equal(out.overall.withDelivery, undefined);
  assert.equal(out.split.withDelivery, undefined);
  assert.ok(out.notes.some((n) => n.includes('delivery fee of Shufersal is unknown')));

  const throwing = await compareBasket([store('shufersal')], { items }, { cache: new SearchCache(), delivery: () => { throw new Error('boom'); } });
  assert.equal(throwing.totals.shufersal.delivery, undefined);

  const plain = await compareBasket([store('shufersal'), store('rami-levy')], { items }, { cache: new SearchCache() });
  assert.equal(plain.totals.shufersal.delivery, undefined);
  assert.equal(plain.notes[0], 'Delivery fees, minimum order amounts and club prices are not included.');
});

test('fetchShufersalDeliveryFee reads the slot list with the saved session', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie });
    if (req.url.includes('broken')) return res.writeHead(302, { location: '/login' }).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ 20261127: [{ selectable: true, price: { value: 35.9 } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-')), 'cookies.json');
  fs.writeFileSync(file, JSON.stringify({ cookies: [{ name: 'JSESSIONID', value: 'v', domain: '127.0.0.1', path: '/', expires: -1 }] }));
  try {
    assert.equal(await fetchShufersalDeliveryFee({ cookieFile: file, origin }), 35.9);
    assert.match(seen[0].url, /getHomeDeliverySlots/);
    assert.equal(seen[0].cookie, 'JSESSIONID=v');
    assert.equal(await fetchShufersalDeliveryFee({ cookieFile: file, origin: `${origin}/broken` }), null);
    assert.equal(await fetchShufersalDeliveryFee({}), null);
    fs.writeFileSync(file, JSON.stringify({ cookies: [] }));
    assert.equal(await fetchShufersalDeliveryFee({ cookieFile: file, origin }), null);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
