import fs from 'node:fs';
import path from 'node:path';
import { buildPreference, preferenceKey } from '../preferences.js';
import { transaction } from './database.js';
import { ensureEnvironmentStoreAccount, ensureLocalOwner, pruneAudit } from './people.js';

/**
 * Brings today's single-owner setup into the database. Safe to run on every
 * start: each step only adds what is missing.
 * - the owner, and a store account per configured store, owned by them;
 * - preferences.json, imported once and renamed to preferences.json.imported;
 * - price-history.db, copied once and renamed to price-history.db.imported.
 */
export function bootstrap(db, { env = process.env, storeIds = [], dataDir, log = () => {} } = {}) {
  const owner = ensureLocalOwner(db, env);
  const accounts = storeIds.map((store) => ensureEnvironmentStoreAccount(db, store, owner.id));
  const imported = { preferences: importPreferences(db, owner.id, path.join(dataDir, 'preferences.json'), log), prices: importPrices(db, path.join(dataDir, 'price-history.db'), log) };
  pruneAudit(db);
  return { owner, accounts, imported };
}

function importPreferences(db, userId, file, log) {
  if (!fs.existsSync(file)) return 0;
  let items;
  try {
    items = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).items ?? {});
  } catch (error) {
    log(`preferences.json not imported: ${error.message}`);
    return 0;
  }
  const insert = db.prepare(`INSERT INTO preferences (user_id, key, name, query, barcode, quantity, usual, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, key) DO NOTHING`);
  let count = 0;
  transaction(db, () => {
    for (const item of items) {
      const p = { ...buildPreference(item, {}, 0), updatedAt: item.updatedAt ?? new Date().toISOString() };
      count += insert.run(userId, preferenceKey(p.name), p.name, p.query ?? null, p.barcode ?? null, p.quantity, p.usual ? 1 : 0, p.note ?? null, p.updatedAt).changes;
    }
  });
  fs.renameSync(file, `${file}.imported`);
  log(`imported ${count} preferences from preferences.json`);
  return count;
}

function importPrices(db, file, log) {
  if (!fs.existsSync(file)) return 0;
  // Fold the separate database's WAL into it before reading it from here.
  db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS old`);
  let count = 0;
  try {
    const hasTable = db.prepare("SELECT 1 FROM old.sqlite_master WHERE type = 'table' AND name = 'prices'").get();
    if (hasTable) count = db.prepare('INSERT INTO prices SELECT * FROM old.prices WHERE true ON CONFLICT (store, product_id, day) DO NOTHING').run().changes;
  } finally {
    db.exec('DETACH DATABASE old');
  }
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, `${file}.imported${suffix}`);
  log(`imported ${count} price records from price-history.db`);
  return count;
}
