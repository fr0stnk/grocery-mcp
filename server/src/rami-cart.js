import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StoreError } from './normalize.js';

const HANDLERS = {
  rami_levy_add_item: 'addItem',
  rami_levy_add_items: 'addItems',
  rami_levy_reorder_from_history: 'reorderFromHistory',
  rami_levy_remove_item: 'removeItem',
  rami_levy_clear_cart: 'clearCart',
};

const RESULT_FIELDS = ['ok', 'reason', 'status', 'cartTotal', 'itemCount', 'serverTotal'];
const KNOWN_REASONS = new Set(['items_rejected', 'auth_expired', 'not_found', 'rejected', 'blocked_by_cloudflare',
  'network_error', 'internal_error', 'invalid_args', 'not_in_cart']);

export function safeRamiResult(result, operation, args) {
  const body = JSON.parse(result?.content?.[0]?.text);
  if (typeof body?.ok !== 'boolean') throw new Error('Unexpected Rami Levy cart response');
  const out = {};
  for (const key of RESULT_FIELDS) {
    const value = body[key];
    if (typeof value === 'number' || typeof value === 'boolean' || value === null ||
        (key === 'reason' && KNOWN_REASONS.has(value))) out[key] = value;
  }
  if (typeof body.details === 'string') out.details = 'Rami Levy did not return a usable cart confirmation.';
  if (body.reason === 'not_in_cart') out.productId = args.productId;
  if (operation === 'rami_levy_reorder_from_history' && /^No items appear in \d+\+ of the last \d+ orders$/.test(body.message)) out.message = body.message;
  if (body.resetAfterOrder) {
    const { orderId, createdAt } = body.resetAfterOrder;
    if ((typeof orderId === 'number' || typeof orderId === 'string') && typeof createdAt === 'string') out.resetAfterOrder = { orderId, createdAt };
  }
  for (const key of ['added', 'rejected']) {
    if (!Array.isArray(body[key])) continue;
    out[key] = body[key].map(({ productId, name, qty, price }) => ({
      productId, name, ...(qty != null ? { qty } : {}), ...(price != null ? { price } : {}),
    }));
  }
  return { ...(result.isError ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
}

async function loadAdapter(entry) {
  const directory = path.dirname(entry);
  const [cart, remote, tools] = await Promise.all(['store.js', 'client.js', 'tools.js'].map((name) =>
    import(pathToFileURL(path.join(directory, name)).href)));
  return { CartStore: cart.CartStore, RamiLevyClient: remote.RamiLevyClient, ramiLevyToolHandlers: tools.ramiLevyToolHandlers };
}

/**
 * Runs the pinned adapter handler in the lock holder's process. A caller's
 * MCP timeout cannot release the account while the handler can still send.
 */
export async function executeRamiCart(store, operation, args, observeSync, load = loadAdapter) {
  const env = store.env;
  if (![env.RAMI_LEVY_BEARER_TOKEN, env.RAMI_LEVY_ECOM_TOKEN, env.RAMI_LEVY_USER_AGENT]
    .every((value) => value && value !== 'placeholder') || env.RAMI_LEVY_COOKIE === 'placeholder') {
    throw new StoreError('Rami Levy credentials are unavailable', 'STORE_UNAVAILABLE');
  }

  let cart;
  try {
    const { CartStore, RamiLevyClient, ramiLevyToolHandlers } = await load(store.args[0]);
    const file = path.resolve(store.cwd, env.RAMI_LEVY_DB_PATH || 'cart.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    cart = new CartStore(file);
    const client = new RamiLevyClient({
      bearerToken: env.RAMI_LEVY_BEARER_TOKEN, ecomToken: env.RAMI_LEVY_ECOM_TOKEN,
      userAgent: env.RAMI_LEVY_USER_AGENT, cookie: env.RAMI_LEVY_COOKIE, store: env.RAMI_LEVY_STORE || '412',
    });
    const sync = client.syncCart.bind(client);
    client.syncCart = (items) => observeSync(items, () => sync(items));
    return safeRamiResult(await ramiLevyToolHandlers(cart, client)[HANDLERS[operation]](args), operation, args);
  } finally {
    cart?.close();
  }
}

export const cartJson = (result) => JSON.parse(result.content[0].text);
