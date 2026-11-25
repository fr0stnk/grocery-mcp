import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS } from './migrations.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function databaseFile(env = process.env) {
  return env.GROCERY_DATABASE_FILE || path.join(env.GROCERY_DATA_DIR || path.join(repoRoot, '.data'), 'grocery.db');
}

/**
 * The server's SQLite database. The HTTP server and one-shot stdio runs may
 * open the same file at once, which WAL mode and a busy timeout allow. The SQL
 * sticks to what PostgreSQL also accepts (TEXT ids and ISO-8601 timestamps,
 * no SQLite-only functions in queries), so moving later is a new driver and a
 * data copy, not a rewrite.
 */
export async function openDatabase(file = databaseFile()) {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  fs.chmodSync(file, 0o600);
  migrate(db);
  return db;
}

/** Applies pending migrations in order, each in its own transaction. */
export function migrate(db, migrations = MIGRATIONS) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  const done = [];
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Another process may have applied it while this one waited for the lock.
      if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(m.version)) {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
        done.push(m.version);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} (${m.name}) failed: ${error.message}`);
    }
  }
  return done;
}

/** Runs `fn` in a transaction; the database's own helper for multi-statement writes. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
