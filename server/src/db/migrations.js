/**
 * Numbered, append-only migrations. Never edit one that has shipped; add the
 * next. Types are chosen to read the same in PostgreSQL: TEXT ids (UUIDs made
 * by the app), TEXT ISO-8601 timestamps, REAL amounts, INTEGER 0/1 flags (a
 * BOOLEAN in PostgreSQL), and encrypted values as TEXT envelopes (see vault.js).
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'people, store accounts, carts, audit and prices',
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        idp_sub TEXT NOT NULL UNIQUE,
        email TEXT,
        phone_enc TEXT,
        first_name TEXT,
        last_name TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        disabled_at TEXT
      );

      CREATE TABLE store_accounts (
        id TEXT PRIMARY KEY,
        store TEXT NOT NULL CHECK (store IN ('shufersal', 'rami-levy')),
        owner_user_id TEXT NOT NULL REFERENCES users (id),
        label TEXT,
        status TEXT NOT NULL CHECK (status IN ('environment', 'connected', 'expiring', 'expired', 'error', 'disconnected')),
        session_enc TEXT,
        expires_at TEXT,
        last_verified_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE store_access (
        store_account_id TEXT NOT NULL REFERENCES store_accounts (id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'shopper', 'viewer')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (store_account_id, user_id)
      );
      CREATE INDEX store_access_user ON store_access (user_id);

      CREATE TABLE addresses (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        city TEXT,
        street TEXT,
        house_number TEXT,
        apartment TEXT,
        floor TEXT,
        entrance TEXT,
        notes TEXT,
        address_enc TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE preferences (
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        query TEXT,
        barcode TEXT,
        quantity REAL NOT NULL,
        usual INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );

      CREATE TABLE carts (
        store_account_id TEXT NOT NULL REFERENCES store_accounts (id) ON DELETE CASCADE,
        product_id TEXT NOT NULL,
        name TEXT,
        price REAL,
        quantity REAL NOT NULL,
        unit TEXT NOT NULL DEFAULT 'unit' CHECK (unit IN ('unit', 'kg', 'pack')),
        source TEXT NOT NULL DEFAULT 'mcp',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (store_account_id, product_id)
      );

      CREATE TABLE cart_syncs (
        id TEXT PRIMARY KEY,
        store_account_id TEXT NOT NULL REFERENCES store_accounts (id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
        at TEXT NOT NULL,
        idempotency_key TEXT,
        request_hash TEXT,
        result TEXT NOT NULL,
        server_total REAL,
        error TEXT
      );
      CREATE UNIQUE INDEX cart_syncs_idempotency ON cart_syncs (store_account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
        store_account_id TEXT REFERENCES store_accounts (id) ON DELETE SET NULL,
        tool TEXT NOT NULL,
        outcome TEXT NOT NULL,
        duration_ms INTEGER,
        details TEXT
      );
      CREATE INDEX audit_log_at ON audit_log (at);

      CREATE TABLE IF NOT EXISTS prices (
        store TEXT NOT NULL,
        product_id TEXT NOT NULL,
        day TEXT NOT NULL,
        barcode TEXT,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        regular_price REAL,
        price_basis TEXT,
        promotion TEXT,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (store, product_id, day)
      );
      CREATE INDEX IF NOT EXISTS prices_barcode ON prices (barcode, day);
    `,
  },
];
