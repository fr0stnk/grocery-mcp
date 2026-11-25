import { StoreError } from '../normalize.js';
import { buildPreference, preferenceKey, preferenceName } from '../preferences.js';

const toPreference = (r) => ({
  name: r.name,
  ...(r.query ? { query: r.query } : {}),
  ...(r.barcode ? { barcode: r.barcode } : {}),
  quantity: r.quantity,
  usual: Boolean(r.usual),
  ...(r.note ? { note: r.note } : {}),
  updatedAt: r.updated_at,
});

/** One person's product preferences in the database; the same interface as the JSON PreferenceStore. */
export class DbPreferenceStore {
  constructor(db, userId) {
    this.db = db;
    this.userId = userId;
  }

  list() {
    return this.db.prepare('SELECT * FROM preferences WHERE user_id = ? ORDER BY name').all(this.userId).map(toPreference);
  }

  get(name) {
    const key = typeof name === 'string' ? preferenceKey(name) : '';
    const row = key ? this.db.prepare('SELECT * FROM preferences WHERE user_id = ? AND key = ?').get(this.userId, key) : null;
    return row ? toPreference(row) : null;
  }

  save(input = {}) {
    const key = preferenceKey(preferenceName(input));
    const existing = this.get(key) ?? {};
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM preferences WHERE user_id = ?').get(this.userId).n;
    const p = buildPreference(input, existing, count);
    this.db
      .prepare(`INSERT INTO preferences (user_id, key, name, query, barcode, quantity, usual, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, key) DO UPDATE SET name = excluded.name, query = excluded.query, barcode = excluded.barcode,
          quantity = excluded.quantity, usual = excluded.usual, note = excluded.note, updated_at = excluded.updated_at`)
      .run(this.userId, key, p.name, p.query ?? null, p.barcode ?? null, p.quantity, p.usual ? 1 : 0, p.note ?? null, p.updatedAt);
    return { saved: p, created: !existing.name };
  }

  remove(name) {
    const existing = this.get(name);
    if (!existing) throw new StoreError(`no preference named ${JSON.stringify(name)}`, 'NOT_FOUND');
    this.db.prepare('DELETE FROM preferences WHERE user_id = ? AND key = ?').run(this.userId, preferenceKey(existing.name));
    return { removed: existing.name };
  }
}
