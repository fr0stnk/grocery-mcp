import { StoreError } from './normalize.js';

export const KEY_SCHEMA = {
  type: 'string', minLength: 1, maxLength: 128,
  description: 'Rami Levy only. Reuse this key to retry the same addition. Use a new key for an intentional new addition. Previews do not reserve keys.',
};

const DIRECT_ADDS = ['rami_levy_add_item', 'rami_levy_add_items', 'rami_levy_reorder_from_history'];
export const RAMI_ADDS = new Set(DIRECT_ADDS);
export const RAMI_CART_WRITES = new Set([...DIRECT_ADDS, 'rami_levy_remove_item', 'rami_levy_clear_cart']);

const invalid = (message) => new StoreError(message, 'INVALID_ARGUMENT');

export function requestKey(args, allowed) {
  if (!Object.hasOwn(args, 'idempotency_key')) return null;
  if (!allowed) throw invalid('idempotency_key is supported only for Rami Levy additions');
  const key = args.idempotency_key;
  if (typeof key !== 'string' || !key.trim() || [...key].length > 128) {
    throw invalid('idempotency_key must be a non-empty string of at most 128 characters');
  }
  return key;
}

function item(value) {
  const { productId, name, price, qty = 1 } = value ?? {};
  if (typeof productId !== 'string' || !productId || typeof name !== 'string' || !name ||
      !Number.isFinite(price) || price < 0 || !Number.isFinite(qty) || qty <= 0) {
    throw invalid('items require a productId, name, nonnegative price and positive qty');
  }
  return { productId, name, price, qty };
}

export function normalizeRamiArgs(operation, args) {
  switch (operation) {
    case 'rami_levy_add_item':
      return item(args);
    case 'rami_levy_add_items':
      if (!Array.isArray(args.items) || !args.items.length || args.items.length > 100) throw invalid('items must hold 1 to 100 products');
      return { items: args.items.map(item) };
    case 'rami_levy_reorder_from_history': {
      const { numOrders = 10, minOccurrences = 3 } = args;
      if (!Number.isInteger(numOrders) || numOrders < 1 || numOrders > 50 ||
          !Number.isInteger(minOccurrences) || minOccurrences < 1 || minOccurrences > numOrders) {
        throw invalid('numOrders must be 1 to 50 and minOccurrences must be 1 to numOrders');
      }
      return { numOrders, minOccurrences };
    }
    case 'rami_levy_remove_item':
      if (typeof args.productId !== 'string' || !args.productId) throw invalid('productId is required');
      return { productId: args.productId };
    case 'rami_levy_clear_cart':
      return {};
    default:
      throw invalid('Unsupported Rami Levy cart operation');
  }
}
