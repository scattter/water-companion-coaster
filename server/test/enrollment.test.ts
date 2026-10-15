import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import { hash, openDatabase } from '../src/db.js';
import { fixture, headers, event } from './cloud-fixture.js';

const hardwareId = 'aabbccddeeff';
const lan = 'http://192.168.1.10:3001';
function proof(token: string, operationId: string, ticket: string, hardware = hardwareId) {
  return createHmac('sha256', Buffer.from(hash(token), 'hex')).update(`${operationId}\n${hardware}\n${ticket}`).digest('hex');
}
async function enrolledFixture(t: TestContext) {
  const f = await fixture(t, { allowLocalHttp: true, serverUrl: lan });
  const cookie = await f.register();
  const issue = (owner = cookie, hardware = hardwareId, deviceId: string | null = null) => f.web(owner, '/api/enrollment/operations', {
    hardwareId: hardware, deviceId, challenge: randomBytes(32).toString('hex'),
  });
  const call = (kind: 'claim' | 'query', op: Record<string, any>, extra = {}) => f.app.inject({ method: 'POST', url: `/api/enrollment/${kind}`,
    payload: { operationId: op.operationId, hardwareId: op.hardwareId, ticket: op.ticket, ...extra } });
  const complete = (op: Record<string, any>, result: Record<string, any>) => f.app.inject({ method: 'POST', url: '/api/device/enrollment/complete',
    headers: { 'x-device-id': result.deviceId, authorization: `Bearer ${result.token}` },
    payload: { operationId: op.operationId, bindingId: result.bindingId } });
  return { ...f, cookie, issue, call, complete };
}

test('普通账号首次配网自动生成身份，凭证不进入网页，丢失回执可跨服务重启恢复', async (t) => {
  const f = await enrolledFixture(t);
  const issued = await f.issue();
  assert.equal(issued.statusCode, 200, issued.body);
  const op = issued.json();
  assert.equal(op.deviceId, null);
  assert.equal(op.serverUrl, lan);
  assert.equal((await f.web(f.cookie, '/api/auth/session')).json().deviceId, null);
  const response = await f.call('claim', op);
  assert.equal(response.statusCode, 200, response.body);
  const claimed = response.json();
  assert.match(claimed.deviceId, /^coaster-[0-9]{6}$/);
  assert.match(claimed.token, /^[a-f0-9]{64}$/);
  assert.equal(claimed.status, 'claimed');
  assert.deepEqual((await f.call('claim', op)).json(), claimed);
  const web = (await f.web(f.cookie, `/api/enrollment/operations/${op.operationId}`)).json();
  assert.equal(web.status, 'claimed');
  assert.equal(web.token, undefined);
  assert.equal(web.ticket, undefined);
  const db = openDatabase(f.dbPath);
  const saved = db.prepare('SELECT * FROM enrollment_operations WHERE id = ?').get(op.operationId)!;
  assert.equal(saved.ticket_hash, hash(op.ticket));
  assert.equal(JSON.stringify(saved).includes(claimed.token), false);
  assert.equal(JSON.stringify(saved).includes(op.ticket), false);
  assert.equal(db.prepare('SELECT token_hash FROM devices WHERE id = ?').get(claimed.deviceId)!.token_hash, hash(claimed.token));
  assert.equal(db.prepare('SELECT count(*) AS n FROM deployment').get()!.n, 0);
  db.close();
  await f.app.close();
  const restored = createApp({ dbPath: f.dbPath, now: f.now, allowLocalHttp: true, serverUrl: lan });
  try {
    const recovered = await restored.inject({ method: 'POST', url: '/api/enrollment/query', payload: { operationId: op.operationId, hardwareId, ticket: op.ticket } });
    assert.deepEqual(recovered.json(), claimed);
    const done = await restored.inject({ method: 'POST', url: '/api/device/enrollment/complete',
      headers: { 'x-device-id': claimed.deviceId, authorization: `Bearer ${claimed.token}` }, payload: { operationId: op.operationId, bindingId: claimed.bindingId } });
    assert.equal(done.statusCode, 200, done.body);
    const final = (await restored.inject({ method: 'POST', url: '/api/enrollment/query', payload: { operationId: op.operationId, hardwareId, ticket: op.ticket } })).json();
    assert.equal(final.status, 'completed');
    assert.equal(final.token, undefined);
  } finally { await restored.close(); }
});

test('相同硬件只能绑定一个账号，重置身份不能抢绑，原账号解绑后可转绑且历史隔离', async (t) => {
  const f = await enrolledFixture(t);
  const second = await f.register('second_user');
  const op = (await f.issue()).json();
  const competing = (await f.issue(second)).json();
  const claimed = (await f.call('claim', op)).json();
  assert.equal((await f.call('claim', competing)).statusCode, 409);
  assert.equal((await f.issue(second)).json().code, 'DEVICE_ALREADY_BOUND');
  assert.equal((await f.web(second, '/api/devices/unbind', {})).statusCode, 409);
  assert.equal((await f.complete(op, claimed)).statusCode, 200);
  const uploaded = await f.app.inject({ method: 'POST', url: '/api/device/events',
    headers: { 'x-device-id': claimed.deviceId, authorization: `Bearer ${claimed.token}` },
    payload: { events: [event({ bindingId: claimed.bindingId })] } });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  assert.equal((await f.web(f.cookie, '/api/devices/unbind', {})).statusCode, 200);
  assert.equal((await f.call('query', op)).json().token, undefined);
  assert.equal((await f.web(f.cookie, `/api/enrollment/operations/${op.operationId}`)).json().status, 'cancelled');
  const next = (await f.issue(second)).json();
  const rebound = (await f.call('claim', next)).json();
  assert.equal(rebound.deviceId, claimed.deviceId);
  assert.notEqual(rebound.bindingId, claimed.bindingId);
  assert.equal((await f.complete(next, rebound)).statusCode, 200);
  const db = openDatabase(f.dbPath);
  assert.equal(db.prepare('SELECT binding_id FROM device_events WHERE device_id = ?').get(claimed.deviceId)!.binding_id, claimed.bindingId);
  db.close();
});

test('同主人重配保留编号、凭证和绑定批次，身份凭证证明只对当前操作有效', async (t) => {
  const f = await enrolledFixture(t);
  const op = (await f.issue()).json();
  const initial = (await f.call('claim', op)).json();
  await f.complete(op, initial);
  const next = (await f.issue(f.cookie, hardwareId, initial.deviceId)).json();
  const wrong = await f.call('claim', next, { deviceId: initial.deviceId, identityProof: proof(initial.token, op.operationId, op.ticket) });
  assert.equal(wrong.statusCode, 403, wrong.body);
  const result = await f.call('claim', next, { deviceId: initial.deviceId, identityProof: proof(initial.token, next.operationId, next.ticket) });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().deviceId, initial.deviceId);
  assert.equal(result.json().bindingId, initial.bindingId);
  assert.equal(result.json().token, undefined);
  assert.equal((await f.complete(next, { ...result.json(), token: initial.token })).statusCode, 200);
});

test('旧设备自动登记硬件关联前必须验证原凭证，不需要部署公钥', async (t) => {
  const f = await enrolledFixture(t);
  const op = (await f.issue(f.cookie, hardwareId, 'coaster-01')).json();
  assert.equal((await f.call('claim', op)).json().code, 'DEVICE_AUTH_FAILED');
  const response = await f.call('claim', op, { deviceId: 'coaster-01', identityProof: proof('test-token-coaster-01', op.operationId, op.ticket) });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().deviceId, 'coaster-01');
  assert.equal(response.json().token, undefined);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/device/enrollment/complete', headers: headers(),
    payload: { operationId: op.operationId, bindingId: response.json().bindingId } })).statusCode, 200);
});

test('尚未登记的旧本机编号在首次绑定时由服务端重新分配', async (t) => {
  const f = await enrolledFixture(t);
  const issued = await f.issue(f.cookie, hardwareId, 'coaster-local');
  assert.equal(issued.statusCode, 200, issued.body);
  const op = issued.json();
  assert.equal(op.deviceId, null);
  const response = await f.call('claim', op, { deviceId: 'coaster-local', identityProof: proof('local-development-token', op.operationId, op.ticket) });
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.json().deviceId, /^coaster-[0-9]{6}$/);
  assert.equal((await f.complete(op, response.json())).statusCode, 200);
});

test('同一账号并发认领两台设备只成功一次，取消重配不会使原凭证失效', async (t) => {
  const f = await enrolledFixture(t);
  const first = (await f.issue()).json();
  const second = (await f.issue(f.cookie, '001122334455')).json();
  const results = await Promise.all([f.call('claim', first), f.call('claim', second)]);
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409]);
  const claimed = results[0].statusCode === 200 ? results[0].json() : results[1].json();
  const active = results[0].statusCode === 200 ? first : second;
  await f.complete(active, claimed);
  const next = (await f.issue(f.cookie, active.hardwareId, claimed.deviceId)).json();
  const retry = await f.call('claim', next, { deviceId: claimed.deviceId,
    identityProof: proof(claimed.token, next.operationId, next.ticket, active.hardwareId) });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal((await f.web(f.cookie, '/api/devices/unbind', {})).statusCode, 200);
  const cancelled = (await f.call('query', next)).json();
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.token, undefined);
  const db = openDatabase(f.dbPath);
  assert.equal(db.prepare('SELECT token_hash FROM devices WHERE id = ?').get(claimed.deviceId)!.token_hash, hash(claimed.token));
  db.close();
});

test('过期或无效票据不登记设备，浏览器不能调用设备入口，查询仅限发起人', async (t) => {
  const f = await enrolledFixture(t);
  const other = await f.register('another_user');
  const op = (await f.issue()).json();
  assert.equal((await f.web(other, `/api/enrollment/operations/${op.operationId}`)).statusCode, 404);
  assert.equal((await f.call('claim', { ...op, ticket: '0'.repeat(64) })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/enrollment/claim', headers: { origin: 'http://localhost:5173' },
    payload: { operationId: op.operationId, hardwareId, ticket: op.ticket } })).statusCode, 403);
  f.advance(300001);
  assert.equal((await f.call('claim', op)).json().code, 'OPERATION_EXPIRED');
  const db = openDatabase(f.dbPath);
  assert.equal(db.prepare('SELECT count(*) AS n FROM devices WHERE hardware_id = ?').get(hardwareId)!.n, 0);
  db.close();
});

test('局域网 HTTP 只在开发配置放行，公网 HTTP 与 localhost 设备地址仍拒绝', () => {
  for (const serverUrl of ['http://127.0.0.1:3001', 'http://localhost:3001', 'http://example.com', 'http://8.8.8.8']) {
    assert.throws(() => createApp({ dbPath: ':memory:', serverUrl, allowLocalHttp: true }));
  }
  assert.throws(() => createApp({ dbPath: ':memory:', serverUrl: lan }));
});
