/**
 * Turns each adapter's search output into one shape:
 *   { store, productId, name, brand, size, price, pricePerUnit, perUnit, inStock }
 * Prices are numbers in shekels. Missing data is null, never guessed.
 */

export class StoreError extends Error {}

// Longer spellings come first so "ליטר" is not read as "ל" followed by text.
const UNITS = [
  ['מ"ל', 'L', 0.001], ["מ''ל", 'L', 0.001], ['מל', 'L', 0.001],
  ['ליטר', 'L', 1], ['ליט', 'L', 1], ['לי', 'L', 1], ["ל'", 'L', 1], ['ל', 'L', 1],
  ['ק"ג', 'kg', 1], ["ק''ג", 'kg', 1], ['קג', 'kg', 1], ['קילו', 'kg', 1],
  ['גרם', 'kg', 0.001], ["גר'", 'kg', 0.001], ['גר', 'kg', 0.001], ["ג'", 'kg', 0.001], ['ג', 'kg', 0.001],
];
const UNIT_BY_TOKEN = new Map(UNITS.map(([token, unit, factor]) => [token, { unit, factor }]));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// JavaScript's \b does not work with Hebrew letters, so the unit must be
// followed by the end of the text or by a separator.
const SIZE_RE = new RegExp(
  String.raw`(?:(\d+)\s*[*xX×]\s*)?(\d+(?:[.,]\d+)?)\s*(${UNITS.map(([t]) => escape(t)).join('|')})(?=$|[\s,.;:)\-/])`,
  'u',
);

/** Reads a pack size such as "2 ליטר", "1 ל'", "6*200 מ\"ל" or "500 גרם". */
export function parseSize(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.replace(/[״]/g, '"').replace(/[׳]/g, "'");
  const m = SIZE_RE.exec(normalized);
  if (!m) return null;
  const count = m[1] ? Number(m[1]) : 1;
  const value = Number(m[2].replace(',', '.'));
  const { unit, factor } = UNIT_BY_TOKEN.get(m[3]);
  const amount = round(count * value * factor, 4);
  if (!(amount > 0)) return null;
  return { amount, unit, label: `${amount} ${unit}` };
}

export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const m = /\d+(?:[.,]\d+)?/.exec(value.replace(/,(?=\d{3}\b)/g, ''));
  return m ? Number(m[0].replace(',', '.')) : null;
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function item(store, { productId, name, brand = null, sizeText, price, inStock = null, byWeight = false }) {
  const size = parseSize(sizeText) ?? parseSize(name);
  const p = parsePrice(price);
  // A weighed item's price is not tied to the pack size, so no unit price.
  const unitPrice = !byWeight && size && p != null ? round(p / size.amount) : null;
  return {
    store,
    productId: String(productId),
    name: name ?? '',
    brand: brand || null,
    size: size?.label ?? null,
    price: p,
    pricePerUnit: unitPrice,
    perUnit: unitPrice == null ? null : size.unit,
    inStock,
    ...(byWeight ? { soldByWeight: true } : {}),
  };
}

function parseJson(store, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new StoreError(`${store} returned text that is not JSON: ${String(text).slice(0, 200)}`);
  }
}

/** Shufersal search_products: a JSON array of { code, name, brand, unit, price, inStock, sellingMethod }. */
export function normalizeShufersal(text) {
  const data = parseJson('shufersal', text);
  if (!Array.isArray(data)) throw new StoreError(`shufersal: unexpected search result: ${String(text).slice(0, 200)}`);
  return data.map((p) =>
    item('shufersal', {
      productId: p.code,
      name: p.name,
      brand: p.brand,
      sizeText: p.unit,
      price: p.price,
      inStock: typeof p.inStock === 'boolean' ? p.inStock : null,
      byWeight: typeof p.sellingMethod === 'string' && p.sellingMethod !== 'BY_UNIT',
    }),
  );
}

/** Rami Levy rami_levy_search_products: { ok: true, results: [{ productId, name, price }] } or { ok: false, ... }. */
export function normalizeRamiLevy(text) {
  const data = parseJson('rami-levy', text);
  if (!data || data.ok !== true) {
    const reason = data?.error ?? data?.code ?? data?.message ?? JSON.stringify(data).slice(0, 200);
    throw new StoreError(`rami-levy: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
  }
  if (!Array.isArray(data.results)) throw new StoreError('rami-levy: search result has no results array');
  return data.results.map((p) => item('rami-levy', { productId: p.productId, name: p.name, price: p.price }));
}

/** Cheapest per liter or kilogram first, then by price; items without a price go last. */
export function compareItems(a, b) {
  const key = (x) => [x.pricePerUnit ?? Infinity, x.price ?? Infinity];
  const [a1, a2] = key(a);
  const [b1, b2] = key(b);
  return a1 - b1 || a2 - b2;
}
