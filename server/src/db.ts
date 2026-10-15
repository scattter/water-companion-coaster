import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const deviceIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const databasePath = (path?: string) => path === ':memory:' ? path : resolve(projectRoot, path ?? 'data/coaster-hardware.sqlite');

export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

const migrations: ((db: DatabaseSync) => void)[] = [
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS device_events (
      device_id TEXT NOT NULL, id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('drink', 'refill')),
      amount_ml REAL NOT NULL, before_grams REAL NOT NULL, after_grams REAL NOT NULL,
      occurred_at TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY (device_id, id)
    );
    CREATE INDEX IF NOT EXISTS device_events_occurred_at ON device_events(device_id, occurred_at);
    CREATE TABLE IF NOT EXISTS device_status (
      id TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT UNIQUE REFERENCES users(id), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS binding_codes (
      code_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL UNIQUE REFERENCES devices(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_commands (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'expired')),
      message TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_command ON device_commands(device_id) WHERE status = 'pending';
  `),
  (db) => {
    db.exec(`
      ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin'));
      CREATE TABLE device_bindings (
        id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), user_id TEXT NOT NULL REFERENCES users(id),
        started_at INTEGER NOT NULL, ended_at INTEGER, legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0, 1))
      );
      CREATE UNIQUE INDEX current_device_binding ON device_bindings(device_id) WHERE ended_at IS NULL;
      CREATE UNIQUE INDEX current_user_binding ON device_bindings(user_id) WHERE ended_at IS NULL;
      CREATE INDEX user_binding_history ON device_bindings(user_id, started_at);
      ALTER TABLE devices ADD COLUMN binding_id TEXT REFERENCES device_bindings(id);
      ALTER TABLE devices ADD COLUMN legacy_binding_id TEXT REFERENCES device_bindings(id);
      ALTER TABLE devices ADD COLUMN provisioning_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE devices ADD COLUMN last_seen_at TEXT;
      UPDATE devices SET last_seen_at = (SELECT last_seen_at FROM device_status WHERE id = devices.id);
      ALTER TABLE device_events ADD COLUMN binding_id TEXT REFERENCES device_bindings(id);
      ALTER TABLE device_status ADD COLUMN binding_id TEXT REFERENCES device_bindings(id);
      ALTER TABLE device_commands ADD COLUMN binding_id TEXT REFERENCES device_bindings(id);
      CREATE INDEX binding_events ON device_events(binding_id, occurred_at);
    `);
    // Only an explicit existing owner is evidence of historical ownership. Unowned
    // rows retain NULL forever, including installations predating user accounts.
    for (const device of db.prepare('SELECT id, user_id FROM devices WHERE user_id IS NOT NULL').all()) {
      const bindingId = randomUUID();
      db.prepare('INSERT INTO device_bindings (id, device_id, user_id, started_at, legacy) VALUES (?, ?, ?, 0, 1)')
        .run(bindingId, device.id, device.user_id);
      db.prepare('UPDATE devices SET binding_id = ?, legacy_binding_id = ? WHERE id = ?').run(bindingId, bindingId, device.id);
      db.prepare('UPDATE device_events SET binding_id = ? WHERE device_id = ?').run(bindingId, device.id);
      db.prepare('UPDATE device_commands SET binding_id = ? WHERE device_id = ?').run(bindingId, device.id);
      db.prepare('UPDATE device_status SET binding_id = ? WHERE id = ?').run(bindingId, device.id);
    }
  },
  (db) => db.exec(`
    CREATE TABLE deployment (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), deployment_id TEXT NOT NULL UNIQUE, public_key TEXT
    );
    CREATE TABLE settings (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), server_url TEXT NOT NULL DEFAULT '',
      config_version INTEGER NOT NULL DEFAULT 1 CHECK(config_version >= 1)
    );
    CREATE TABLE provisioning_operations (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), user_id TEXT NOT NULL REFERENCES users(id),
      deployment_id TEXT NOT NULL, challenge TEXT NOT NULL, server_url TEXT NOT NULL, config_version INTEGER NOT NULL,
      ticket_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('issued', 'claimed', 'completed', 'failed', 'cancelled', 'expired')),
      binding_id TEXT REFERENCES device_bindings(id), code TEXT, message TEXT,
      UNIQUE(device_id, challenge)
    );
    CREATE INDEX provisioning_user ON provisioning_operations(user_id, created_at);
    CREATE INDEX provisioning_device ON provisioning_operations(device_id, status);
  `),
  (db) => db.exec(`
    ALTER TABLE devices ADD COLUMN hardware_id TEXT;
    CREATE UNIQUE INDEX devices_hardware ON devices(hardware_id) WHERE hardware_id IS NOT NULL;
    CREATE TABLE enrollment_operations (
      id TEXT PRIMARY KEY, hardware_id TEXT NOT NULL, device_id TEXT REFERENCES devices(id),
      user_id TEXT NOT NULL REFERENCES users(id), challenge TEXT NOT NULL, server_url TEXT NOT NULL,
      ticket_hash TEXT NOT NULL, credential TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('issued', 'claimed', 'completed', 'failed', 'cancelled', 'expired')),
      binding_id TEXT REFERENCES device_bindings(id), code TEXT, message TEXT,
      UNIQUE(hardware_id, challenge)
    );
    CREATE INDEX enrollment_device ON enrollment_operations(hardware_id, status);
    CREATE INDEX enrollment_user ON enrollment_operations(user_id, created_at);
  `),
];

export function openDatabase(path?: string) {
  const filename = databasePath(path);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    // Re-read the version under the write lock so simultaneous startups cannot
    // both apply the same migration. Each version and its data move atomically.
    transaction(db, () => {
      let version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > migrations.length) throw new Error('数据库版本比当前服务器更新，禁止降级打开');
      while (version < migrations.length) {
        migrations[version](db);
        db.exec(`PRAGMA user_version = ${++version}`);
      }
    });
    return db;
  } catch (error) { db.close(); throw error; }
}

export function provisionDevice(db: DatabaseSync, id: string, token = randomBytes(32).toString('hex'), now = Date.now()) {
  if (!deviceIdPattern.test(id)) throw new Error('设备 ID 应为 1–64 位字母、数字、下划线或连字符');
  if (!token.trim()) throw new Error('设备凭证不能为空');
  if (db.prepare('SELECT id FROM devices WHERE id = ?').get(id)) throw new Error('设备 ID 已存在，不能覆盖现有凭证和归属');
  if (db.prepare('SELECT id FROM devices WHERE token_hash = ?').get(hash(token))) throw new Error('每台杯垫必须使用独立凭证');
  db.prepare('INSERT INTO devices (id, token_hash, created_at) VALUES (?, ?, ?)').run(id, hash(token), now);
  return { id, token };
}
