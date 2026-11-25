import { StoreError } from './normalize.js';
import { searchCache, searchStore } from './search.js';

const MAX_ITEMS = 60;
// The OpenAI tunnel ends a request after 120 s; stop starting new Rami Levy
// adds before that and report the rest as not added.
const RAMI_BUDGET_MS = 90_000;

export const ADD_BASKET_TOOL = {
  name: 'add_basket_to_cart',
  title: 'Add a basket to one store\'s cart',
  description:
    'Add several products to one store\'s real cart in a single step, usually the chosen store\'s offers from compare_basket. ' +
    'Pass each offer\'s productId and quantity. The server checks every product before anything is added, with the same checks in a dry run: ' +
    'unknown products, out-of-stock items and (for Shufersal) items sold by weight or package are rejected with a code, ' +
    'and Rami Levy names and prices come from the server\'s own search results rather than the request. ' +
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
            quantity: { type: 'number', exclusiveMinimum: 0, maximum: 100, default: 1, description: 'Units, or kilograms for Rami Levy items priced per kg' },
            name: { type: 'string', description: 'Rami Levy only, used when the product is not in recent search results' },
            price: { type: 'number', minimum: 0, description: 'Rami Levy only, used when the product is not in recent search results' },
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
  if (!Number.isInteger(it.quantity)) return reject(it, 'INVALID_QUANTITY', 'Shufersal needs whole units here');
  const product = await lookup(store, it.productId, cache);
  if (product === undefined) return reject(it, 'STORE_UNAVAILABLE', 'Shufersal could not be searched to check this product');
  if (!product) return reject(it, 'PRODUCT_NOT_FOUND', `${it.productId} was not found in Shufersal's catalog`);
  if (product.inStock === false) return reject(it, 'OUT_OF_STOCK', `${product.name} is out of stock`);
  if (product.priceBasis && product.priceBasis !== 'unit') return reject(it, 'UNSUPPORTED_SELLING_METHOD', `${product.name} is sold by ${product.priceBasis === 'kg' ? 'weight' : 'package'}; add it in the Shufersal app`);
  return { ...it, productId: product.productId, name: product.name, price: product.price, priceBasis: 'unit', priceSource: 'server' };
}

async function checkRamiLevy(store, it, cache) {
  const product = await lookup(store, it.productId, cache);
  if (product?.inStock === false) return reject(it, 'OUT_OF_STOCK', `${product.name} is not sold at this branch`);
  const basis = product?.priceBasis ?? 'unit';
  if (basis === 'unit' && !Number.isInteger(it.quantity)) return reject(it, 'INVALID_QUANTITY', 'this product is sold by unit; use a whole number');
  if (product) {
    const changed = it.price != null && Math.abs(it.price - product.price) >= 0.005 ? { priceChanged: { requested: it.price, current: product.price } } : {};
    return { ...it, name: product.name, price: product.price, priceBasis: basis, priceSource: 'server', ...changed };
  }
  if (!it.name || it.price == null) return reject(it, 'MISSING_OFFER_DETAILS', 'not in recent search results; search for it first or pass its name and price');
  return { ...it, priceBasis: basis, priceSource: 'client' };
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

export async function addBasketToCart(stores, args = {}, { now = () => Date.now(), cache = searchCache } = {}) {
  const items = parseRequest(args);
  const store = stores.find((s) => s.id === args.store);
  if (!store) throw new StoreError(`${args.store} is not configured on this server`, 'STORE_UNAVAILABLE');
  const dryRun = Boolean(args.dry_run);

  const check = store.id === 'shufersal' ? checkShufersal : checkRamiLevy;
  const checked = await Promise.all(items.map((it) => check(store, it, cache)));
  const valid = checked.filter((c) => c.status !== 'rejected');
  const describe = (c, status) => ({ productId: c.productId, name: c.name, quantity: c.quantity, price: c.price, priceSource: c.priceSource, status, ...(c.priceChanged ? { priceChanged: c.priceChanged } : {}) });

  if (dryRun || !valid.length) return summary(store.id, dryRun, checked.map((c) => (c.status === 'rejected' ? c : describe(c, dryRun ? 'would-add' : 'not-attempted'))));

  if (store.id === 'shufersal') {
    // The adapter adds the whole checked list in one request.
    const result = await store.callTool('add_to_cart', { items: valid.map((c) => ({ code: c.productId.toUpperCase(), quantity: c.quantity })), dry_run: false });
    const body = parseText(result);
    if (result.isError) throw new StoreError(`Shufersal: ${String(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 500)}`, 'STORE_ERROR');
    const lines = Array.isArray(body?.lines) ? body.lines : [];
    const out = checked.map((c) => {
      if (c.status === 'rejected') return c;
      const line = lines.find((l) => String(l.code ?? l.input ?? '').toUpperCase() === c.productId.toUpperCase());
      const ok = !line || /^(added|would-add|already-in-cart)$/.test(line.status ?? 'added');
      return ok ? describe(c, 'added') : { ...describe(c, 'rejected'), code: 'STORE_REJECTED', message: line.status };
    });
    return { ...summary(store.id, false, out), storeSummary: body?.summary };
  }

  // Rami Levy adds one product per call, and each call syncs the whole cart.
  const started = now();
  const out = [];
  for (const c of checked) {
    if (c.status === 'rejected') {
      out.push(c);
      continue;
    }
    if (now() - started > RAMI_BUDGET_MS) {
      out.push({ ...describe(c, 'rejected'), code: 'TIME_BUDGET', message: 'not attempted: time budget reached; add the rest in a second call' });
      continue;
    }
    try {
      const result = await store.callTool('rami_levy_add_item', { productId: c.productId, name: c.name, price: c.price, qty: c.quantity });
      const body = parseText(result);
      if (!result.isError && body?.ok !== false) out.push(describe(c, 'added'));
      else out.push({ ...describe(c, 'rejected'), code: 'STORE_REJECTED', message: typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body?.error ?? body).slice(0, 300) });
    } catch (error) {
      out.push({ ...describe(c, 'rejected'), code: 'STORE_ERROR', message: error.message });
    }
  }
  return summary(store.id, false, out);
}
