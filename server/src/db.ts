import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const deviceIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const databasePath = (path?: string) => path === ':memory:' ? path : resolve(projectRoot, path ?? 'data/coaster-hardware.sqlite');

export function openDatabase(path?: string) {
  const filename = databasePath(path);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
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
  `);
  return db;
}

export function provisionDevice(db: DatabaseSync, id: string, token = randomBytes(32).toString('hex'), now = Date.now()) {
  if (!deviceIdPattern.test(id)) throw new Error('设备 ID 应为 1–64 位字母、数字、下划线或连字符');
  if (!token.trim()) throw new Error('设备凭证不能为空');
  if (db.prepare('SELECT id FROM devices WHERE id = ?').get(id)) throw new Error('设备 ID 已存在，不能覆盖现有凭证和归属');
  if (db.prepare('SELECT id FROM devices WHERE token_hash = ?').get(hash(token))) throw new Error('每台杯垫必须使用独立凭证');
  db.prepare('INSERT INTO devices (id, token_hash, created_at) VALUES (?, ?, ?)').run(id, hash(token), now);
  return { id, token };
}
