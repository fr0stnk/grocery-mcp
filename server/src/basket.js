import { StoreError } from './normalize.js';
import { searchCache, searchStore, selectStores, storeStatus } from './search.js';

const MAX_ITEMS = 40;
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
    'and usual: true adds every preference in the usual basket. To order, pass the chosen store\'s offers to add_basket_to_cart.',
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
    },
    additionalProperties: false,
  },
};

function usable(list) {
  const priced = list.filter((x) => x.price != null);
  const inStock = priced.filter((x) => x.inStock !== false);
  return inStock.length ? inStock : priced;
}

/**
 * Chooses one product per store for an item. A pinned barcode must match
 * exactly. Otherwise a barcode found in every store wins, preferring the one
 * ranked highest by the stores' own relevance; failing that, each store's
 * first usable result.
 */
export function pickMatches(listsByStore, { barcode } = {}) {
  const ids = Object.keys(listsByStore);
  const lists = Object.fromEntries(ids.map((id) => [id, usable(listsByStore[id] ?? [])]));
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
      if (!ranks.every((r) => r.has(code))) continue;
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

function offer(match, quantity) {
  if (!match) return null;
  const clubOffer = match.promotions?.find((p) => p.clubOnly)?.text;
  return {
    productId: match.productId,
    barcode: match.barcode,
    name: match.name,
    price: match.price,
    ...(match.size ? { size: match.size } : {}),
    ...lineCost(match, quantity),
    ...(clubOffer ? { clubOffer } : {}),
    ...(match.soldByWeight ? { soldByWeight: true } : {}),
  };
}

function cheapest(offers) {
  const priced = Object.entries(offers).filter(([, o]) => o);
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
    if (!usual.length) throw new StoreError('no saved preference is marked usual');
    const named = new Set(requested.map((it) => it?.preference?.trim().toLocaleLowerCase()).filter(Boolean));
    for (const p of usual) if (!named.has(p.name.toLocaleLowerCase())) requested.push({ preference: p.name });
  }
  if (!requested.length) throw new StoreError('items must be a non-empty list, or set usual: true');
  if (requested.length > MAX_ITEMS) throw new StoreError(`at most ${MAX_ITEMS} items per basket`);
  return requested.map((it, i) => {
    let { query, barcode, quantity } = it ?? {};
    let preference;
    if (it?.preference) {
      const saved = preferences?.get(it.preference);
      if (!saved) throw new StoreError(`item ${i + 1}: no saved preference named ${JSON.stringify(it.preference)}`);
      preference = saved.name;
      barcode ??= saved.barcode;
      query ??= saved.query;
      quantity ??= saved.quantity;
    }
    barcode = typeof barcode === 'string' && barcode.trim() ? barcode.trim() : undefined;
    query = barcode ?? (typeof query === 'string' ? query.trim() : '');
    if (!query) throw new StoreError(`item ${i + 1} needs a query, a barcode or a preference`);
    quantity = quantity == null ? 1 : Number(quantity);
    if (!(quantity > 0 && quantity <= 100)) throw new StoreError(`item ${i + 1}: quantity must be above 0 and at most 100`);
    return { query, quantity, barcode, ...(preference ? { preference } : {}) };
  });
}

export async function compareBasket(stores, args = {}, { timeoutMs = 45_000, cache = searchCache, preferences = null } = {}) {
  const items = resolveItems(args, preferences);
  const selected = selectStores(stores, args.stores);

  // One search per distinct query and store; the cache also merges repeats.
  const queries = [...new Set(items.map((it) => it.query))];
  const searches = new Map();
  await Promise.all(
    selected.flatMap((store) =>
      queries.map(async (q) => {
        try {
          searches.set(`${store.id}|${q}`, { hit: await searchStore(store, q, { timeoutMs, cache }) });
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

  const lines = items.map((it) => {
    const lists = Object.fromEntries(selected.map((s) => [s.id, searches.get(`${s.id}|${it.query}`)?.hit?.value ?? []]));
    const { matches, identical } = pickMatches(lists, { barcode: it.barcode });
    const offers = Object.fromEntries(selected.map((s) => [s.id, offer(matches[s.id], it.quantity)]));
    return {
      query: it.query,
      ...(it.preference ? { preference: it.preference } : {}),
      quantity: it.quantity,
      ...(it.barcode ? { barcode: it.barcode } : {}),
      identical,
      cheapestStore: cheapest(offers),
      offers,
    };
  });

  const totals = {};
  for (const s of selected) {
    const found = lines.filter((l) => l.offers[s.id]);
    totals[s.id] = {
      total: round(found.reduce((sum, l) => sum + l.offers[s.id].lineTotal, 0)),
      itemsFound: found.length,
      missing: lines.filter((l) => !l.offers[s.id]).map((l) => l.query),
    };
  }

  const common = lines.filter((l) => selected.every((s) => l.offers[s.id]));
  const comparable = { items: common.length, identicalItems: common.filter((l) => l.identical).length };
  for (const s of selected) comparable[s.id] = round(common.reduce((sum, l) => sum + l.offers[s.id].lineTotal, 0));
  if (selected.length > 1 && common.length) {
    const ranked = selected.map((s) => [s.id, comparable[s.id]]).sort((a, b) => a[1] - b[1]);
    comparable.cheaperStore = ranked[0][1] === ranked[1][1] ? null : ranked[0][0];
    comparable.difference = round(ranked.at(-1)[1] - ranked[0][1]);
  }

  const splitLines = lines.filter((l) => Object.values(l.offers).some(Boolean));
  const split = round(splitLines.reduce((sum, l) => sum + Math.min(...Object.values(l.offers).filter(Boolean).map((o) => o.lineTotal)), 0));
  const commonSplit = round(common.reduce((sum, l) => sum + Math.min(...selected.map((s) => l.offers[s.id].lineTotal)), 0));
  const bestSingle = common.length ? Math.min(...selected.map((s) => comparable[s.id])) : null;

  const notes = ['Delivery fees, minimum order amounts and club prices are not included.'];
  if (lines.some((l) => Object.values(l.offers).some((o) => o?.soldByWeight))) notes.push('For weighed items the quantity is kilograms and the price is per kilogram where the store says so.');
  if (lines.some((l) => !l.identical && Object.values(l.offers).filter(Boolean).length > 1)) notes.push('Items with identical: false compare different products; check that they are acceptable substitutes.');
  for (const [id, st] of Object.entries(status)) if (st.stale) notes.push(`${id} did not answer; its prices are cached from ${st.fetchedAt}.`);

  return {
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
