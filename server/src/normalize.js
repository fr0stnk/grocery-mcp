/**
 * Turns each store's search output into one shape:
 *   { store, productId, barcode, name, brand, size, price, pricePerUnit, perUnit, inStock }
 * plus `promotions` and `soldByWeight` when they apply.
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

/** A retail barcode (EAN-8, UPC-A, EAN-13 or GTIN-14); store-internal codes such as produce PLUs return null. */
export function barcodeOf(value) {
  const digits = String(value ?? '').trim().replace(/^P_/, '');
  return /^(\d{8}|\d{12,14})$/.test(digits) ? digits : null;
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

function item(store, { productId, barcode = null, name, brand = null, sizeText, price, inStock = null, byWeight = false, pricedPerKg = false, promotions = [] }) {
  const p = parsePrice(price);
  // A weighed item's price is per kilogram when the store says so; otherwise
  // it is not tied to the pack size, so no unit price is derived.
  const size = byWeight ? null : (parseSize(sizeText) ?? parseSize(name));
  let unitPrice = null;
  let perUnit = null;
  if (byWeight && pricedPerKg && p != null) [unitPrice, perUnit] = [p, 'kg'];
  else if (size && p != null) [unitPrice, perUnit] = [round(p / size.amount), size.unit];
  return {
    store,
    productId: String(productId),
    barcode,
    name: name ?? '',
    brand: brand || null,
    size: size?.label ?? null,
    price: p,
    pricePerUnit: unitPrice,
    perUnit,
    inStock,
    ...(promotions.length ? { promotions } : {}),
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
      barcode: barcodeOf(p.code),
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

/**
 * Rami Levy's promotion records, e.g. { cmt: 4, scm: 10, label: "4 for 10" }:
 * cmt is the quantity and scm the price for that quantity.
 */
export function parsePromotions(sale) {
  if (!Array.isArray(sale)) return [];
  return sale
    .filter((s) => s && s.active !== 0 && !s.deleted_at)
    .map((s) => {
      const quantity = Number(s.cmt) > 0 ? Number(s.cmt) : null;
      const total = Number(s.scm) > 0 ? Number(s.scm) : null;
      return {
        text: s.label || s.name || '',
        quantity,
        price: total,
        unitPrice: quantity && total ? round(total / quantity) : null,
        until: typeof s.to === 'string' ? s.to.slice(0, 10) : null,
        clubOnly: Boolean(s.is_club),
        personal: Boolean(s.is_personal),
      };
    })
    .filter((s) => s.text);
}

/** Rami Levy's public catalog API: { data: [{ id, barcode, name, price: { price }, prop: { by_kilo }, sale: [...] }] }. */
export function normalizeRamiCatalog(data) {
  if (!data || !Array.isArray(data.data)) throw new StoreError('rami-levy: catalog response has no data array');
  return data.data.map((p) =>
    item('rami-levy', {
      productId: p.id,
      barcode: barcodeOf(p.barcode),
      name: p.name,
      price: p.price?.price,
      byWeight: Number(p.prop?.by_kilo) === 1,
      pricedPerKg: true,
      promotions: parsePromotions(p.sale),
    }),
  );
}

/** Cheapest per liter or kilogram first, then by price; items without a price go last. */
export function compareItems(a, b) {
  const key = (x) => [x.pricePerUnit ?? Infinity, x.price ?? Infinity];
  const [a1, a2] = key(a);
  const [b1, b2] = key(b);
  return a1 - b1 || a2 - b2;
}
