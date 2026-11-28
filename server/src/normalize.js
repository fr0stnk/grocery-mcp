/**
 * Turns each store's search output into one shape:
 *   { store, productId, barcode, name, brand, size, price, pricePerUnit, perUnit, inStock }
 * plus `promotions` and `soldByWeight` when they apply.
 * Prices are numbers in shekels. Missing data is null, never guessed.
 */

/** An error the client can act on; `code` is stable, e.g. PRODUCT_NOT_FOUND or INVALID_ARGUMENT. */
export class StoreError extends Error {
  constructor(message, code = 'STORE_ERROR', { retryable = false } = {}) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

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

const PACK_OF_RE = /(\d+)\s*(שקיקים|שקיות|מעטפות|יחידות|יח'?)\s*[*xX×]\s*/u;
// Tea bags in one box are its contents, not a multipack of separate products.
const BAG_WORDS = /^(?:שקיקים|שקיות|מעטפות)$/u;
// Words that make a size the size of each item in a pack: "שישייה 1.5 ליטר" is six 1.5 L bottles.
const PACK_WORDS = [[/שישי(?:י)?(?:ה|ת)/u, 6], [/רביעי(?:י)?(?:ה|ת)/u, 4], [/(?:^|\s)(?:זוג|צמד)(?=\s|$)/u, 2]];

/**
 * Reads a pack size such as "2 ליטר", "1 ל'", "6*200 מ\"ל" or "500 גרם". The
 * amount is the total; a multipack ("6*1.5 ליטר", or a pack word such as
 * "שישייה" beside the size) also gives `pack`, the number of items, and `each`,
 * the size of one.
 */
export function parseSize(text) {
  if (typeof text !== 'string') return null;
  // "25 שקיקים*2 גרם" is 25 bags of 2 g each, written like "25*2 גרם".
  const quoted = text.replace(/[״]/g, '"').replace(/[׳]/g, "'");
  const bags = BAG_WORDS.test(PACK_OF_RE.exec(quoted)?.[2] ?? '');
  const normalized = quoted.replace(PACK_OF_RE, '$1*');
  const m = SIZE_RE.exec(normalized);
  if (!m) return null;
  const value = Number(m[2].replace(',', '.'));
  const count = m[1] ? Number(m[1]) : (PACK_WORDS.find(([re]) => re.test(normalized))?.[1] ?? 1);
  const { unit, factor } = UNIT_BY_TOKEN.get(m[3]);
  const amount = round(count * value * factor, 4);
  if (!(amount > 0)) return null;
  const each = round(value * factor, 4);
  return { amount, unit, label: `${amount} ${unit}`, ...(count > 1 ? { pack: count, each: `${each} ${unit}`, ...(bags ? { bags: true } : {}) } : {}) };
}

const COUNT_RE = /(\d+)\s*(?:יחידות|יחי'|יח'|יח|שקיקים|שקיות|מעטפות|גלילים|גליל)(?=$|[\s,.;:)\-/*])/u;

/** Reads a pack count such as "12 יחידות" or "ביצים 12 יח גדול L"; a single unit returns null. */
export function parseCount(text) {
  if (typeof text !== 'string') return null;
  const m = COUNT_RE.exec(text.replace(/[׳]/g, "'"));
  const n = m ? Number(m[1]) : NaN;
  return n > 1 && n <= 500 ? n : null;
}

/** A retail barcode (EAN-8, UPC-A, EAN-13 or GTIN-14); store-internal codes such as produce PLUs return null. */
export function barcodeOf(value) {
  const digits = String(value ?? '').trim().replace(/^P_/, '');
  return /^(\d{8}|\d{12,14})$/.test(digits) ? digits : null;
}

/** True when the last digit of a GTIN is its correct GS1 check digit. */
export function gs1Valid(code) {
  if (!/^\d{8,14}$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/**
 * Shufersal's barcode for a product code. Many Israeli products use 7-digit
 * codes that are the tail of an EAN-13 beginning with 729000 (P_4131074 is
 * 7290004131074). That barcode is inferred only when its check digit is valid,
 * and the result says so.
 */
export function shufersalBarcode(code) {
  const digits = String(code ?? '').trim().replace(/^P_/i, '');
  const direct = barcodeOf(digits);
  if (direct) return { barcode: direct, inferred: false };
  if (/^\d{7}$/.test(digits) && gs1Valid(`729000${digits}`)) return { barcode: `729000${digits}`, inferred: true };
  return { barcode: null, inferred: false };
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

/**
 * priceBasis says what `price` buys: one item ("unit"), one kilogram ("kg"), or
 * one package whose final charge depends on its weight ("package", estimated).
 */
function item(store, { productId, barcode = null, barcodeInferred = false, name, brand = null, sizeText, price, regularPrice = null, sellingMethod = null, inStock = null, byWeight = false, pricedPerKg = false, priceBasis, promotions = [] }) {
  const p = parsePrice(price);
  // A weighed item's price is per kilogram when the store says so; otherwise
  // it is not tied to the pack size, so no unit price is derived.
  const size = byWeight ? null : (parseSize(sizeText) ?? parseSize(name));
  // Approximate counts on weighed produce ("כ-4 יחידות") are not pack counts.
  const count = byWeight || size ? null : (parseCount(sizeText) ?? parseCount(name));
  let unitPrice = null;
  let perUnit = null;
  if (byWeight && pricedPerKg && p != null) [unitPrice, perUnit] = [p, 'kg'];
  else if (size && p != null) [unitPrice, perUnit] = [round(p / size.amount), size.unit];
  else if (count && p != null) [unitPrice, perUnit] = [round(p / count), 'pc'];
  const basis = priceBasis ?? (!byWeight ? 'unit' : pricedPerKg ? 'kg' : 'package');
  return {
    store,
    productId: String(productId),
    barcode,
    ...(barcodeInferred ? { barcodeInferred: true } : {}),
    name: name ?? '',
    brand: brand || null,
    size: size?.label ?? (count ? `${count} pcs` : null),
    ...(count ? { count } : {}),
    ...(size?.pack && !size.bags ? { packCount: size.pack, itemSize: size.each } : {}),
    price: p,
    ...(regularPrice != null && p != null && regularPrice > p + 0.005 ? { regularPrice } : {}),
    priceBasis: basis,
    ...(basis === 'package' ? { priceEstimated: true } : {}),
    pricePerUnit: unitPrice,
    perUnit,
    inStock,
    ...(promotions.length ? { promotions } : {}),
    ...(byWeight ? { soldByWeight: true } : {}),
    ...(sellingMethod && sellingMethod !== 'BY_UNIT' ? { sellingMethod } : {}),
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
      ...(({ barcode, inferred }) => ({ barcode, barcodeInferred: inferred }))(shufersalBarcode(p.code)),
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

const KG = 'ק["״]?ג';

/**
 * Shufersal's promotion text. Recognised wordings: "3 יח' ב- 15 ₪" (3 units
 * for 15), "3 ק"ג ב- 49.98 ₪" (3 kg for 49.98) and "ב- 69.90 ₪ לק"ג" (69.90
 * per kg). Weight offers carry perUnit "kg"; other wordings keep only the text.
 */
export function parseShufersalPromotion(message) {
  if (typeof message !== 'string' || !message.trim()) return [];
  const text = message.replace(/\s+/g, ' ').trim();
  const offer = (quantity, price, extra = {}) => [{ text, quantity, price, unitPrice: quantity && price ? round(price / quantity) : null, ...extra, until: null, clubOnly: /מועדון/u.test(text), personal: false }];
  const units = /(\d+)\s*יח'?\s*ב\s*-?\s*(\d+(?:\.\d+)?)\s*₪/u.exec(text);
  if (units) return offer(Number(units[1]), Number(units[2]));
  const weight = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${KG}\\s*ב\\s*-?\\s*(\\d+(?:\\.\\d+)?)\\s*₪`, 'u').exec(text);
  if (weight) return offer(Number(weight[1]), Number(weight[2]), { perUnit: 'kg' });
  const perKg = new RegExp(`ב\\s*-?\\s*(\\d+(?:\\.\\d+)?)\\s*₪\\s*ל${KG}`, 'u').exec(text);
  if (perKg) return [{ text, quantity: null, price: null, unitPrice: Number(perKg[1]), perUnit: 'kg', until: null, clubOnly: /מועדון/u.test(text), personal: false }];
  return offer(null, null);
}

// Shufersal compares prices per valueForComparison of these units, e.g. per 100 גרם.
const COMPARISON_UNITS = { 'גרם': ['kg', 1000], 'ג': ['kg', 1000], 'ק"ג': ['kg', 1], 'קג': ['kg', 1], 'מ"ל': ['L', 1000], 'מל': ['L', 1000], 'ליטר': ['L', 1], 'ל': ['L', 1] };

function officialUnitPrice(p) {
  const value = Number(p.pricePerUnit?.value);
  const per = Number(p.valueForComparison);
  const unit = COMPARISON_UNITS[String(p.unitForComparison ?? '').replace(/[״]/g, '"').trim()];
  if (!(value > 0 && per > 0 && unit)) return null;
  return { pricePerUnit: round((value * unit[1]) / per), perUnit: unit[0] };
}

/** Shufersal's raw search results, read directly: barcode, stock, brand, size and promotions. */
export function normalizeShufersalRaw(results) {
  if (!Array.isArray(results)) throw new StoreError('shufersal: search response has no results array');
  return results
    .filter((p) => p && p.code)
    .map((p) => {
      const method = typeof p.sellingMethod === 'string' ? p.sellingMethod : p.sellingMethod?.code;
      const stock = p.stock?.stockLevelStatus?.code;
      const official = officialUnitPrice(p);
      const price = p.price?.value;
      const promotions = parseShufersalPromotion(p.promotionMsg);
      // Items described as "price by weight" (מחיר לפי משקל) are weighed even when Shufersal lists them BY_PACKAGE.
      const weighed = method === 'BY_WEIGHT' || /לפי משקל/u.test(p.unitDescription ?? '');
      // A weighed item is priced per kilogram when Shufersal's own per-kg comparison price equals its price,
      // or when a per-kg offer explains the difference: then the comparison price is the regular one.
      const promoPerKg = promotions.some((o) => o.perUnit === 'kg' && o.quantity == null && Math.abs(o.unitPrice - Number(price)) < 0.01);
      const perKg = weighed && official?.perUnit === 'kg' && (Math.abs(official.pricePerUnit - Number(price)) < 0.01 || promoPerKg);
      const code = shufersalBarcode(p.ean ?? p.sku ?? p.code);
      const normalized = item('shufersal', {
        productId: p.code,
        barcode: code.barcode,
        barcodeInferred: code.inferred,
        name: p.name,
        brand: p.brandName,
        sizeText: p.unitDescription,
        price,
        regularPrice: perKg ? official.pricePerUnit : null,
        sellingMethod: method ?? null,
        inStock: stock ? stock !== 'outOfStock' : null,
        byWeight: Boolean(method) && method !== 'BY_UNIT',
        pricedPerKg: perKg,
        promotions,
      });
      // When no unit price could be derived, use Shufersal's own comparison price
      // (for packaged produce this is per kilogram).
      if (normalized.pricePerUnit == null && official) Object.assign(normalized, official);
      // A pack with a weight range is priced per kilogram: Shufersal charges price × the pack's
      // actual weight, which its site estimates from the midpoint (900–1100 g at 8.9 is about ₪8.90).
      const [min, max] = [Number(p.minWeight), Number(p.maxWeight)];
      if (method === 'BY_PACKAGE' && min > 0 && max >= min && Number(price) > 0) {
        const packWeightKg = round((min + max) / 2000, 3);
        Object.assign(normalized, { priceBasis: 'kg', priceEstimated: true, pricePerUnit: Number(price), perUnit: 'kg', packWeightKg, packPrice: round(packWeightKg * Number(price)) });
      }
      return normalized;
    });
}

/** Rami Levy's public catalog API: { data: [{ id, barcode, name, price: { price }, prop: { by_kilo }, sale: [...], available_in: [branch ids] }] }. */
export function normalizeRamiCatalog(data, { branch } = {}) {
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
      inStock: branch && Array.isArray(p.available_in) ? p.available_in.map(String).includes(String(branch)) : null,
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
