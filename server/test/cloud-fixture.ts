import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { createApp, type AppOptions } from '../src/app.js';
import { openDatabase, provisionDevice } from '../src/db.js';

export const heartbeat = {
  weightGrams: 450, stable: true, cupPresent: true, source: 'hx711', calibrated: true,
  emptyCupGrams: 120, pendingCount: 0, timePendingCount: 0, clockSynced: true,
  error: null, firmwareVersion: '0.5.0',
};
export const event = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(), kind: 'drink', amountMl: 50, beforeGrams: 500, afterGrams: 450,
  occurredAt: '2026-10-09T01:00:00.000Z', ...overrides,
});
export const headers = (id = 'coaster-01') => ({ authorization: `Bearer test-token-${id}`, 'x-device-id': id });
export function cookieOf(response: { headers: Record<string, unknown> }) { return String(response.headers['set-cookie']).split(';')[0]; }
export async function fixture(t: TestContext, options: Partial<AppOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'coaster-cloud-'));
  const dbPath = join(directory, 'coaster.sqlite');
  const db = openDatabase(dbPath);
  for (const id of ['coaster-01', 'coaster-02']) provisionDevice(db, id, `test-token-${id}`);
  db.close();
  let timestamp = Date.parse('2026-10-09T02:00:00.000Z');
  const now = () => new Date(timestamp);
  const app = createApp({ dbPath, now, ...options });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const web = (cookie: string, url: string, payload?: Record<string, unknown>) => app.inject({ url, method: payload === undefined ? 'GET' : 'POST', headers: { cookie }, payload });
  const report = (id = 'coaster-01', payload: Record<string, unknown> = heartbeat) => app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: headers(id), payload });
  const register = async (username = 'user_one') => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'password-123' } });
    assert.equal(response.statusCode, 200, response.body);
    return cookieOf(response);
  };
  const code = async (id = 'coaster-01') => {
    await report(id);
    const response = await app.inject({ method: 'POST', url: '/api/device/binding', headers: headers(id), payload: {} });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { code: string; expiresAt: number };
  };
  const bind = async (cookie: string, id = 'coaster-01') => {
    const binding = await code(id);
    const response = await web(cookie, '/api/devices/bind', { code: binding.code });
    assert.equal(response.statusCode, 200, response.body);
    return binding;
  };
  const upload = (events: ReturnType<typeof event>[], id = 'coaster-01') => {
    // Ordinary dashboard tests generate records for the current batch. Tests of
    // the legacy wire format use raw inject to intentionally omit bindingId.
    const db = openDatabase(dbPath);
    const bindingId = db.prepare('SELECT binding_id FROM devices WHERE id = ?').get(id)!.binding_id;
    db.close();
    const payload = { events: events.map((item) => Object.hasOwn(item, 'bindingId') ? item : { ...item, bindingId }) };
    return app.inject({ method: 'POST', url: '/api/device/events', headers: headers(id), payload });
  };
  return { app, dbPath, now, web, report, register, code, bind, upload, advance: (milliseconds: number) => { timestamp += milliseconds; } };
}
