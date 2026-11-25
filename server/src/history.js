import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { barcodeOf, StoreError } from './normalize.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const KEEP_DAYS = 400;
const DAY_MS = 86_400_000;
const round = (n) => Math.round(n * 100) / 100;

export function historyFile(env = process.env) {
  return env.GROCERY_HISTORY_FILE || path.join(env.GROCERY_DATA_DIR || path.join(repoRoot, '.data'), 'price-history.db');
}

/** Israel's calendar day, so a price seen at 01:00 local time counts for that day. */
export function dayOf(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/**
 * One row per store, product and day: the last price seen that day. Every
 * fresh search result is recorded, so history grows with use; the daily
 * tracker adds the household's saved preferences. Several processes (the HTTP
 * server and one-shot stdio runs) may share the file, which WAL mode allows.
 */
export class PriceHistory {
  #db = null;

  constructor(file = historyFile(), { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
  }

  async #open() {
    if (this.#db) return this.#db;
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec(`CREATE TABLE IF NOT EXISTS prices (
      store TEXT NOT NULL, product_id TEXT NOT NULL, day TEXT NOT NULL,
      barcode TEXT, name TEXT NOT NULL, price REAL NOT NULL, regular_price REAL,
      price_basis TEXT, promotion TEXT, seen_at TEXT NOT NULL,
      PRIMARY KEY (store, product_id, day))`);
    db.exec('CREATE INDEX IF NOT EXISTS prices_barcode ON prices (barcode, day)');
    db.prepare('DELETE FROM prices WHERE day < ?').run(dayOf(this.now() - KEEP_DAYS * DAY_MS));
    this.#db = db;
    return db;
  }

  /** Records search results; failures are reported but never break a search. */
  async record(items) {
    const rows = (items ?? []).filter((x) => x?.store && x.productId && typeof x.price === 'number' && x.price > 0);
    if (!rows.length) return 0;
    const db = await this.#open();
    const at = new Date(this.now());
    const day = dayOf(at.getTime());
    const upsert = db.prepare(`INSERT INTO prices (store, product_id, day, barcode, name, price, regular_price, price_basis, promotion, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (store, product_id, day) DO UPDATE SET barcode = excluded.barcode, name = excluded.name, price = excluded.price,
        regular_price = excluded.regular_price, price_basis = excluded.price_basis, promotion = excluded.promotion, seen_at = excluded.seen_at`);
    db.exec('BEGIN');
    try {
      for (const x of rows) {
        const promo = x.promotions?.find((p) => !p.clubOnly && !p.personal)?.text ?? null;
        upsert.run(x.store, String(x.productId), day, x.barcode ?? null, x.name ?? '', x.price, x.regularPrice ?? null, x.priceBasis ?? null, promo, at.toISOString());
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  }

  /** Daily rows for a barcode (every store) or one store's product, oldest first. */
  async rows({ barcode, store, productId, days }) {
    const db = await this.#open();
    const since = dayOf(this.now() - days * DAY_MS);
    if (barcode) return db.prepare('SELECT * FROM prices WHERE barcode = ? AND day >= ? ORDER BY store, day').all(barcode, since);
    return db.prepare('SELECT * FROM prices WHERE store = ? AND product_id = ? AND day >= ? ORDER BY day').all(store, productId, since);
  }

  close() {
    this.#db?.close();
    this.#db = null;
  }
}

/** Summary of one store's product over the period: today against its own past. */
export function summarize(rows, today) {
  const series = rows.map((r) => ({ day: r.day, price: r.price, ...(r.regular_price ? { regularPrice: r.regular_price } : {}), ...(r.promotion ? { promotion: r.promotion } : {}) }));
  const latest = rows.at(-1);
  const prices = rows.map((r) => r.price);
  const before = rows.filter((r) => r.day < latest.day).map((r) => r.price).sort((a, b) => a - b);
  const usual = before.length ? before[Math.floor(before.length / 2)] : null;
  const monthAgo = [...rows].reverse().find((r) => r.day <= dayOf(Date.parse(`${latest.day}T12:00:00Z`) - 30 * DAY_MS));
  const low = rows.reduce((a, b) => (b.price < a.price ? b : a));
  const high = rows.reduce((a, b) => (b.price > a.price ? b : a));
  return {
    store: latest.store,
    productId: latest.product_id,
    name: latest.name,
    barcode: latest.barcode,
    priceBasis: latest.price_basis,
    current: { price: latest.price, day: latest.day, ...(latest.day !== today ? { stale: true } : {}), ...(latest.promotion ? { promotion: latest.promotion } : {}) },
    lowest: { price: low.price, day: low.day },
    highest: { price: high.price, day: high.day },
    daysSeen: rows.length,
    ...(usual != null ? { usualPrice: usual, vsUsual: round(latest.price - usual), isLowestSeen: latest.price <= Math.min(...prices) } : {}),
    ...(monthAgo ? { change30Days: round(latest.price - monthAgo.price) } : {}),
    series,
  };
}

export const PRICE_HISTORY_TOOL = {
  name: 'price_history',
  title: 'Price history',
  description:
    'Show how a product\'s price has changed in Shufersal and Rami Levy: daily prices, the lowest and highest, the usual (median) price before today, ' +
    'the change over 30 days, and whether today\'s price is the lowest seen. Use it to tell whether a promotion is a real discount (vsUsual below 0) ' +
    'or the regular price relabelled. Give a barcode (every store), a store and productId, or a saved preference name. ' +
    'History is recorded from searches made through this server and a daily check of saved preferences, so a product that was never searched has none.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      barcode: { type: 'string', description: 'Exact product barcode from search results' },
      store: { type: 'string', enum: ['shufersal', 'rami-levy'] },
      productId: { type: 'string', description: 'A product id from search results, with its store' },
      preference: { type: 'string', description: 'A saved household preference name' },
      days: { type: 'integer', minimum: 1, maximum: 365, default: 90 },
    },
    additionalProperties: false,
  },
};

export async function priceHistory(history, args = {}, { preferences = null, findIds = null } = {}) {
  const days = Number.isInteger(args.days) ? Math.min(Math.max(args.days, 1), 365) : 90;
  let barcode = args.barcode ? barcodeOf(args.barcode) : null;
  if (args.barcode && !barcode) throw new StoreError(`${args.barcode} is not a retail barcode`, 'INVALID_ARGUMENT');
  const targets = [];
  if (args.preference) {
    const saved = preferences?.get(args.preference);
    if (!saved) throw new StoreError(`no saved preference named ${JSON.stringify(args.preference)}`, 'NOT_FOUND');
    if (saved.barcode) barcode = saved.barcode;
    else if (findIds) targets.push(...(await findIds(saved.query)));
  }
  let rows = [];
  if (barcode) rows = await history.rows({ barcode, days });
  else if (args.store && args.productId) rows = await history.rows({ store: args.store, productId: String(args.productId), days });
  else if (targets.length) for (const t of targets) rows.push(...(await history.rows({ ...t, days })));
  else throw new StoreError('give a barcode, a store and productId, or a preference', 'INVALID_ARGUMENT');

  const today = dayOf(history.now());
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.store}|${r.product_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const products = [...groups.values()].map((g) => summarize(g, today));
  return {
    ...(barcode ? { barcode } : {}),
    days,
    products,
    ...(products.length ? {} : { note: 'No prices recorded yet for this product. History starts when it is searched through this server or saved as a preference.' }),
  };
}

/** Searches every saved preference once a day so the products the household buys build a history. */
export function startTracker({ preferences, stores, search, intervalMs = DAY_MS, firstDelayMs = 60_000, log = () => {} }) {
  const run = async () => {
    const queries = [...new Set(preferences.list().map((p) => p.barcode ?? p.query).filter(Boolean))];
    let done = 0;
    for (const q of queries) {
      for (const store of stores) {
        try {
          await search(store, q);
          done += 1;
        } catch (error) {
          log(`price tracker: ${store.id} "${q}": ${error.message}`);
        }
      }
    }
    if (queries.length) log(`price tracker: ${done} searches for ${queries.length} preferences`);
  };
  const first = setTimeout(run, firstDelayMs);
  const timer = setInterval(run, intervalMs);
  first.unref?.();
  timer.unref?.();
  return { run, stop: () => { clearTimeout(first); clearInterval(timer); } };
}
