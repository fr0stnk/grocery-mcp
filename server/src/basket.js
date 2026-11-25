import { parseCount, parseSize, shufersalBarcode, StoreError } from './normalize.js';
import { relevantSearch, searchCache, searchStore, selectStores, storeStatus } from './search.js';

const MAX_ITEMS = 40;
const MAX_SOURCE_LINES = 80;
const round = (n) => Math.round(n * 100) / 100;

export const BASKET_TOOL = {
  name: 'compare_basket',
  title: 'Compare a shopping basket',
  description:
    'Price a whole shopping list in Shufersal and Rami Levy and say which store is cheaper. Give each item as a Hebrew search query ' +
    '(translate Russian or English) with a quantity; optionally pin an exact product with a barcode from earlier results. ' +
    'For each item the tool picks a product with the same barcode in every store when one exists (identical: true); otherwise each store\'s most ' +
    'relevant in-stock result (identical: false, so say the products differ). Rami Levy multi-buy promotions are applied when the quantity qualifies; ' +
    'club-only offers are listed but not applied. Returns per-store totals with missing items, a fair comparison over items both stores have, ' +
    'and the total if each item is bought where it is cheapest. Delivery fees and minimum orders are not included. ' +
    'For weighed items (soldByWeight) the quantity is in kilograms. Items may name a saved household preference instead of a query, ' +
    'and usual: true adds every preference in the usual basket. ' +
    'To price a past order in every store ("what would last week\'s order cost at Rami Levy?"), pass source: {store, order: "latest" or an order code}; ' +
    'its lines are matched by barcode where possible, otherwise by name (matchedBy: "name", so say the product may differ), with weighed quantities in kilograms. ' +
    'To order, pass the chosen store\'s offers to add_basket_to_cart.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ITEMS,
        items: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, description: 'Hebrew search terms for the item, e.g. "חלב 3% 1 ליטר"' },
            preference: { type: 'string', minLength: 1, description: 'Name of a saved household preference instead of a query' },
            quantity: { type: 'number', exclusiveMinimum: 0, maximum: 100, description: 'Units, or kilograms for weighed items (default 1, or the preference\'s quantity)' },
            barcode: { type: 'string', description: 'Optional exact product barcode from earlier search results' },
          },
          additionalProperties: false,
        },
      },
      stores: {
        type: 'array',
        items: { type: 'string', enum: ['shufersal', 'rami-levy'] },
        description: 'Only compare these stores (default: all configured stores)',
      },
      usual: { type: 'boolean', description: 'Add every saved preference marked usual' },
      source: {
        type: 'object',
        description: 'Price a past order instead of (or as well as) items',
        properties: {
          store: { type: 'string', enum: ['shufersal', 'rami-levy'] },
          order: { type: 'string', minLength: 1, default: 'latest', description: '"latest" or an order code from the store\'s list_orders' },
        },
        required: ['store'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
};

function usable(list) {
  const priced = list.filter((x) => x.price != null);
  const inStock = priced.filter((x) => x.inStock !== false);
  return inStock.length ? inStock : priced;
}

const GRADE = /^(xs|s|m|l|xl|xxl)$/i;
// How far down each store's list a product sold in every store may be to win.
const SHARED_TOP = 3;

/**
 * What the query pins down beyond its words: a pack size ("1 ליטר"), a count
 * ("ביצים 12") and an egg-style grade ("L"). Products that contradict any of
 * them are not the requested item.
 */
export function constraintsOf(query) {
  const text = String(query ?? '');
  const size = parseSize(text);
  const withoutSize = size ? text.replace(/(\d+(?:[.,]\d+)?)\s*\S+/u, ' ') : text;
  const countMatch = /(?:^|\s)(\d{1,3})(?:\s*(?:יחידות|יח'?))?(?=$|\s)/u.exec(withoutSize);
  const grade = text.split(/\s+/).find((w) => GRADE.test(w));
  return {
    ...(size ? { size } : {}),
    ...(countMatch && !size ? { count: Number(countMatch[1]) } : {}),
    ...(grade ? { grade: grade.toUpperCase() } : {}),
  };
}

/** A product's size from its normalized label ("1 L", "0.5 kg") or, failing that, its name. */
function sizeOf(x) {
  const m = /^(\d+(?:\.\d+)?) (L|kg)$/.exec(x.size ?? '');
  return m ? { amount: Number(m[1]), unit: m[2], label: x.size } : parseSize(x.name ?? '');
}
const close = (a, b) => Math.abs(a - b) <= Math.max(a, b) * 0.02;

/** 'match', 'unknown' (cannot be checked) or a reason the product does not fit. */
export function fitOf(product, constraints) {
  let unknown = false;
  if (constraints.size) {
    const s = sizeOf(product);
    if (!s) unknown = true;
    else if (s.unit !== constraints.size.unit || !close(s.amount, constraints.size.amount)) return `size ${s.label}, not ${constraints.size.label}`;
  }
  if (constraints.count) {
    const n = product.count ?? parseCount(product.name);
    if (n == null) unknown = true;
    else if (n !== constraints.count) return `${n} units, not ${constraints.count}`;
  }
  if (constraints.grade) {
    const grades = String(product.name ?? '').split(/[\s,()]+/).filter((w) => GRADE.test(w)).map((w) => w.toUpperCase());
    if (!grades.length) unknown = true;
    else if (!grades.includes(constraints.grade)) return `grade ${grades.join('/')}, not ${constraints.grade}`;
  }
  return unknown ? 'unknown' : 'match';
}

/**
 * Keeps the products that fit the query's constraints, those that verifiably
 * fit first. `rejected` counts products left out for contradicting them.
 */
function fitting(list, constraints) {
  if (!Object.keys(constraints).length) return { list, rejected: 0 };
  const scored = list.map((x) => [x, fitOf(x, constraints)]);
  const ok = scored.filter(([, f]) => f === 'match').map(([x]) => x);
  const unknown = scored.filter(([, f]) => f === 'unknown').map(([x]) => ({ ...x, fit: 'unverified' }));
  return { list: [...ok, ...unknown], rejected: scored.length - ok.length - unknown.length };
}

/**
 * Chooses one product per store for an item. A pinned barcode must match
 * exactly. Otherwise a barcode found among the top three results of every
 * store wins, preferring the one ranked highest by the stores' own relevance;
 * failing that, each store's first usable result.
 */
export function pickMatches(listsByStore, { barcode, constraints = {} } = {}) {
  const ids = Object.keys(listsByStore);
  const lists = Object.fromEntries(ids.map((id) => [id, barcode ? usable(listsByStore[id] ?? []) : fitting(usable(listsByStore[id] ?? []), constraints).list]));
  if (barcode) {
    const matches = Object.fromEntries(ids.map((id) => [id, lists[id].find((x) => x.barcode === barcode) ?? null]));
    return { matches, identical: ids.length > 1 && ids.every((id) => matches[id]) };
  }
  if (ids.length > 1) {
    const ranks = ids.map((id) => {
      const rank = new Map();
      lists[id].forEach((x, i) => x.barcode && !rank.has(x.barcode) && rank.set(x.barcode, i));
      return rank;
    });
    let best = null;
    for (const [code] of ranks[0]) {
      // A shared barcode far down a store's list is a different kind of product
      // (banana milk for "bananas", whose top results have no barcode).
      if (!ranks.every((r) => r.has(code) && r.get(code) < SHARED_TOP)) continue;
      const score = ranks.reduce((sum, r) => sum + r.get(code), 0);
      if (!best || score < best.score) best = { code, score };
    }
    if (best) {
      return { matches: Object.fromEntries(ids.map((id) => [id, lists[id].find((x) => x.barcode === best.code)])), identical: true };
    }
  }
  return { matches: Object.fromEntries(ids.map((id) => [id, lists[id][0] ?? null])), identical: false };
}

/** Line total for a quantity, applying the cheapest qualifying non-club, non-personal multi-buy promotion. */
export function lineCost(match, quantity) {
  let best = { lineTotal: round(match.price * quantity) };
  for (const p of match.promotions ?? []) {
    if (p.clubOnly || p.personal || !p.quantity || !p.price || quantity < p.quantity) continue;
    const cost = Math.floor(quantity / p.quantity) * p.price + (quantity % p.quantity) * match.price;
    if (cost < best.lineTotal - 0.001) best = { lineTotal: round(cost), promotion: p.text };
  }
  return best;
}

const FRACTIONAL = 'INCOMPATIBLE_QUANTITY_BASIS';

function offer(match, quantity) {
  if (!match) return null;
  // A fractional quantity means kilograms; it cannot be multiplied by a unit or package price.
  if (!Number.isInteger(quantity) && (match.priceBasis ?? 'unit') !== 'kg') return { excluded: FRACTIONAL, productId: match.productId, name: match.name, priceBasis: match.priceBasis ?? 'unit' };
  const clubOffer = match.promotions?.find((p) => p.clubOnly)?.text;
  return {
    productId: match.productId,
    barcode: match.barcode,
    name: match.name,
    price: match.price,
    priceBasis: match.priceBasis ?? 'unit',
    ...(match.priceEstimated ? { priceEstimated: true } : {}),
    ...(match.barcodeInferred ? { barcodeInferred: true } : {}),
    ...(match.size ? { size: match.size } : {}),
    ...(match.count ? { count: match.count } : {}),
    ...(match.fit ? { fit: match.fit } : {}),
    ...lineCost(match, quantity),
    ...(clubOffer ? { clubOffer } : {}),
    ...(match.soldByWeight ? { soldByWeight: true } : {}),
  };
}

const isPriced = (o) => Boolean(o && !o.excluded);

/**
 * Whether different products are still like for like: 'match', or why not
 * ("0.5 kg vs 1 kg", "12 vs 18 units", "kg vs unit"). Only sizes that are
 * known on both sides can differ; unknown sizes count as a match.
 */
function equivalenceOf(offers) {
  if (offers.length < 2) return 'match';
  const [a, b] = offers;
  const kg = (o) => (o.priceBasis ?? 'unit') === 'kg';
  if (kg(a) !== kg(b)) return `${a.priceBasis ?? 'unit'} vs ${b.priceBasis ?? 'unit'}`;
  if (kg(a)) return 'match';
  if (a.count && b.count && a.count !== b.count) return `${a.count} vs ${b.count} units`;
  const sa = sizeOf(a);
  const sb = sizeOf(b);
  if (sa && sb && (sa.unit !== sb.unit || !close(sa.amount, sb.amount))) return `${sa.label} vs ${sb.label}`;
  return 'match';
}

function cheapest(offers) {
  const priced = Object.entries(offers).filter(([, o]) => isPriced(o));
  if (priced.length < 2) return null;
  priced.sort((a, b) => a[1].lineTotal - b[1].lineTotal);
  return priced[0][1].lineTotal === priced[1][1].lineTotal ? null : priced[0][0];
}

/**
 * Turns the request into items with a search query. A saved preference or a
 * pinned barcode is searched by its barcode, which returns exactly that
 * product in every store that sells it.
 */
export function resolveItems(args, preferences) {
  const requested = Array.isArray(args.items) ? [...args.items] : [];
  if (args.usual) {
    const usual = (preferences?.list() ?? []).filter((p) => p.usual);
    if (!usual.length) throw new StoreError('no saved preference is marked usual', 'NOT_FOUND');
    const named = new Set(requested.map((it) => it?.preference?.trim().toLocaleLowerCase()).filter(Boolean));
    for (const p of usual) if (!named.has(p.name.toLocaleLowerCase())) requested.push({ preference: p.name });
  }
  if (!requested.length && !args.source) throw new StoreError('items must be a non-empty list, or set usual: true or a source order', 'INVALID_ARGUMENT');
  if (requested.length > MAX_ITEMS) throw new StoreError(`at most ${MAX_ITEMS} items per basket`, 'INVALID_ARGUMENT');
  return requested.map((it, i) => {
    let { query, barcode, quantity } = it ?? {};
    let preference;
    if (it?.preference) {
      const saved = preferences?.get(it.preference);
      if (!saved) throw new StoreError(`item ${i + 1}: no saved preference named ${JSON.stringify(it.preference)}`, 'NOT_FOUND');
      preference = saved.name;
      barcode ??= saved.barcode;
      query ??= saved.query;
      quantity ??= saved.quantity;
    }
    barcode = typeof barcode === 'string' && barcode.trim() ? barcode.trim() : undefined;
    query = barcode ?? (typeof query === 'string' ? query.trim() : '');
    if (!query) throw new StoreError(`item ${i + 1} needs a query, a barcode or a preference`, 'INVALID_ARGUMENT');
    quantity = quantity == null ? 1 : Number(quantity);
    if (!(quantity > 0 && quantity <= 100)) throw new StoreError(`item ${i + 1}: quantity must be above 0 and at most 100`, 'INVALID_QUANTITY');
    return { query, quantity, barcode, ...(preference ? { preference } : {}) };
  });
}

function parseToolText(result) {
  const text = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callStore(store, tool, args) {
  const result = await store.callTool(tool, args);
  const body = parseToolText(result);
  if (result.isError || body?.ok === false) {
    const why = typeof body === 'string' ? body : [body?.reason, body?.details ?? body?.message].filter(Boolean).join(': ');
    throw new StoreError(`${store.label}: ${String(why || 'request failed').slice(0, 300)}`, /no order|not.?found|rejected/i.test(why) ? 'NOT_FOUND' : 'STORE_ERROR');
  }
  return body;
}

/**
 * Turns a past order into basket items. Each line is searched by barcode when
 * it has one (Shufersal's 7-digit codes give an inferred 729000 barcode) and
 * otherwise by name; the order's own store keeps its product (`pin`).
 * Shufersal reports weighed and packaged lines in grams, compared here in kg.
 */
export async function sourceItems(stores, source) {
  const store = stores.find((s) => s.id === source?.store);
  if (!store) throw new StoreError(`${source?.store} is not configured on this server`, 'STORE_UNAVAILABLE');
  const order = typeof source.order === 'string' && source.order.trim() ? source.order.trim() : 'latest';
  let info;
  let lines;
  if (store.id === 'shufersal') {
    const body = await callStore(store, 'get_order', { order });
    info = { store: store.id, order: body.order?.code ?? order, created: body.order?.created ?? null, paid: body.order?.total ?? null };
    lines = (body.items ?? []).map((i) => {
      const grams = i.unit === 'g' || (i.sellingMethod && i.sellingMethod !== 'BY_UNIT' && i.quantity >= 50);
      const code = shufersalBarcode(i.code);
      // A packaged line (BY_PACKAGE) is one pack of about that weight: priced per kg where a store sells it by weight, otherwise as one pack.
      return { name: i.name, code: i.code, barcode: code.barcode ?? undefined, quantity: grams ? round3(i.quantity / 1000) : i.quantity, ...(grams && i.sellingMethod === 'BY_PACKAGE' ? { packs: 1 } : {}) };
    });
  } else {
    let id = order;
    if (order === 'latest') {
      const list = await callStore(store, 'rami_levy_list_orders', { page: 1 });
      id = list.orders?.[0]?.orderId;
      if (id == null) throw new StoreError('Rami Levy has no past orders on this account', 'NOT_FOUND');
    }
    const body = await callStore(store, 'rami_levy_view_order', { orderId: String(id) });
    info = { store: store.id, order: String(body.orderId ?? id), created: body.createdAt ?? null, paid: body.total ?? null };
    lines = (body.lines ?? []).map((l) => ({ name: l.name, code: String(l.productId), quantity: Number(l.qty) || 1 }));
  }
  if (!lines.length) throw new StoreError(`order ${info.order} has no product lines`, 'NOT_FOUND');
  if (lines.length > MAX_SOURCE_LINES) throw new StoreError(`order ${info.order} has more than ${MAX_SOURCE_LINES} lines`, 'INVALID_ARGUMENT');
  const items = lines
    .filter((l) => l.name && l.quantity > 0 && l.quantity <= 100)
    .map((l) => ({ query: l.barcode ?? l.name, quantity: l.quantity, ...(l.packs ? { packs: l.packs } : {}), ...(l.barcode ? { barcode: l.barcode, fallbackQuery: l.name } : {}), pin: { [store.id]: l.code }, sourceLine: { name: l.name, code: l.code } }));
  return { info, items };
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/** A search hit whose value holds only products related to the query (barcode and number queries are exact already). */
async function relevantHit(store, query, opts) {
  if (/^\d+$/.test(query)) return searchStore(store, query, opts);
  const { hit, items } = await relevantSearch(store, query, opts);
  return { ...hit, value: items };
}

export async function compareBasket(stores, args = {}, { timeoutMs = 45_000, cache = searchCache, preferences = null } = {}) {
  const selected = selectStores(stores, args.stores);
  const fromOrder = args.source ? await sourceItems(stores, args.source) : null;
  const items = [...(args.items?.length || args.usual ? resolveItems(args, preferences) : []), ...(fromOrder?.items ?? [])];
  if (!items.length) throw new StoreError('items must be a non-empty list, or set usual: true or a source order', 'INVALID_ARGUMENT');

  // One search per distinct query and store; the cache also merges repeats.
  const queries = [...new Set(items.map((it) => it.query))];
  const searches = new Map();
  await Promise.all(
    selected.flatMap((store) =>
      queries.map(async (q) => {
        try {
          searches.set(`${store.id}|${q}`, { hit: await relevantHit(store, q, { timeoutMs, cache }) });
        } catch (error) {
          searches.set(`${store.id}|${q}`, { error: error.message });
        }
      }),
    ),
  );

  const status = {};
  for (const store of selected) {
    const outcomes = queries.map((q) => searches.get(`${store.id}|${q}`));
    const failed = outcomes.filter((o) => o.error);
    const hits = outcomes.filter((o) => o.hit).map((o) => o.hit);
    if (!hits.length) {
      status[store.id] = { ok: false, error: failed[0]?.error ?? 'no results' };
      continue;
    }
    const oldest = hits.reduce((a, b) => (a.fetchedAt < b.fetchedAt ? a : b));
    status[store.id] = {
      ...storeStatus({ ...oldest, cached: hits.some((h) => h.cached), stale: hits.some((h) => h.stale) || undefined, error: hits.find((h) => h.stale)?.error }, hits.length),
      ...(failed.length ? { failedSearches: failed.length } : {}),
    };
    delete status[store.id].count;
  }

  // A barcode a store does not stock falls back to searching that store by name.
  const fallbacks = [];
  for (const it of items) {
    for (const s of selected) {
      const list = searches.get(`${s.id}|${it.query}`)?.hit?.value ?? [];
      const pinned = it.pin?.[s.id];
      const found = it.barcode ? list.some((x) => x.barcode === it.barcode) : true;
      if (it.fallbackQuery && (!found || (pinned && !list.some((x) => x.productId === pinned)))) fallbacks.push([s, it.fallbackQuery]);
    }
  }
  await Promise.all(
    [...new Map(fallbacks.map(([s, q]) => [`${s.id}|${q}`, [s, q]])).values()].map(async ([s, q]) => {
      try {
        searches.set(`${s.id}|${q}`, { hit: await relevantHit(s, q, { timeoutMs, cache }) });
      } catch (error) {
        searches.set(`${s.id}|${q}`, { error: error.message });
      }
    }),
  );

  const lines = items.map((it) => {
    // A fractional quantity is kilograms: where a store sells something per kg, choose among those.
    const kgFirst = (list) => (!Number.isInteger(it.quantity) && list.some((x) => x.priceBasis === 'kg') ? list.filter((x) => x.priceBasis === 'kg') : list);
    const lists = Object.fromEntries(selected.map((s) => [s.id, kgFirst(searches.get(`${s.id}|${it.query}`)?.hit?.value ?? [])]));
    const constraints = it.barcode ? {} : constraintsOf(it.query);
    let { matches, identical } = pickMatches(lists, { barcode: it.barcode, constraints });
    const byName = new Set();
    for (const s of selected) {
      const pinned = it.pin?.[s.id];
      const named = it.fallbackQuery ? searches.get(`${s.id}|${it.fallbackQuery}`)?.hit?.value ?? [] : [];
      const own = pinned ? [...lists[s.id], ...named].find((x) => x.productId === pinned && x.price != null) : null;
      if (own && matches[s.id]?.productId !== pinned) {
        matches = { ...matches, [s.id]: own };
        identical = false;
      } else if (!matches[s.id] && named.length) {
        const pick = pickMatches({ [s.id]: named }).matches[s.id];
        if (pick) {
          matches = { ...matches, [s.id]: pick };
          byName.add(s.id);
          identical = false;
        }
      }
    }
    const offers = Object.fromEntries(selected.map((s) => {
      const m = matches[s.id];
      let o = offer(m, it.packs && m && (m.priceBasis ?? 'unit') !== 'kg' ? it.packs : it.quantity);
      if (o && byName.has(s.id)) o = { ...o, matchedBy: 'name' };
      return [s.id, o];
    }));
    // Identity is claimed only for offers that can actually be priced.
    if (identical && !Object.values(offers).every(isPriced)) identical = false;
    const equivalence = identical ? null : equivalenceOf(Object.values(offers).filter(isPriced));
    return {
      query: it.query,
      ...(it.sourceLine ? { sourceLine: it.sourceLine } : {}),
      ...(equivalence && equivalence !== 'match' ? { notEquivalent: equivalence } : {}),
      ...(Object.keys(constraints).length ? { constraints: { ...constraints, ...(constraints.size ? { size: constraints.size.label } : {}) } } : {}),
      ...(it.preference ? { preference: it.preference } : {}),
      quantity: it.quantity,
      ...(it.packs ? { packs: it.packs, note: `about ${it.quantity} kg; stores selling it by weight are priced for that, others for ${it.packs} pack` } : {}),
      ...(it.barcode ? { barcode: it.barcode } : {}),
      identical,
      ...(identical ? { confidence: Object.values(offers).some((o) => o?.barcodeInferred) ? 'inferred' : 'exact' } : {}),
      cheapestStore: cheapest(offers),
      offers,
    };
  });

  const totals = {};
  for (const s of selected) {
    const found = lines.filter((l) => isPriced(l.offers[s.id]));
    const excluded = lines.filter((l) => l.offers[s.id]?.excluded).map((l) => l.query);
    totals[s.id] = {
      total: round(found.reduce((sum, l) => sum + l.offers[s.id].lineTotal, 0)),
      itemsFound: found.length,
      missing: lines.filter((l) => !l.offers[s.id]).map((l) => l.query),
      ...(excluded.length ? { notComparable: excluded } : {}),
    };
  }

  const priceable = lines.filter((l) => selected.every((s) => isPriced(l.offers[s.id])));
  const common = priceable.filter((l) => !l.notEquivalent);
  const comparable = {
    items: common.length,
    identicalItems: common.filter((l) => l.identical).length,
    ...(priceable.length > common.length ? { leftOut: priceable.filter((l) => l.notEquivalent).map((l) => ({ query: l.query, reason: l.notEquivalent })) } : {}),
  };
  for (const s of selected) comparable[s.id] = round(common.reduce((sum, l) => sum + l.offers[s.id].lineTotal, 0));
  if (selected.length > 1 && common.length) {
    const ranked = selected.map((s) => [s.id, comparable[s.id]]).sort((a, b) => a[1] - b[1]);
    comparable.cheaperStore = ranked[0][1] === ranked[1][1] ? null : ranked[0][0];
    comparable.difference = round(ranked.at(-1)[1] - ranked[0][1]);
  }

  const splitLines = lines.filter((l) => Object.values(l.offers).some(isPriced));
  const split = round(splitLines.reduce((sum, l) => sum + Math.min(...Object.values(l.offers).filter(isPriced).map((o) => o.lineTotal)), 0));
  const commonSplit = round(common.reduce((sum, l) => sum + Math.min(...selected.map((s) => l.offers[s.id].lineTotal)), 0));
  const bestSingle = common.length ? Math.min(...selected.map((s) => comparable[s.id])) : null;

  const notes = ['Delivery fees, minimum order amounts and club prices are not included.'];
  if (lines.some((l) => Object.values(l.offers).some((o) => o?.soldByWeight))) notes.push('For weighed items the quantity is kilograms and the price is per kilogram where the store says so.');
  if (lines.some((l) => !l.identical && Object.values(l.offers).filter(isPriced).length > 1)) notes.push('Items with identical: false compare different products; check that they are acceptable substitutes.');
  if (lines.some((l) => l.notEquivalent)) notes.push('Items whose products differ in size, count or how they are sold (notEquivalent) are in each store\'s total but left out of comparable, which is like for like only.');
  if (lines.some((l) => Object.values(l.offers).some((o) => o?.excluded))) notes.push('A fractional quantity is kilograms; products sold by unit or package cannot be priced for it and are listed in notComparable. Ask for whole units, or choose a product sold by weight.');
  if (lines.some((l) => Object.values(l.offers).some((o) => o?.fit === 'unverified'))) notes.push('Offers with fit: unverified could not be checked against the size, count or grade in the query; confirm them.');
  if (lines.some((l) => l.constraints && Object.values(l.offers).some((o) => !o))) notes.push('A store with no product matching the size, count or grade in the query lists the item as missing rather than offering a different one.');
  for (const [id, st] of Object.entries(status)) if (st.stale) notes.push(`${id} did not answer; its prices are cached from ${st.fetchedAt}.`);

  if (fromOrder) notes.push(`Prices are today's, not what order ${fromOrder.info.order} cost; its paid total includes delivery and any weighing differences.`);
  if (lines.some((l) => Object.values(l.offers).some((o) => o?.matchedBy === 'name'))) notes.push('Offers with matchedBy: name were found by product name, not barcode; check they are the same product.');

  return {
    ...(fromOrder ? { source: fromOrder.info } : {}),
    stores: status,
    items: lines,
    totals,
    comparable,
    split: {
      total: split,
      ...(bestSingle != null && selected.length > 1 ? { savingsOnCommonItems: round(bestSingle - commonSplit) } : {}),
    },
    notes,
  };
}
