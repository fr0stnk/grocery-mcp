import { cookieHeader } from './shufersal-search.js';

const ORIGIN = 'https://www.shufersal.co.il';
const CACHE_MS = 60 * 60_000;

/**
 * What each store's own site says when nothing can be read live. Rami Levy has
 * no read-only way to get the fee: it appears only in the response to a cart
 * write, so the figures are the site's, dated so they can be rechecked.
 */
export const SITE_TERMS = {
  'rami-levy': { fee: 35.9, minimumOrder: 50, checked: '2026-11-25' },
};

const ENV_PREFIX = { shufersal: 'GROCERY_SHUFERSAL_', 'rami-levy': 'GROCERY_RAMI_LEVY_' };

function envNumber(env, name) {
  const raw = env[name];
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** The cheapest selectable window in Shufersal's slot list ({ "YYYYMMDD": [slot, ...] }), or null. */
export function cheapestSlotFee(body) {
  const prices = Object.values(body && typeof body === 'object' ? body : {})
    .flat()
    .filter((s) => s && s.selectable !== false && Number.isFinite(s.price?.value))
    .map((s) => s.price.value);
  return prices.length ? Math.min(...prices) : null;
}

/** Shufersal's delivery fee for the account's default address, read from its slot list with the saved session. */
export async function fetchShufersalDeliveryFee({ cookieFile, origin = ORIGIN, timeoutMs = 8_000 } = {}) {
  if (!cookieFile) return null;
  const url = `${origin}/online/he/timeSlot/preselection/getHomeDeliverySlots?amount=1.0&prescription=false`;
  const cookie = cookieHeader(cookieFile, url);
  if (!cookie) return null;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: `${origin}/online/he/A`, Cookie: cookie },
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200 || !(response.headers.get('content-type') ?? '').includes('json')) return null;
  return cheapestSlotFee(await response.json());
}

/**
 * Delivery terms per store: { fee, serviceFee?, minimumOrder, source }. A value
 * set in the environment wins; then a live read (Shufersal's slot list); then
 * the store's published figures. What none of them gives is null, never a guess.
 */
export function createDelivery(env = process.env, { fetchShufersalFee = fetchShufersalDeliveryFee, now = Date.now } = {}) {
  const cache = new Map();

  async function liveFee(storeId) {
    if (storeId !== 'shufersal') return null;
    const hit = cache.get(storeId);
    if (hit && now() - hit.at < CACHE_MS) return hit.fee;
    let fee = null;
    try {
      fee = await fetchShufersalFee({ cookieFile: env.SHUFERSAL_COOKIE_FILE, origin: env.GROCERY_SHUFERSAL_ORIGIN || undefined });
    } catch {
      fee = null;
    }
    // A failed read is retried on the next basket rather than cached for an hour.
    if (fee != null) cache.set(storeId, { fee, at: now() });
    return fee;
  }

  return async function deliveryTerms(storeId) {
    const prefix = ENV_PREFIX[storeId];
    if (!prefix) return null;
    const configured = {
      fee: envNumber(env, `${prefix}DELIVERY_FEE`),
      serviceFee: envNumber(env, `${prefix}SERVICE_FEE`),
      minimumOrder: envNumber(env, `${prefix}MINIMUM_ORDER`),
    };
    const site = SITE_TERMS[storeId] ?? {};
    let fee = configured.fee;
    let source = fee != null ? 'configured' : null;
    if (fee == null) {
      fee = await liveFee(storeId);
      if (fee != null) source = 'live';
    }
    if (fee == null && site.fee != null) {
      fee = site.fee;
      source = 'site';
    }
    return {
      fee: fee ?? null,
      ...(configured.serviceFee != null ? { serviceFee: configured.serviceFee } : {}),
      minimumOrder: configured.minimumOrder ?? site.minimumOrder ?? null,
      source: source ?? 'unknown',
      ...(source === 'site' ? { checked: site.checked } : {}),
    };
  };
}
