import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createApp, type AppOptions } from '../src/app.js';

const testRoot = fileURLToPath(new URL('../../data/test-output/', import.meta.url));
await mkdir(testRoot, { recursive: true });

const auth = { authorization: 'Bearer test-device-token', 'x-device-id': 'coaster-01' };
const heartbeat = {
  weightGrams: 450, stable: true, cupPresent: true, source: 'hx711',
  calibrated: true, emptyCupGrams: 120, pendingCount: 0, timePendingCount: 0,
  clockSynced: true, error: null, firmwareVersion: '0.2.0',
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), kind: 'drink', amountMl: 50, beforeGrams: 500, afterGrams: 450,
    occurredAt: '2026-10-09T01:00:00.000Z', ...overrides,
  };
}

async function fixture(t: TestContext, options: Partial<AppOptions> = {}) {
  const directory = await mkdtemp(join(testRoot, 'coaster-server-test-'));
  const app = createApp({
    deviceToken: 'test-device-token', dbPath: join(directory, 'coaster.sqlite'),
    now: () => new Date('2026-10-09T02:00:00.000Z'), ...options,
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.ready();
  return app;
}

test('拒绝缺失配置，设备上报需要正确凭证，本机读取不暴露凭证', async (t) => {
  assert.throws(() => createApp({ deviceToken: '', dbPath: ':memory:' }), /DEVICE_TOKEN/);
  assert.throws(() => createApp({ deviceToken: 'test', timeZone: 'Not/AZone' }), RangeError);
  const app = await fixture(t);
  for (const headers of [{}, { authorization: 'Bearer wrong-token' }]) {
    const result = await app.inject({ method: 'POST', url: '/api/device/heartbeat', headers, payload: heartbeat });
    assert.equal(result.statusCode, 401);
    const events = await app.inject({ method: 'POST', url: '/api/device/events', headers, payload: { events: [event()] } });
    assert.equal(events.statusCode, 401);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: auth, payload: heartbeat })).statusCode, 200);
  const result = await app.inject('/api/dashboard');
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().device.online, true);
  assert.equal(result.json().device.weightGrams, 450);
  assert.equal(result.body.includes('test-device-token'), false);
});

test('拒绝外部 Origin、DNS 重绑定和跨站请求，允许本地代理', async (t) => {
  const app = await fixture(t);
  for (const headers of [
    { host: 'attacker.example:3001' }, { origin: 'https://attacker.example' },
    { origin: 'null' }, { 'sec-fetch-site': 'cross-site' },
  ]) {
    assert.equal((await app.inject({ url: '/api/dashboard', headers })).statusCode, 403);
  }
  assert.equal((await app.inject({ url: '/api/dashboard', remoteAddress: '192.168.1.20' })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/dashboard', headers: { origin: 'http://127.0.0.1:5173' } })).statusCode, 200);
});

test('按上海时区跨日统计，七天补零，饮水和补水分开累计', async (t) => {
  const app = await fixture(t);
  const events = [
    event({ occurredAt: '2026-10-08T15:59:59.000Z' }),
    event({ occurredAt: '2026-10-08T16:00:00.000Z', amountMl: 75, afterGrams: 425 }),
    event({ occurredAt: '2026-10-09T01:00:00+08:00', kind: 'refill', amountMl: 100, beforeGrams: 425, afterGrams: 525 }),
    event({ occurredAt: '2026-10-02T15:59:59.000Z' }),
  ];
  const saved = await app.inject({ method: 'POST', url: '/api/device/events', headers: auth, payload: { events } });
  assert.equal(saved.statusCode, 200);
  const dashboard = (await app.inject('/api/dashboard')).json();
  assert.equal(dashboard.date, '2026-10-09');
  assert.equal(dashboard.timeZone, 'Asia/Shanghai');
  assert.deepEqual(dashboard.totals, { drinkMl: 75, refillMl: 100, drinkCount: 1 });
  assert.equal(dashboard.events.length, 2);
  assert.equal(dashboard.events[0].kind, 'refill');
  assert.deepEqual(dashboard.week, [
    { date: '2026-10-03', drinkMl: 0 }, { date: '2026-10-04', drinkMl: 0 },
    { date: '2026-10-05', drinkMl: 0 }, { date: '2026-10-06', drinkMl: 0 },
    { date: '2026-10-07', drinkMl: 0 }, { date: '2026-10-08', drinkMl: 50 },
    { date: '2026-10-09', drinkMl: 75 },
  ]);
  assert.deepEqual((await app.inject('/api/dashboard?date=2026-10-08')).json().totals,
    { drinkMl: 50, refillMl: 0, drinkCount: 1 });
});

test('夏令时回拨的两个同名小时都归入同一天', async (t) => {
  const app = await fixture(t, { timeZone: 'America/New_York' });
  const events = [
    event({ occurredAt: '2026-11-01T01:30:00-04:00' }),
    event({ occurredAt: '2026-11-01T01:30:00-05:00' }),
  ];
  await app.inject({ method: 'POST', url: '/api/device/events', headers: auth, payload: { events } });
  assert.deepEqual((await app.inject('/api/dashboard?date=2026-11-01')).json().totals,
    { drinkMl: 100, refillMl: 0, drinkCount: 2 });
});

test('相同事件重传不重复累计，冲突批次整体回滚', async (t) => {
  const app = await fixture(t);
  const original = event();
  const submit = (events: ReturnType<typeof event>[]) => app.inject({
    method: 'POST', url: '/api/device/events', headers: auth, payload: { events },
  });
  assert.deepEqual((await submit([original, original])).json(), { acknowledged: [original.id], inserted: 1 });
  assert.deepEqual((await submit([original])).json(), { acknowledged: [original.id], inserted: 0 });
  const conflict = { ...original, amountMl: 60, afterGrams: 440 };
  assert.equal((await submit([event(), conflict])).statusCode, 409);
  assert.deepEqual((await app.inject('/api/dashboard')).json().totals, { drinkMl: 50, refillMl: 0, drinkCount: 1 });
});

test('撤销幂等，重传不恢复已撤销记录，撤销记录仍可查看', async (t) => {
  const app = await fixture(t);
  const original = event();
  await app.inject({ method: 'POST', url: '/api/device/events', headers: auth, payload: { events: [original] } });
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await app.inject({ method: 'POST', url: `/api/events/${original.id}/revoke` })).statusCode, 200);
  }
  assert.equal((await app.inject({ method: 'POST', url: `/api/events/${randomUUID()}/revoke` })).statusCode, 404);
  const retry = await app.inject({ method: 'POST', url: '/api/device/events', headers: auth, payload: { events: [original] } });
  assert.equal(retry.json().inserted, 0);
  const dashboard = (await app.inject('/api/dashboard')).json();
  assert.deepEqual(dashboard.totals, { drinkMl: 0, refillMl: 0, drinkCount: 0 });
  assert.equal(dashboard.events[0].revokedAt, '2026-10-09T02:00:00.000Z');
  assert.equal(dashboard.week[6].drinkMl, 0);
});

test('日期、时区、事件方向、重量范围和字段类型验证', async (t) => {
  const app = await fixture(t);
  for (const invalid of [
    event({ id: 'not-a-uuid' }), event({ amountMl: 49 }), event({ kind: 'refill' }),
    event({ beforeGrams: 45, afterGrams: -5 }), event({ occurredAt: '2026-10-09T01:00:00' }),
    event({ occurredAt: '2026-02-30T01:00:00Z' }), event({ amountMl: '50' }),
    event({ kind: 'other' }), event({ extra: true }),
  ]) {
    const result = await app.inject({ method: 'POST', url: '/api/device/events', headers: auth, payload: { events: [invalid] } });
    assert.equal(result.statusCode, 400, JSON.stringify(invalid));
  }
  for (const date of ['2026-02-30', '2026-13-01', 'invalid']) {
    assert.equal((await app.inject(`/api/dashboard?date=${date}`)).statusCode, 400);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: auth,
    payload: { ...heartbeat, stable: 'true' } })).statusCode, 400);
  assert.deepEqual((await app.inject('/api/dashboard')).json().totals, { drinkMl: 0, refillMl: 0, drinkCount: 0 });
});

test('数据库重开后保留事件、撤销和最后心跳，心跳超时显示离线', async (t) => {
  const directory = await mkdtemp(join(testRoot, 'coaster-server-reopen-'));
  const config = { deviceToken: 'test-device-token', dbPath: join(directory, 'coaster.sqlite') };
  let currentTime = new Date('2026-10-09T02:00:00.000Z');
  const original = event();
  const app = createApp({ ...config, now: () => currentTime });
  await app.inject({ method: 'POST', url: '/api/device/events', headers: auth, payload: { events: [original, event()] } });
  await app.inject({ method: 'POST', url: `/api/events/${original.id}/revoke` });
  await app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: auth, payload: heartbeat });
  await app.close();
  const reopened = createApp({ ...config, now: () => currentTime });
  t.after(async () => { await reopened.close(); await rm(directory, { recursive: true, force: true }); });
  const dashboard = (await reopened.inject('/api/dashboard')).json();
  assert.deepEqual(dashboard.totals, { drinkMl: 50, refillMl: 0, drinkCount: 1 });
  assert.equal(dashboard.events.length, 2);
  assert.equal(dashboard.device.online, true);
  assert.equal(dashboard.device.lastSeenAt, currentTime.toISOString());
  currentTime = new Date(currentTime.getTime() + 15_001);
  const offline = (await reopened.inject('/api/dashboard')).json().device;
  assert.equal(offline.online, false);
  assert.equal(offline.weightGrams, 450);
});

test('真实设备可从局域网上报，凭证不能开放网页查询或撤销', async (t) => {
  const app = await fixture(t);
  const remoteAddress = '192.168.1.30';
  const headers = { ...auth, host: '192.168.1.10:3001' };
  const result = await app.inject({ method: 'POST', url: '/api/device/heartbeat', remoteAddress, headers, payload: heartbeat });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().serverTimeMs, Date.parse('2026-10-09T02:00:00.000Z'));
  const original = event();
  const post = await app.inject({ method: 'POST', url: '/api/device/events', remoteAddress, headers, payload: { events: [original] } });
  assert.equal(post.statusCode, 200);
  assert.equal((await app.inject({ url: '/api/dashboard', remoteAddress, headers })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/events/${original.id}/revoke`, remoteAddress, headers })).statusCode, 403);
  for (const extra of [{ origin: 'http://127.0.0.1:5173' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/device/heartbeat', remoteAddress,
      headers: { ...headers, ...extra }, payload: heartbeat })).statusCode, 403);
  }
  for (const identity of [{}, { 'x-device-id': 'coaster-02' }]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/device/heartbeat', remoteAddress,
      headers: { authorization: auth.authorization, ...identity }, payload: heartbeat })).statusCode, 401);
  }
});

test('未连接或未校准不会显示虚构重量，错误和待校时计数被保留', async (t) => {
  const app = await fixture(t);
  const initial = (await app.inject('/api/dashboard')).json().device;
  assert.equal(initial.online, false);
  assert.equal(initial.weightGrams, null);
  assert.equal(initial.emptyCupGrams, null);
  assert.equal(initial.calibrated, false);
  const uncalibrated = { ...heartbeat, weightGrams: null, calibrated: false, stable: false,
    cupPresent: false, emptyCupGrams: null, pendingCount: 2, timePendingCount: 1,
    clockSynced: false, error: '请先完成称重校准' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: auth, payload: uncalibrated })).statusCode, 200);
  const device = (await app.inject('/api/dashboard')).json().device;
  assert.equal(device.weightGrams, null);
  assert.equal(device.error, uncalibrated.error);
  assert.equal(device.timePendingCount, 1);
  for (const payload of [
    { ...uncalibrated, weightGrams: 450 }, { ...uncalibrated, stable: true },
    { ...heartbeat, source: 'unknown' }, { ...heartbeat, timePendingCount: 1 },
  ]) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: auth, payload })).statusCode, 400);
  }
});

test('真实空杯重量不再固定为 120 g，重启和不同设备的统计互不混淆', async (t) => {
  const directory = await mkdtemp(join(testRoot, 'coaster-device-isolation-'));
  const config = { deviceToken: 'test-device-token', dbPath: join(directory, 'hardware.sqlite'),
    now: () => new Date('2026-10-09T02:00:00.000Z') };
  const first = createApp(config);
  const record = event({ beforeGrams: 100, afterGrams: 50 });
  assert.equal((await first.inject({ method: 'POST', url: '/api/device/events', headers: auth,
    payload: { events: [record] } })).statusCode, 200);
  await first.close();
  const second = createApp({ ...config, deviceId: 'coaster-02' });
  t.after(async () => { await second.close(); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual((await second.inject('/api/dashboard')).json().totals, { drinkMl: 0, refillMl: 0, drinkCount: 0 });
  assert.equal((await second.inject({ method: 'POST', url: `/api/events/${record.id}/revoke` })).statusCode, 404);
  assert.equal((await second.inject({ method: 'POST', url: '/api/device/events',
    headers: { ...auth, 'x-device-id': 'coaster-02' }, payload: { events: [record] } })).statusCode, 200);
  assert.equal((await second.inject('/api/dashboard')).json().totals.drinkMl, 50);
});
