import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { openDatabase, provisionDevice } from '../src/db.js';
import { cookieOf, event, fixture, headers, heartbeat } from './cloud-fixture.js';

test('注册、登录、会话、退出和过期；密码、令牌均不明文存储', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.app.inject('/api/auth/session')).json(), { user: null, deviceId: null, bindingId: null });
  assert.equal((await f.app.inject('/api/dashboard')).statusCode, 401);
  const cookie = await f.register('User_One');
  const session = (await f.web(cookie, '/api/auth/session')).json();
  assert.equal(session.user.username, 'user_one');
  assert.equal(session.deviceId, null);
  assert.equal(session.user.role, 'user');
  assert.equal(session.bindingId, null);
  assert.equal((await f.web(cookie, '/api/dashboard')).json().device, null);
  const db = openDatabase(f.dbPath);
  const account = db.prepare('SELECT * FROM users').get()!;
  const storedSession = db.prepare('SELECT token_hash FROM sessions').get()!;
  assert.equal(JSON.stringify(account).includes('password-123'), false);
  assert.notEqual(storedSession.token_hash, cookie.split('=')[1]);
  assert.notEqual(db.prepare('SELECT token_hash FROM devices LIMIT 1').get()!.token_hash, 'test-token-coaster-01');
  db.close();
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'user_one', password: 'incorrect' } })).statusCode, 401);
  const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'USER_ONE', password: 'password-123' } });
  assert.equal(login.statusCode, 200);
  assert.match(String(login.headers['set-cookie']), /HttpOnly; SameSite=Strict/);
  const loggedIn = cookieOf(login);
  await f.web(loggedIn, '/api/auth/logout', {});
  assert.equal((await f.web(loggedIn, '/api/auth/session')).json().user, null);
  f.advance(30 * 86_400_000 + 1);
  assert.equal((await f.web(cookie, '/api/auth/session')).json().user, null);
});

test('正式站点同源保护、设备凭证隔离和生产安全Cookie', async (t) => {
  const f = await fixture(t);
  for (const extra of [ { host: 'evil.example' }, { origin: 'https://evil.example' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' } ]) {
    assert.equal((await f.app.inject({ url: '/api/auth/session', headers: extra })).statusCode, 403);
  }
  const cookie = await f.register();
  assert.equal((await f.app.inject({ url: '/api/auth/session', remoteAddress: '203.0.113.9', headers: { cookie } })).statusCode, 200);
  for (const extra of [ {}, { authorization: 'Bearer wrong', 'x-device-id': 'coaster-01' }, { ...headers(), 'x-device-id': 'coaster-02' } ]) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: extra, payload: heartbeat })).statusCode, 401);
  }
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: { ...headers(), origin: 'http://localhost:5173' }, payload: heartbeat })).statusCode, 403);
  assert.equal((await f.app.inject({ url: '/api/dashboard', headers: headers() })).statusCode, 401);
  const production = createApp({ dbPath: ':memory:', appOrigin: 'https://coaster.example' });
  t.after(() => production.close());
  const response = await production.inject({ method: 'POST', url: '/api/auth/register', headers: { host: 'coaster.example', origin: 'https://coaster.example' }, payload: { username: 'secure_user', password: 'password-123' } });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['set-cookie']), /; Secure/);
});

test('绑定码仅在线设备申请，过期、消费、抢绑和一人多设备均拒绝', async (t) => {
  const f = await fixture(t);
  const user = await f.register();
  const other = await f.register('user_two');
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/device/binding', headers: headers(), payload: {} })).statusCode, 503);
  const first = await f.code();
  assert.match(first.code, /^[0-9]{8}$/);
  const db = openDatabase(f.dbPath);
  assert.notEqual(db.prepare('SELECT code_hash FROM binding_codes').get()!.code_hash, first.code);
  db.close();
  f.advance(5 * 60_000);
  await f.report();
  const expired = await f.web(user, '/api/devices/bind', { code: first.code });
  assert.equal(expired.statusCode, 400); assert.match(expired.json().error, /绑定码无效或已过期/);
  const fresh = await f.code();
  f.advance(90_001);
  assert.equal((await f.web(user, '/api/devices/bind', { code: fresh.code })).statusCode, 409);
  await f.report();
  assert.equal((await f.web(user, '/api/devices/bind', { code: fresh.code })).statusCode, 200);
  assert.equal((await f.web(other, '/api/devices/bind', { code: fresh.code })).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/device/binding', headers: headers(), payload: {} })).statusCode, 409);
  const second = await f.code('coaster-02');
  assert.equal((await f.web(user, '/api/devices/bind', { code: second.code })).statusCode, 409);
  assert.equal((await f.web(other, '/api/devices/bind', { code: second.code })).statusCode, 200);
  assert.equal((await f.web(user, '/api/auth/session')).json().deviceId, 'coaster-01');
  assert.equal((await f.report()).json().bound, true);
});

test('登录和绑定尝试限速', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register();
  for (let i = 0; i < 10; i++) assert.equal((await f.web(cookie, '/api/devices/bind', { code: '00000000' })).statusCode, 400);
  assert.equal((await f.web(cookie, '/api/devices/bind', { code: '00000000' })).statusCode, 429);
  for (let i = 0; i < 15; i++) assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'user_one', password: 'incorrect' } })).statusCode, 401);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'user_one', password: 'incorrect' } })).statusCode, 429);
});

test('按上海时区分日、饮水补水分别统计，重传去重和冲突回滚', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register(); await f.bind(cookie);
  const records = [event({ occurredAt: '2026-10-08T15:59:59Z' }), event({ occurredAt: '2026-10-08T16:00:00Z', amountMl: 75, afterGrams: 425 }), event({ kind: 'refill', amountMl: 100, beforeGrams: 425, afterGrams: 525 })];
  assert.equal((await f.upload(records)).json().inserted, 3);
  assert.equal((await f.upload(records)).json().inserted, 0);
  assert.equal((await f.upload([event(), { ...records[1], amountMl: 100, afterGrams: 400 }])).statusCode, 409);
  const data = (await f.web(cookie, '/api/dashboard')).json();
  assert.deepEqual(data.totals, { drinkMl: 75, refillMl: 100, drinkCount: 1 });
  assert.equal(data.events.length, 2);
  assert.equal(data.week.length, 7);
  assert.equal(data.week[5].drinkMl, 50);
  assert.equal(data.week[6].drinkMl, 75);
  assert.equal(data.week[0].drinkMl, 0);
});

test('夏令时两个同名小时均计入同一天', async (t) => {
  const f = await fixture(t, { timeZone: 'America/New_York' });
  const cookie = await f.register(); await f.bind(cookie);
  await f.upload([event({ occurredAt: '2026-11-01T01:30:00-04:00' }), event({ occurredAt: '2026-11-01T01:30:00-05:00' })]);
  assert.equal((await f.web(cookie, '/api/dashboard?date=2026-11-01')).json().totals.drinkMl, 100);
});

test('账号只能读取并撤销自己设备记录；撤销幂等且重传不恢复', async (t) => {
  const f = await fixture(t);
  const one = await f.register(); await f.bind(one);
  const two = await f.register('user_two'); await f.bind(two, 'coaster-02');
  const record = event(); await f.upload([record]);
  assert.equal((await f.web(two, '/api/dashboard')).json().totals.drinkMl, 0);
  assert.equal((await f.web(two, `/api/events/${record.id}/revoke`, {})).statusCode, 404);
  for (let i = 0; i < 2; i++) assert.equal((await f.web(one, `/api/events/${record.id}/revoke`, {})).statusCode, 200);
  assert.equal((await f.upload([record])).json().inserted, 0);
  const data = (await f.web(one, '/api/dashboard')).json();
  assert.equal(data.totals.drinkMl, 0);
  assert.ok(data.events[0].revokedAt);
  assert.equal((await f.web(one, `/api/events/${randomUUID()}/revoke`, {})).statusCode, 404);
});

test('拒绝无效事件、日期和矛盾心跳；重量为空不虚构数值', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register(); await f.bind(cookie);
  for (const item of [event({ id: 'invalid' }), event({ amountMl: 49 }), event({ kind: 'refill' }), event({ afterGrams: -1 }), event({ occurredAt: '2026-02-30T01:00:00Z' }), event({ amountMl: '50' }), event({ extra: true })]) assert.equal((await f.upload([item])).statusCode, 400);
  for (const date of ['2026-02-30', '2026-13-01', 'bad']) assert.equal((await f.web(cookie, `/api/dashboard?date=${date}`)).statusCode, 400);
  const uncalibrated = { ...heartbeat, weightGrams: null, stable: false, calibrated: false, emptyCupGrams: null, pendingCount: 2, timePendingCount: 1, error: '请联系售后检查出厂标定' };
  assert.equal((await f.report('coaster-01', uncalibrated)).statusCode, 200);
  assert.equal((await f.web(cookie, '/api/dashboard')).json().device.weightGrams, null);
  for (const payload of [{ ...uncalibrated, stable: true }, { ...uncalibrated, weightGrams: 1 }, { ...heartbeat, timePendingCount: 1 }]) assert.equal((await f.report('coaster-01', payload)).statusCode, 400);
});

test('数据库重开与Wi-Fi地址变化保留账号归属、事件、撤销和最后状态', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register(); await f.bind(cookie);
  const record = event(); await f.upload([record, event()]);
  await f.web(cookie, `/api/events/${record.id}/revoke`, {});
  await f.app.close();
  const app = createApp({ dbPath: f.dbPath, now: f.now });
  try {
    const read = () => app.inject({ url: '/api/dashboard', headers: { cookie } });
    assert.equal((await read()).json().totals.drinkMl, 50);
    f.advance(90_001);
    assert.equal((await read()).json().device.online, false);
    assert.equal((await app.inject({ method: 'POST', url: '/api/device/heartbeat', remoteAddress: '203.0.113.50', headers: headers(), payload: heartbeat })).json().bound, true);
    assert.equal((await read()).json().device.online, true);
    assert.equal((await read()).json().events.length, 2);
  } finally { await app.close(); }
});

test('已有设备兼容旧配置，重复登记不旋转凭证且禁止共享密钥', async (t) => {
  const f = await fixture(t);
  const db = openDatabase(f.dbPath);
  assert.throws(() => provisionDevice(db, 'coaster-01'), /已存在/);
  assert.throws(() => provisionDevice(db, 'coaster-03', 'test-token-coaster-01'), /独立凭证/);
  db.close();
  const migrated = createApp({ dbPath: f.dbPath, deviceId: 'coaster-01', deviceToken: 'test-token-coaster-01' });
  await migrated.close();
  assert.throws(() => createApp({ dbPath: f.dbPath, deviceId: 'coaster-01', deviceToken: 'changed-token' }), /不一致/);
});


test('只信任本机反代的客户端地址，公网伪造转发头不能绕过限速', async (t) => {
  const f = await fixture(t, { trustProxy: ['127.0.0.1', '::1'] });
  const register = (index: number, remoteAddress: string) => f.app.inject({
    method: 'POST', url: '/api/auth/register', remoteAddress,
    headers: { 'x-forwarded-for': `198.51.100.${index + 1}` },
    payload: { username: `proxy_user_${index}`, password: 'password-123' },
  });
  for (let index = 0; index < 11; index++) assert.equal((await register(index, '127.0.0.1')).statusCode, 200);
  for (let index = 20; index < 30; index++) assert.equal((await register(index, '203.0.113.8')).statusCode, 200);
  assert.equal((await register(30, '203.0.113.8')).statusCode, 429);
});
