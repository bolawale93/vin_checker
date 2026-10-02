// SQLite storage using Node's built-in driver. The schema is versioned with
// PRAGMA user_version so future changes can be applied as numbered migrations.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'staff', 'viewer')),
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE searches (
    id INTEGER PRIMARY KEY,
    reference TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('single', 'batch')),
    case_reference TEXT,
    location TEXT,
    notes TEXT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    checker_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    total INTEGER NOT NULL DEFAULT 0,
    common_details TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX idx_searches_created ON searches(created_at);
  CREATE INDEX idx_searches_user ON searches(user_id);

  CREATE TABLE search_items (
    id INTEGER PRIMARY KEY,
    search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    vin_input TEXT NOT NULL,
    vin TEXT NOT NULL,
    validation TEXT NOT NULL,
    lookup_status TEXT NOT NULL,
    message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    make TEXT,
    model TEXT,
    year TEXT,
    vehicle_status TEXT,
    has_sample INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    retrieved_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_items_search ON search_items(search_id);
  CREATE INDEX idx_items_vin ON search_items(vin);
  CREATE INDEX idx_items_status ON search_items(lookup_status);

  CREATE TABLE item_details (
    item_id INTEGER PRIMARY KEY REFERENCES search_items(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated_by INTEGER REFERENCES users(id),
    updated_by_name TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    details TEXT,
    ip TEXT
  );
  CREATE INDEX idx_audit_at ON audit_log(at);
  CREATE INDEX idx_audit_action ON audit_log(action);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  `,
  // 2 — separate specification/history outcomes; drop recovery and repair
  //     fields, which the agency does not use, from stored staff details.
  `
  ALTER TABLE search_items ADD COLUMN spec_status TEXT;
  ALTER TABLE search_items ADD COLUMN history_status TEXT;
  ALTER TABLE search_items ADD COLUMN summary_meta TEXT;
  UPDATE item_details SET data = json_remove(data, '$.recoveryStatus', '$.recoveryDate', '$.recoveryLocation', '$.repairs');
  UPDATE searches SET common_details = json_remove(common_details, '$.recoveryStatus', '$.recoveryDate', '$.recoveryLocation', '$.repairs')
    WHERE common_details IS NOT NULL;
  `,
  // 3 — provider report references (e.g. VinAudit report ids, reused to avoid
  //     paying twice for the same VIN within the provider's retention period)
  `
  CREATE TABLE provider_refs (
    provider TEXT NOT NULL,
    vin TEXT NOT NULL,
    ref TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reported_at TEXT,
    PRIMARY KEY (provider, vin)
  );
  `,
];

let db;

export function openDb(file = config.dbPath) {
  if (db) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function getDb() {
  return db || openDb();
}

function migrate(d) {
  const current = d.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    d.exec('BEGIN');
    try {
      d.exec(MIGRATIONS[v]);
      d.exec(`PRAGMA user_version = ${v + 1}`);
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Run fn inside a transaction. */
export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export const nowIso = () => new Date().toISOString();

export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
