import { StoreError } from './normalize.js';

const MAX_ITEMS = 60;
// The OpenAI tunnel ends a request after 120 s; stop starting new Rami Levy
// adds before that and report the rest as not added.
const RAMI_BUDGET_MS = 90_000;

export const ADD_BASKET_TOOL = {
  name: 'add_basket_to_cart',
  title: 'Add a basket to one store\'s cart',
  description:
    'Add several products to one store\'s real cart in a single step, usually the chosen store\'s offers from compare_basket. ' +
    'Pass each offer\'s productId and quantity; for Rami Levy also its name and price exactly as returned. ' +
    'Use dry_run: true to preview without changing the cart. Quantities are added to what is already in the cart. ' +
    'Shufersal only takes whole units here (weighed items are added in its app). Nothing is ordered or paid: the user finishes checkout ' +
    'in the store\'s app or site. Show the user the list and store before calling.',
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
            productId: { type: 'string', minLength: 1, description: 'The offer\'s productId (P_… for Shufersal)' },
            quantity: { type: 'number', exclusiveMinimum: 0, maximum: 100, default: 1 },
            name: { type: 'string', description: 'Required for Rami Levy: the offer\'s name' },
            price: { type: 'number', minimum: 0, description: 'Required for Rami Levy: the offer\'s price' },
          },
          required: ['productId'],
          additionalProperties: false,
        },
      },
      dry_run: { type: 'boolean', default: false, description: 'Only report what would be added' },
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

function validate(args) {
  if (!['shufersal', 'rami-levy'].includes(args.store)) throw new StoreError('store must be shufersal or rami-levy');
  if (!Array.isArray(args.items) || !args.items.length) throw new StoreError('items must be a non-empty list');
  if (args.items.length > MAX_ITEMS) throw new StoreError(`at most ${MAX_ITEMS} items at once`);
  return args.items.map((it, i) => {
    const productId = typeof it?.productId === 'string' ? it.productId.trim() : '';
    const quantity = it.quantity == null ? 1 : Number(it.quantity);
    if (!productId) throw new StoreError(`item ${i + 1} needs a productId`);
    if (!(quantity > 0 && quantity <= 100)) throw new StoreError(`item ${i + 1}: quantity must be above 0 and at most 100`);
    if (args.store === 'shufersal') {
      if (!/^P_\d+$/i.test(productId)) throw new StoreError(`item ${i + 1}: ${productId} is not a Shufersal code like P_4131074`);
      if (!Number.isInteger(quantity)) throw new StoreError(`item ${i + 1}: Shufersal needs whole units; add weighed items in its app`);
    } else if (typeof it.name !== 'string' || !it.name.trim() || typeof it.price !== 'number' || !(it.price >= 0)) {
      throw new StoreError(`item ${i + 1}: Rami Levy needs the offer's name and price as returned by compare_basket`);
    }
    return { productId, quantity, name: it.name?.trim(), price: it.price };
  });
}

export async function addBasketToCart(stores, args = {}, { now = () => Date.now() } = {}) {
  const items = validate(args);
  const store = stores.find((s) => s.id === args.store);
  if (!store) throw new StoreError(`${args.store} is not configured on this server`);
  const dryRun = Boolean(args.dry_run);

  if (store.id === 'shufersal') {
    // The adapter adds a whole list in one request.
    const result = await store.callTool('add_to_cart', {
      items: items.map((it) => ({ code: it.productId.toUpperCase(), quantity: it.quantity })),
      dry_run: dryRun,
    });
    if (result.isError) throw new StoreError(`Shufersal: ${String(parseText(result)).slice(0, 500)}`);
    return { store: store.id, dryRun, requested: items.length, result: parseText(result) };
  }

  if (dryRun) return { store: store.id, dryRun, requested: items.length, wouldAdd: items };

  // Rami Levy adds one product per call, and each call syncs the whole cart.
  const started = now();
  const results = [];
  for (const it of items) {
    if (now() - started > RAMI_BUDGET_MS) {
      results.push({ productId: it.productId, added: false, error: 'not attempted: time budget reached; add the rest in a second call' });
      continue;
    }
    try {
      const result = await store.callTool('rami_levy_add_item', { productId: it.productId, name: it.name, price: it.price, qty: it.quantity });
      const body = parseText(result);
      const ok = !result.isError && body?.ok !== false;
      results.push({ productId: it.productId, name: it.name, quantity: it.quantity, added: ok, ...(ok ? {} : { error: typeof body === 'string' ? body.slice(0, 300) : body?.error ?? body }) });
    } catch (error) {
      results.push({ productId: it.productId, name: it.name, quantity: it.quantity, added: false, error: error.message });
    }
  }
  const added = results.filter((r) => r.added).length;
  return { store: store.id, dryRun, requested: items.length, added, failed: items.length - added, results };
}
