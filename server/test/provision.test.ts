import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/db.js';
import { cookieOf, event, fixture, headers, heartbeat } from './cloud-fixture.js';

test('旧版无明确归属的事件迁移后保留隔离，首次绑定不会取得历史', async (t) => {
  const f = await fixture(t);
  const path = `${f.dbPath}.legacy`;
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE device_events (device_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
    amount_ml REAL NOT NULL, before_grams REAL NOT NULL, after_grams REAL NOT NULL, occurred_at TEXT NOT NULL,
    revoked_at TEXT, PRIMARY KEY(device_id,id));
    CREATE TABLE device_status (id TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL, payload TEXT NOT NULL);`);
  const record = event();
  legacy.prepare('INSERT INTO device_events VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run('coaster-01', record.id, 'drink', 50, 500, 450, record.occurredAt);
  legacy.prepare('INSERT INTO device_status VALUES (?, ?, ?)').run('coaster-01', f.now().toISOString(), JSON.stringify(heartbeat));
  legacy.close();
  const app = createApp({ dbPath: path, now: f.now, deviceId: 'coaster-01', deviceToken: 'test-token-coaster-01' });
  try {
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'legacy_user', password: 'password-123' } });
    const cookie = cookieOf(registered);
    await app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: headers(), payload: heartbeat });
    const code = (await app.inject({ method: 'POST', url: '/api/device/binding', headers: headers(), payload: {} })).json().code;
    assert.equal((await app.inject({ method: 'POST', url: '/api/devices/bind', headers: { cookie }, payload: { code } })).statusCode, 200);
    const dashboard = (await app.inject({ url: '/api/dashboard', headers: { cookie } })).json();
    assert.equal(dashboard.totals.drinkMl, 0); assert.equal(dashboard.events.length, 0);
    const migrated = openDatabase(path);
    assert.equal(migrated.prepare('SELECT binding_id FROM device_events WHERE id = ?').get(record.id)!.binding_id, null);
    migrated.close();
  } finally { await app.close(); }
});
