import { StoreError } from './normalize.js';
import { packsFor } from './basket.js';
import { searchCache, searchStore } from './search.js';

const MAX_ITEMS = 60;
const SHUFERSAL_MAX_QUANTITY = 30;

export const ADD_BASKET_TOOL = {
  name: 'add_basket_to_cart',
  title: 'Add a basket to one store\'s cart',
  description:
    'Add several products to one store\'s real cart in a single step, usually the chosen store\'s offers from compare_basket. ' +
    'Pass each offer\'s productId and quantity. The server checks every product before anything is added, with the same checks in a dry run: ' +
    'unknown products and out-of-stock items are rejected with a code; for products sold by weight (both stores) quantity is kilograms ' +
    '(Shufersal in 0.5 kg steps), and packs and units take whole numbers: for a compare_basket offer with packs (Shufersal packaged produce), pass packs, not kilograms; ' +
    'and Rami Levy names and prices come from the server\'s own search results rather than the request ' +
    '(a Rami Levy product outside recent results is looked up by its name, and refused as PRODUCT_NOT_VERIFIED if not found). ' +
    'Each item gets a status (added, would-add or rejected); complete is false when anything was rejected. Quantities are added to what is ' +
    'already in the cart. Use dry_run: true to preview. Nothing is ordered or paid. Show the user the list and store before calling.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      store: { type: 'string', enum: ['shufersal', 'rami-levy'] },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ITEMS,
        items: {
          type: 'object',
          properties: {
            productId: { type: 'string', minLength: 1, maxLength: 64, description: 'The offer\'s productId (P_… for Shufersal)' },
            quantity: { type: 'number', exclusiveMinimum: 0, maximum: 100, default: 1, description: 'Units or packs, or kilograms for products sold by weight' },
            name: { type: 'string', description: 'Rami Levy only: the product name, used to look the product up when it is not in recent search results' },
            price: { type: 'number', minimum: 0, description: 'Rami Levy only: the price the user saw; a different current price is reported as priceChanged' },
          },
          required: ['productId'],
          additionalProperties: false,
        },
      },
      dry_run: { type: 'boolean', default: false, description: 'Check and report only; the cart is not changed' },
    },
    required: ['store', 'items'],
    additionalProperties: false,
  },
};

function parseText(result) {
  const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function parseRequest(args) {
  if (!['shufersal', 'rami-levy'].includes(args.store)) throw new StoreError('store must be shufersal or rami-levy', 'INVALID_ARGUMENT');
  if (!Array.isArray(args.items) || !args.items.length) throw new StoreError('items must be a non-empty list', 'INVALID_ARGUMENT');
  if (args.items.length > MAX_ITEMS) throw new StoreError(`at most ${MAX_ITEMS} items at once`, 'INVALID_ARGUMENT');
  return args.items.map((it, i) => {
    const productId = typeof it?.productId === 'string' ? it.productId.trim() : '';
    const quantity = it?.quantity == null ? 1 : Number(it.quantity);
    if (!productId) throw new StoreError(`item ${i + 1} needs a productId`, 'INVALID_ARGUMENT');
    if (!(quantity > 0 && quantity <= 100)) throw new StoreError(`item ${i + 1}: quantity must be above 0 and at most 100`, 'INVALID_QUANTITY');
    return { productId, quantity, name: typeof it.name === 'string' ? it.name.trim() : undefined, price: typeof it.price === 'number' ? it.price : undefined };
  });
}

const reject = (it, code, message) => ({ productId: it.productId, quantity: it.quantity, status: 'rejected', code, message });

/** The product as the server last saw it: fresh search results first, then a live search by its code. */
async function lookup(store, productId, cache) {
  const same = (x) => x.store === store.id && x.productId.toUpperCase() === productId.toUpperCase();
  const cached = cache.findFresh(same);
  if (cached) return cached.item;
  const digits = /^P_(\d+)/i.exec(productId)?.[1];
  if (store.id !== 'shufersal' || !digits) return null;
  // Searching Shufersal for a product's number returns that product.
  try {
    const hit = await searchStore(store, digits, { cache });
    return hit.value.find(same) ?? null;
  } catch {
    return undefined;
  }
}

async function checkShufersal(store, it, cache) {
  if (!/^P_\d+(?:_\d+)?$/i.test(it.productId)) return reject(it, 'UNSUPPORTED_PRODUCT_ID', `${it.productId} is not a Shufersal code like P_4131074 or P_7296073409441_42`);
  const product = await lookup(store, it.productId, cache);
  if (product === undefined) return reject(it, 'STORE_UNAVAILABLE', 'Shufersal could not be searched to check this product');
  if (!product) return reject(it, 'PRODUCT_NOT_FOUND', `${it.productId} was not found in Shufersal's catalog`);
  if (product.inStock === false) return reject(it, 'OUT_OF_STOCK', `${product.name} is out of stock`);
  // Weighed products are added by weight in kg (0.5 kg steps), packs and units in whole numbers.
  const method = product.sellingMethod ?? (product.priceBasis === 'kg' ? 'BY_WEIGHT' : product.priceBasis === 'package' ? 'BY_PACKAGE' : 'BY_UNIT');
  if (method === 'BY_WEIGHT') {
    if (!(it.quantity >= 0.5 && Number.isInteger(it.quantity * 2))) return reject(it, 'INVALID_QUANTITY', `${product.name} is sold by weight in steps of 0.5 kg; give the weight in kg, e.g. 1.5`);
  } else if (!Number.isInteger(it.quantity)) {
    // A kilogram amount for packaged produce: say how many packs that is, the same rounding as compare_basket.
    if (method === 'BY_PACKAGE' && product.packWeightKg) {
      const packs = packsFor(it.quantity, product.packWeightKg);
      return { ...reject(it, 'INVALID_QUANTITY', `${product.name} is sold in packs of about ${product.packWeightKg} kg; ${it.quantity} kg is ${packs} pack${packs === 1 ? '' : 's'}, so pass quantity ${packs}`), suggestedQuantity: packs };
    }
    return reject(it, 'INVALID_QUANTITY', `${product.name} is sold by ${method === 'BY_PACKAGE' ? 'pack' : 'unit'}; use a whole number`);
  }
  const pack = method === 'BY_PACKAGE' && product.packPrice ? { price: product.packPrice, priceBasis: 'package', priceEstimated: true, packWeightKg: product.packWeightKg, pricePerKg: product.price } : {};
  return { ...it, productId: product.productId, name: product.name, price: product.price, priceBasis: product.priceBasis ?? 'unit', sellingMethod: method, priceSource: 'server', ...pack };
}

/**
 * Rami Levy's catalog cannot look up an id. A product outside recent search
 * results is searched for live: by the barcode it had when this server last
 * saw it (price history, two days), otherwise by that name or the caller's.
 */
async function ramiProduct(store, it, cache, history) {
  const known = await lookup(store, it.productId, cache);
  if (known) return known;
  const seen = history ? await history.lastSeen(store.id, it.productId).catch(() => null) : null;
  const queries = [seen?.barcode, it.name, seen?.name].filter(Boolean);
  if (!queries.length) return null;
  try {
    for (const q of [...new Set(queries)]) {
      const hit = await searchStore(store, q, { cache });
      const found = hit.value.find((x) => x.store === store.id && x.productId === it.productId);
      if (found) return found;
    }
    return null;
  } catch {
    return undefined;
  }
}

async function checkRamiLevy(store, it, cache, history) {
  const product = await ramiProduct(store, it, cache, history);
  if (product === undefined) return reject(it, 'STORE_UNAVAILABLE', 'Rami Levy could not be searched to check this product');
  if (!product) {
    return reject(it, 'PRODUCT_NOT_VERIFIED', it.name
      ? `${it.productId} was not found when searching Rami Levy for "${it.name}"; search for the product and use a productId from the results`
      : `${it.productId} has not been seen in searches through this server in the last two days; search for it first, or pass its name so it can be looked up`);
  }
  if (product.inStock === false) return reject(it, 'OUT_OF_STOCK', `${product.name} is not sold at this branch`);
  const basis = product.priceBasis ?? 'unit';
  if (basis === 'unit' && !Number.isInteger(it.quantity)) return reject(it, 'INVALID_QUANTITY', 'this product is sold by unit; use a whole number');
  const changed = it.price != null && Math.abs(it.price - product.price) >= 0.005 ? { priceChanged: { requested: it.price, current: product.price } } : {};
  return { ...it, name: product.name, price: product.price, priceBasis: basis, priceSource: 'server', ...changed };
}

/** Raises a product already in the Shufersal cart by the requested quantity, then checks the cart. */
async function topUpShufersal(store, c, inCart, describe) {
  const target = inCart + c.quantity;
  if (!Number.isFinite(inCart)) return { ...describe(c, 'rejected'), code: 'STORE_REJECTED', message: 'already in the cart, with a quantity Shufersal did not report' };
  if (target > SHUFERSAL_MAX_QUANTITY) {
    return { ...describe(c, 'rejected'), code: 'INVALID_QUANTITY', message: `${inCart} already in the cart; ${target} would exceed Shufersal's limit of ${SHUFERSAL_MAX_QUANTITY}`, cartQuantity: inCart };
  }
  try {
    const result = await store.callTool('set_quantity', { code: c.productId.toUpperCase(), quantity: target });
    const body = parseText(result);
    const now = Array.isArray(body?.products) ? body.products.find((p) => String(p.code).toUpperCase() === c.productId.toUpperCase())?.quantity : undefined;
    if (!result.isError && now === target) return { ...describe(c, 'added'), cartQuantity: target };
    return { ...describe(c, 'rejected'), code: 'STORE_REJECTED', message: `could not raise the quantity from ${inCart} to ${target}`, cartQuantity: now ?? inCart };
  } catch (error) {
    return { ...describe(c, 'rejected'), code: 'STORE_ERROR', message: error.message, cartQuantity: inCart };
  }
}

function summary(store, dryRun, results) {
  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    store,
    dryRun,
    requested: results.length,
    accepted: results.length - count('rejected'),
    rejected: count('rejected'),
    ...(dryRun ? {} : { added: count('added') }),
    complete: results.every((r) => r.status === (dryRun ? 'would-add' : 'added')),
    results,
  };
}

export async function addBasketToCart(stores, args = {}, { cache = searchCache, history = null } = {}) {
  const items = parseRequest(args);
  const store = stores.find((s) => s.id === args.store);
  if (!store) throw new StoreError(`${args.store} is not configured on this server`, 'STORE_UNAVAILABLE');
  const dryRun = Boolean(args.dry_run);

  const check = store.id === 'shufersal' ? checkShufersal : checkRamiLevy;
  const checked = await Promise.all(items.map((it) => check(store, it, cache, history)));
  const valid = checked.filter((c) => c.status !== 'rejected');
  const describe = (c, status) => ({
    productId: c.productId, name: c.name, quantity: c.quantity, price: c.price, priceSource: c.priceSource, status,
    ...(c.packWeightKg ? { priceBasis: 'package', priceEstimated: true, packWeightKg: c.packWeightKg, pricePerKg: c.pricePerKg, estimatedTotal: Math.round(c.quantity * c.price * 100) / 100 } : {}),
    ...(c.priceChanged ? { priceChanged: c.priceChanged } : {}),
  });

  if (dryRun || !valid.length) return summary(store.id, dryRun, checked.map((c) => (c.status === 'rejected' ? c : describe(c, dryRun ? 'would-add' : 'not-attempted'))));

  if (store.id === 'shufersal') {
    // The adapter adds the whole checked list in one request.
    const result = await store.callTool('add_to_cart', {
      items: valid.map((c) => (c.sellingMethod === 'BY_WEIGHT' ? { code: c.productId.toUpperCase(), weight_kg: c.quantity } : { code: c.productId.toUpperCase(), quantity: c.quantity })),
      dry_run: false,
    });
    const body = parseText(result);
    if (result.isError) throw new StoreError(`Shufersal: ${String(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 500)}`, 'STORE_ERROR');
    const lines = Array.isArray(body?.lines) ? body.lines : [];
    const out = [];
    for (const c of checked) {
      if (c.status === 'rejected') {
        out.push(c);
        continue;
      }
      const line = lines.find((l) => String(l.code ?? l.input ?? '').toUpperCase() === c.productId.toUpperCase());
      // The adapter leaves a product already in the cart untouched; this tool adds to it (units and packs: Shufersal changes weights in its app).
      if (line?.status === 'already-in-cart' && c.sellingMethod === 'BY_WEIGHT') out.push({ ...describe(c, 'rejected'), code: 'ALREADY_IN_CART', message: `${c.name} is already in the cart; change its weight in the Shufersal app`, cartQuantity: line.cartQuantity });
      else if (line?.status === 'already-in-cart') out.push(await topUpShufersal(store, c, Number(line.cartQuantity), describe));
      else if (!line || /^(added|would-add)$/.test(line.status ?? 'added')) out.push({ ...describe(c, 'added'), ...(line?.cartQuantity != null ? { cartQuantity: line.cartQuantity } : {}) });
      else out.push({ ...describe(c, 'rejected'), code: 'STORE_REJECTED', message: line.status });
    }
    // The adapter's summary describes its own step only; after top-ups it would contradict the results ("Added 0 of 1").
    const toppedUp = lines.some((l) => l.status === 'already-in-cart');
    return { ...summary(store.id, false, out), ...(body?.summary && !toppedUp ? { storeSummary: body.summary } : {}) };
  }

  // Rami Levy adds the whole checked list with one cart sync.
  const result = await store.callTool('rami_levy_add_items', { items: valid.map((c) => ({ productId: c.productId, name: c.name, price: c.price, qty: c.quantity })) });
  const body = parseText(result);
  const refused = new Set(body?.reason === 'items_rejected' && Array.isArray(body.rejected) ? body.rejected.map((r) => String(r.productId)) : []);
  if (result.isError || (body?.ok !== true && !refused.size)) {
    const reason = typeof body === 'string' ? body : [body?.reason, body?.details ?? body?.message].filter(Boolean).join(': ');
    throw new StoreError(`Rami Levy: ${String(reason || JSON.stringify(body)).slice(0, 500)}`, 'STORE_ERROR', { retryable: body?.reason === 'network_error' });
  }
  const out = checked.map((c) => {
    if (c.status === 'rejected') return c;
    return refused.has(c.productId) ? { ...describe(c, 'rejected'), code: 'STORE_REJECTED', message: 'Rami Levy refused this product' } : describe(c, 'added');
  });
  return { ...summary(store.id, false, out), ...(body?.resetAfterOrder ? { resetAfterOrder: body.resetAfterOrder } : {}), serverTotal: body?.serverTotal ?? null };
}
