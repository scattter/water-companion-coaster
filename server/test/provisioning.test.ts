import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Writable } from 'node:stream';
import { createApp } from '../src/app.js';
import { hash, openDatabase, projectRoot } from '../src/db.js';
import { publicKeyHex } from '../src/signing.js';
import { validateServerOrigin } from '../src/validation.js';
import { cookieOf, event, fixture, headers, heartbeat } from './cloud-fixture.js';

function keyFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'coaster-signing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const signingKeyPath = join(directory, 'key.pem');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  writeFileSync(signingKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { directory, signingKeyPath, privateKey, deploymentId: randomUUID(), serverUrl: 'https://coaster.example' };
}
async function signedFixture(t: TestContext) {
  const keys = keyFixture(t);
  const f = await fixture(t, keys);
  const issue = async (cookie: string, deviceId = 'coaster-01', challenge = randomBytes(32).toString('hex')) => {
    const response = await f.web(cookie, '/api/provisioning/operations', { deviceId, deploymentId: keys.deploymentId, challenge });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { operationId: string; expiresAt: number; serverUrl: string; authorization: { payload: string; signature: string } };
  };
  const devicePost = (url: string, payload: Record<string, unknown>, id = 'coaster-01') => f.app.inject({ method: 'POST', url, headers: headers(id), payload });
  const claim = (op: Awaited<ReturnType<typeof issue>>, id = 'coaster-01') => devicePost('/api/device/provisioning/claim', { operationId: op.operationId, ticket: op.authorization.payload.split('\n')[8] }, id);
  const recover = (operationId: string, id = 'coaster-01') => f.app.inject({ url: `/api/device/provisioning/operations/${operationId}`, headers: headers(id) });
  const promote = async (cookie: string) => {
    const session = (await f.web(cookie, '/api/auth/session')).json();
    const db = openDatabase(f.dbPath);
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(session.user.id);
    db.close();
  };
  return { ...f, ...keys, issue, claim, devicePost, recover, promote };
}

test('P-256授权逐字段签名，ticket仅hash落库；认领/完成回执幂等并跨重启恢复', async (t) => {
  const f = await signedFixture(t);
  const cookie = await f.register();
  const challenge = randomBytes(32).toString('hex');
  const op = await f.issue(cookie, 'coaster-01', challenge);
  const parts = op.authorization.payload.split('\n');
  assert.deepEqual(parts.slice(0, 8), ['coaster-provision-v1', f.deploymentId, 'coaster-01', challenge, op.operationId, f.serverUrl, '1', String(f.now().getTime() + 300_000)]);
  assert.equal(parts.length, 9);
  assert.match(parts[8], /^[a-f0-9]{64}$/);
  assert.match(op.authorization.signature, /^[a-f0-9]{128}$/);
  const publicKey = createPublicKey(f.privateKey);
  const valid = (payload: string) => verify('sha256', Buffer.from(payload), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(op.authorization.signature, 'hex'));
  assert.equal(valid(op.authorization.payload), true);
  for (let index = 0; index < parts.length; index++) assert.equal(valid(parts.map((part, i) => i === index ? `${part}x` : part).join('\n')), false);
  const db = openDatabase(f.dbPath);
  const saved = db.prepare('SELECT * FROM provisioning_operations').get()!;
  assert.equal(saved.ticket_hash, hash(parts[8]));
  assert.equal(JSON.stringify(saved).includes(parts[8]), false);
  db.close();
  assert.equal((await f.recover(op.operationId)).json().status, 'issued');
  assert.equal((await f.devicePost('/api/device/provisioning/complete', { operationId: op.operationId, bindingId: randomUUID() })).json().code, 'OPERATION_NOT_CLAIMED');
  assert.equal((await f.claim(op, 'coaster-02')).statusCode, 404);
  assert.equal((await f.devicePost('/api/device/provisioning/claim', { operationId: op.operationId, ticket: '0'.repeat(64) })).json().code, 'INVALID_TICKET');
  const claimed = await f.claim(op);
  assert.equal(claimed.statusCode, 200, claimed.body);
  const bindingId = claimed.json().bindingId;
  assert.ok(bindingId);
  assert.equal(claimed.json().status, 'claimed');
  assert.deepEqual((await f.claim(op)).json(), claimed.json());
  assert.equal((await f.web(cookie, '/api/auth/session')).json().bindingId, bindingId);
  f.advance(300_001);
  assert.equal((await f.claim(op)).json().status, 'claimed');
  assert.equal((await f.devicePost('/api/device/provisioning/complete', { operationId: op.operationId, bindingId: randomUUID() })).json().code, 'BINDING_MISMATCH');
  for (let index = 0; index < 2; index++) assert.deepEqual((await f.devicePost('/api/device/provisioning/complete', { operationId: op.operationId, bindingId })).json(), { ok: true, status: 'completed' });
  assert.equal((await f.claim(op)).json().status, 'completed');
  await f.app.close();
  const restored = createApp({ dbPath: f.dbPath, now: f.now });
  try {
    const response = await restored.inject({ url: `/api/device/provisioning/operations/${op.operationId}`, headers: headers() });
    assert.equal(response.json().status, 'completed'); assert.equal(response.json().bindingId, bindingId);
    const repeated = await restored.inject({ method: 'POST', url: '/api/device/provisioning/complete', headers: headers(), payload: { operationId: op.operationId, bindingId } });
    assert.equal(repeated.statusCode, 200);
  } finally { await restored.close(); }
});

test('并发抢绑与一人多设备事务隔离，查询归发起人，同主人重配复用批次', async (t) => {
  const f = await signedFixture(t);
  const one = await f.register();
  const two = await f.register('second_user');
  const op1 = await f.issue(one);
  const op2 = await f.issue(two);
  assert.equal((await f.web(two, `/api/provisioning/operations/${op1.operationId}`)).statusCode, 404);
  assert.equal((await f.recover(op1.operationId, 'coaster-02')).statusCode, 404);
  const claims = await Promise.all([f.claim(op1), f.claim(op2)]);
  assert.equal(claims.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(claims.filter((r) => r.statusCode === 409).length, 1);
  const winner = claims[0].statusCode === 200 ? one : two;
  const loser = winner === one ? two : one;
  const bindingId = claims.find((r) => r.statusCode === 200)!.json().bindingId;
  const reconfiguration = await f.issue(winner);
  assert.equal((await f.claim(reconfiguration)).json().bindingId, bindingId);
  assert.equal((await f.web(loser, '/api/provisioning/operations', { deviceId: 'coaster-01', deploymentId: f.deploymentId, challenge: randomBytes(32).toString('hex') })).json().code, 'DEVICE_ALREADY_BOUND');
  assert.equal((await f.web(winner, '/api/provisioning/operations', { deviceId: 'coaster-02', deploymentId: f.deploymentId, challenge: randomBytes(32).toString('hex') })).json().code, 'USER_ALREADY_BOUND');
  await f.web(winner, '/api/devices/unbind', {});
  const a = await f.issue(winner);
  const b = await f.issue(winner, 'coaster-02');
  const both = await Promise.all([f.claim(a), f.claim(b, 'coaster-02')]);
  assert.equal(both.filter((r) => r.statusCode === 200).length, 1);
  assert.equal(both.filter((r) => r.json().code === 'USER_ALREADY_BOUND').length, 1);
  const failed = both[0].statusCode === 200 ? b : a;
  assert.equal((await f.web(winner, `/api/provisioning/operations/${failed.operationId}`)).json().status, 'failed');
});

test('授权过期、challenge重放、部署不符与严格请求schema', async (t) => {
  const f = await signedFixture(t);
  const cookie = await f.register();
  const body = { deviceId: 'coaster-01', deploymentId: f.deploymentId, challenge: 'a'.repeat(64) };
  for (const payload of [{ ...body, extra: true }, { ...body, challenge: 'A'.repeat(64) }, { ...body, challenge: `${body.challenge}\n` }, { ...body, deviceId: 'coaster-01\n' }, { ...body, deploymentId: 5 }]) {
    assert.equal((await f.web(cookie, '/api/provisioning/operations', payload)).statusCode, 400);
  }
  assert.equal((await f.web(cookie, '/api/provisioning/operations', { ...body, deploymentId: randomUUID() })).json().code, 'DEPLOYMENT_MISMATCH');
  const op = await f.issue(cookie, body.deviceId, body.challenge);
  assert.equal((await f.web(cookie, '/api/provisioning/operations', body)).json().code, 'CHALLENGE_REUSED');
  for (const payload of [{ operationId: op.operationId }, { operationId: op.operationId, ticket: 'a'.repeat(64), ssid: 'secret' }]) assert.equal((await f.devicePost('/api/device/provisioning/claim', payload)).statusCode, 400);
  f.advance(300_000);
  assert.equal((await f.claim(op)).json().code, 'OPERATION_EXPIRED');
  assert.equal((await f.recover(op.operationId)).json().status, 'expired');
  assert.equal((await f.web(cookie, `/api/provisioning/operations/${op.operationId}`)).json().bindingId, null);
  assert.equal((await f.web(cookie, '/api/devices/unbind', { deviceId: 'coaster-02' })).statusCode, 400);
});

test('解绑废止回执/票据/命令/绑定码，旧主人历史可读可撤销而新主人无法访问', async (t) => {
  const f = await signedFixture(t);
  const one = await f.register();
  const two = await f.register('next_owner');
  const op = await f.issue(one);
  const bindingId = (await f.claim(op)).json().bindingId;
  await f.devicePost('/api/device/provisioning/complete', { operationId: op.operationId, bindingId });
  await f.report('coaster-01', { ...heartbeat, provisioningVersion: 1, bindingId });
  const record = event({ bindingId });
  await f.upload([record]);
  const commandId = randomUUID();
  assert.equal((await f.web(one, '/api/control/cup', { id: commandId })).statusCode, 200);
  const pending = await f.issue(one);
  assert.equal((await f.web(two, '/api/devices/unbind', {})).json().code, 'NO_BINDING');
  assert.equal((await f.web(one, '/api/devices/unbind', {})).statusCode, 200);
  for (const operation of [op, pending]) {
    assert.equal((await f.recover(operation.operationId)).json().status, 'cancelled');
    assert.equal((await f.claim(operation)).json().code, 'BINDING_ENDED');
  }
  assert.equal((await f.devicePost('/api/device/provisioning/complete', { operationId: op.operationId, bindingId })).json().code, 'BINDING_ENDED');
  const old = (await f.web(one, '/api/dashboard')).json();
  assert.equal(old.device, null); assert.equal(old.totals.drinkMl, 50);
  const next = await f.issue(two);
  const nextBinding = (await f.claim(next)).json().bindingId;
  assert.notEqual(nextBinding, bindingId);
  assert.equal((await f.web(two, '/api/dashboard')).json().totals.drinkMl, 0);
  assert.equal((await f.web(two, `/api/events/${record.id}/revoke`, {})).statusCode, 404);
  assert.equal((await f.web(two, `/api/control/commands/${commandId}`)).statusCode, 404);
  assert.equal((await f.web(two, '/api/control/cup', { id: commandId })).statusCode, 404);
  const stale = await f.report('coaster-01', { ...heartbeat, weightGrams: 999, bindingId, provisioningVersion: 1, commandResult: { id: commandId, ok: true, message: 'old', bindingId } });
  assert.equal(stale.json().command, null); assert.equal(stale.json().bindingId, nextBinding);
  assert.equal((await f.web(two, '/api/dashboard')).json().device.weightGrams, null);
  await f.upload([event({ bindingId }), event({ bindingId: nextBinding }), event({ bindingId: null })]);
  assert.equal((await f.web(one, '/api/dashboard')).json().totals.drinkMl, 100);
  assert.equal((await f.web(two, '/api/dashboard')).json().totals.drinkMl, 50);
  assert.equal((await f.web(one, `/api/events/${record.id}/revoke`, {})).statusCode, 200);
  const db = openDatabase(f.dbPath);
  assert.equal(db.prepare('SELECT status FROM device_commands WHERE id = ?').get(commandId)!.status, 'expired');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM binding_codes').get()!.n, 0);
  assert.ok(db.prepare('SELECT ended_at FROM device_bindings WHERE id = ?').get(bindingId)!.ended_at);
  db.close();
});

test('新版命令确认要求当前批次，旧批次和旧协议心跳不刷新新主人状态或命令', async (t) => {
  const f = await signedFixture(t);
  const user = await f.register();
  const bindingId = (await f.claim(await f.issue(user))).json().bindingId;
  await f.report('coaster-01', { ...heartbeat, provisioningVersion: 1, bindingId });
  const id = randomUUID();
  await f.web(user, '/api/control/cup', { id });
  const pending = (await f.report('coaster-01', { ...heartbeat, provisioningVersion: 1, bindingId })).json().command;
  assert.equal(pending.bindingId, bindingId);
  assert.equal((await f.report()).json().command, null);
  for (const receiptBinding of [undefined, null]) {
    const upgraded = await f.report('coaster-01', { ...heartbeat, provisioningVersion: 1, bindingId, commandResult: { id, ok: true, message: '', bindingId: receiptBinding } });
    assert.equal(upgraded.statusCode, 200); assert.equal(upgraded.json().bindingId, bindingId);
    assert.equal((await f.web(user, `/api/control/commands/${id}`)).json().command.status, 'pending');
  }
  await f.report('coaster-01', { ...heartbeat, provisioningVersion: 1, bindingId, commandResult: { id, ok: true, message: '', bindingId: randomUUID() } });
  assert.equal((await f.web(user, `/api/control/commands/${id}`)).json().command.status, 'pending');
  await f.report('coaster-01', { ...heartbeat, provisioningVersion: 1, bindingId, commandResult: { id, ok: true, message: '', bindingId } });
  assert.equal((await f.web(user, `/api/control/commands/${id}`)).json().command.status, 'succeeded');
  f.advance(15_001);
  await f.report();
  assert.equal((await f.web(user, '/api/dashboard')).json().device.online, false);
  assert.equal((await f.web(user, '/api/control/cup', { id: randomUUID() })).json().code, 'DEVICE_OFFLINE');
});

test('旧8位码共用批次事务，未绑定与null事件隔离，离线legacy队列只归原批次', async (t) => {
  const f = await fixture(t);
  const rawUpload = (records: ReturnType<typeof event>[]) => f.app.inject({ method: 'POST', url: '/api/device/events', headers: headers(), payload: { events: records } });
  const first = await f.register();
  const second = await f.register('legacy_next');
  const unbound = event({ occurredAt: f.now().toISOString() });
  assert.equal((await rawUpload([unbound])).statusCode, 200);
  f.advance(1000);
  await f.bind(first);
  const bindingId = (await f.web(first, '/api/auth/session')).json().bindingId;
  assert.equal((await rawUpload([unbound])).json().inserted, 0);
  const oldUnuploaded = event({ occurredAt: new Date(f.now().getTime() - 2000).toISOString() });
  const owned = event({ occurredAt: f.now().toISOString() });
  const delayed = event({ occurredAt: f.now().toISOString() });
  await rawUpload([oldUnuploaded, owned, event({ bindingId: null, occurredAt: f.now().toISOString() })]);
  assert.equal((await f.web(first, '/api/dashboard')).json().totals.drinkMl, 50);
  f.advance(1000);
  await f.web(first, '/api/devices/unbind', {});
  const code = await f.code();
  assert.equal((await f.web(second, '/api/devices/bind', { code: code.code })).json().code, 'BINDING_VERSION_REQUIRED');
  await f.report('coaster-01', { ...heartbeat, provisioningVersion: 1, bindingId: null });
  const rebound = await f.web(second, '/api/devices/bind', { code: code.code });
  assert.equal(rebound.statusCode, 200, rebound.body);
  const newBinding = rebound.json().bindingId;
  assert.notEqual(newBinding, bindingId);
  await rawUpload([delayed, event({ occurredAt: f.now().toISOString() }), event({ bindingId: null })]);
  assert.equal((await f.web(first, '/api/dashboard')).json().totals.drinkMl, 100);
  assert.equal((await f.web(second, '/api/dashboard')).json().totals.drinkMl, 0);
  const upgradedRetry = await rawUpload([event({ ...owned, bindingId: null })]);
  assert.equal(upgradedRetry.statusCode, 200); assert.equal(upgradedRetry.json().inserted, 0);
  assert.equal((await f.web(first, '/api/dashboard')).json().totals.drinkMl, 100);
  assert.equal((await f.web(second, '/api/dashboard')).json().totals.drinkMl, 0);
  assert.equal((await f.report()).json().command, null);
  const db = openDatabase(f.dbPath);
  assert.equal(db.prepare('SELECT binding_id FROM device_events WHERE id = ?').get(unbound.id)!.binding_id, null);
  assert.equal(db.prepare('SELECT binding_id FROM device_events WHERE id = ?').get(delayed.id)!.binding_id, bindingId);
  db.close();
});

test('事件不能偷换批次或借用其他设备批次，冲突整批回滚', async (t) => {
  const f = await signedFixture(t);
  const one = await f.register(); const two = await f.register('events_two');
  const binding1 = (await f.claim(await f.issue(one))).json().bindingId;
  const binding2 = (await f.claim(await f.issue(two, 'coaster-02'), 'coaster-02')).json().bindingId;
  const original = event({ bindingId: binding1 });
  await f.upload([original]);
  assert.equal((await f.upload([event({ ...original, bindingId: null })])).json().inserted, 0);
  assert.equal((await f.upload([event({ bindingId: binding1 }), event({ ...original, bindingId: randomUUID() })])).json().code, 'BINDING_MISMATCH');
  assert.equal((await f.upload([event({ bindingId: binding1 }), event({ ...original, amountMl: 75, afterGrams: 425, bindingId: null })])).json().code, 'EVENT_CONFLICT');
  assert.equal((await f.upload([event({ bindingId: binding1 }), event({ bindingId: binding2 })])).json().code, 'BINDING_MISMATCH');
  assert.equal((await f.web(one, '/api/dashboard')).json().events.length, 1);
});

test('管理员权限与公共注册隔离；HTTP与CLI共享原子登记核心，不返回凭证', async (t) => {
  const f = await signedFixture(t);
  const user = await f.register();
  assert.equal((await f.web(user, '/api/admin/devices')).json().code, 'ADMIN_REQUIRED');
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'self_admin', password: 'password-123', role: 'admin' } })).statusCode, 400);
  await f.promote(user);
  assert.equal((await f.web(user, '/api/auth/session')).json().user.role, 'admin');
  const device = { id: 'coaster-000101', token: 'admin-manual-token-123' };
  assert.deepEqual((await f.web(user, '/api/admin/devices', device)).json(), { inserted: 1, skipped: 0 });
  assert.deepEqual((await f.web(user, '/api/admin/devices', device)).json(), { inserted: 0, skipped: 1 });
  assert.equal((await f.web(user, '/api/admin/devices', { ...device, token: 'changed-token-12345' })).json().code, 'DEVICE_CREDENTIAL_CONFLICT');
  const devices = [{ id: 'coaster-000102', tokenHash: hash('import-new-secret'), createdAt: 100 }, { id: device.id, tokenHash: hash('conflict-secret'), createdAt: 100 }];
  assert.equal((await f.web(user, '/api/admin/devices/import', { version: 1, devices })).statusCode, 409);
  assert.equal((await f.web(user, '/api/admin/devices')).body.includes('coaster-000102'), false);
  assert.equal((await f.web(user, '/api/admin/devices/import', { version: 1, devices: [devices[0], devices[0]] })).json().code, 'INVALID_REGISTRY');
  assert.deepEqual((await f.web(user, '/api/admin/devices/import', { version: 1, devices: [{ id: device.id, tokenHash: hash(device.token), createdAt: 0 }] })).json(), { inserted: 0, skipped: 1 });
  const listing = await f.web(user, '/api/admin/devices');
  for (const value of [device.token, hash(device.token), 'tokenHash', 'token_hash']) assert.equal(listing.body.includes(value), false);
  assert.deepEqual(Object.keys(listing.json().devices[0]).sort(), ['bound', 'createdAt', 'id', 'username']);
});

test('管理员HTTPS地址严格校验、配置版本幂等且撤销旧签发授权，重启不覆盖设置', async (t) => {
  const f = await signedFixture(t);
  const admin = await f.register(); await f.promote(admin);
  const first = await f.issue(admin);
  for (const serverUrl of ['http://192.168.1.2', 'https://coaster.example/path', 'https://coaster.example/a/..', 'https://coaster.example?', 'https://coaster.example#', 'https://@coaster.example', 'https://user:pass@coaster.example', ' https://coaster.example', 'https://[::1]', 'https://host_name', 'https://host:0', `https://${'a'.repeat(184)}.example`]) {
    assert.equal((await f.web(admin, '/api/admin/settings', { serverUrl })).statusCode, 400, serverUrl);
  }
  const config = (await f.web(admin, '/api/admin/settings', { serverUrl: 'https://NEW.example:443/' })).json();
  assert.equal(config.serverUrl, 'https://new.example'); assert.equal(config.configVersion, 2);
  assert.equal(config.signingReady, true); assert.equal(config.publicKey, publicKeyHex(f.privateKey));
  assert.equal((await f.web(admin, '/api/admin/settings', { serverUrl: config.serverUrl })).json().configVersion, 2);
  assert.equal((await f.claim(first)).json().code, 'CONFIG_CHANGED');
  assert.equal((await f.recover(first.operationId)).json().status, 'cancelled');
  const fresh = await f.issue(admin);
  assert.equal(fresh.serverUrl, config.serverUrl); assert.equal(fresh.authorization.payload.split('\n')[6], '2');
  await f.app.close();
  const restarted = createApp({ dbPath: f.dbPath, now: f.now, signingKeyPath: f.signingKeyPath, deploymentId: f.deploymentId, serverUrl: 'https://ignored.example' });
  try {
    const result = (await restarted.inject({ url: '/api/admin/settings', headers: { cookie: admin } })).json();
    assert.equal(result.serverUrl, config.serverUrl); assert.equal(result.configVersion, 2);
  } finally { await restarted.close(); }
  for (const invalid of ['https://host/../', 'https://host\\path', 'https://host\n', 'https://[2001:db8::1]', 'https://host.', 'https://-host.example', 'https://host-.example', 'https://host..example', `https://${'a'.repeat(64)}.example`, 'https://host:', 'https://host:000443']) assert.throws(() => validateServerOrigin(invalid));
});

test('签名可选且缺文件明确不可用，固定部署/公钥阻止意外替换或错误数据库恢复', async (t) => {
  const keys = keyFixture(t);
  const f = await fixture(t);
  const cookie = await f.register();
  assert.equal((await f.web(cookie, '/api/provisioning/operations', { deviceId: 'coaster-01', deploymentId: keys.deploymentId, challenge: 'a'.repeat(64) })).json().code, 'SIGNING_NOT_READY');
  await f.bind(cookie);
  await f.app.close();
  const configured = createApp({ dbPath: f.dbPath, ...keys });
  await configured.close();
  const noKey = createApp({ dbPath: f.dbPath, signingKeyPath: join(keys.directory, 'absent.pem'), deploymentId: keys.deploymentId });
  await noKey.close();
  assert.throws(() => createApp({ dbPath: f.dbPath, ...keys, deploymentId: randomUUID() }), /部署不一致/);
  const other = keyFixture(t);
  assert.throws(() => createApp({ dbPath: f.dbPath, signingKeyPath: other.signingKeyPath, deploymentId: keys.deploymentId }), /公钥不一致/);
  assert.throws(() => createApp({ dbPath: ':memory:', signingKeyPath: keys.signingKeyPath }), /PROVISION_DEPLOYMENT_ID/);
  const badKey = join(keys.directory, 'bad.pem');
  writeFileSync(badKey, 'not-a-private-key');
  assert.throws(() => createApp({ dbPath: ':memory:', signingKeyPath: badKey, deploymentId: keys.deploymentId }), /P-256/);
  const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
  writeFileSync(badKey, wrongCurve.export({ type: 'pkcs8', format: 'pem' }));
  assert.throws(() => createApp({ dbPath: ':memory:', signingKeyPath: badKey, deploymentId: keys.deploymentId }), /P-256/);
  const db = openDatabase(f.dbPath);
  assert.equal(db.prepare('SELECT deployment_id, public_key FROM deployment').get()!.deployment_id, keys.deploymentId);
  assert.equal(db.prepare('SELECT public_key FROM deployment').get()!.public_key, publicKeyHex(keys.privateKey));
  db.close();
});

test('key/admin CLI显式初始化，PEM权限0600、公开输出、不覆盖文件或自动选择账号', async (t) => {
  const f = await fixture(t);
  const directory = join(f.dbPath, '..');
  const output = join(directory, 'cli-private.pem');
  const cli = (name: string, args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(projectRoot, `server/src/${name}.ts`), ...args], {
    cwd: join(projectRoot, 'server'), env: { ...process.env, DB_PATH: relative(projectRoot, f.dbPath) }, encoding: 'utf8',
  });
  const generated = cli('provisioning-key', ['--out', relative(projectRoot, output)]);
  assert.equal(generated.status, 0, generated.stderr);
  const trust = JSON.parse(generated.stdout);
  assert.deepEqual(Object.keys(trust).sort(), ['deploymentId', 'publicKey']);
  assert.match(trust.publicKey, /^04[a-f0-9]{128}$/);
  const pem = readFileSync(output, 'utf8');
  assert.equal(publicKeyHex(createPrivateKey(pem)), trust.publicKey);
  assert.equal(generated.stdout.includes('PRIVATE KEY'), false);
  if (process.platform !== 'win32') assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.equal(cli('provisioning-key', ['--out', output]).status, 1);
  assert.equal(readFileSync(output, 'utf8'), pem);
  assert.equal(cli('provisioning-key', ['--out', `${output}.bad`, '--deployment-id', 'invalid']).status, 1);
  const first = await f.register(); await f.register('explicit_admin');
  assert.equal(cli('admin', []).status, 1);
  assert.equal(cli('admin', ['--username', 'missing_user']).status, 1);
  assert.equal((await f.web(first, '/api/auth/session')).json().user.role, 'user');
  for (let i = 0; i < 2; i++) assert.equal(cli('admin', ['--username', 'EXPLICIT_ADMIN']).status, 0);
  const db = openDatabase(f.dbPath);
  assert.deepEqual(db.prepare("SELECT username FROM users WHERE role = 'admin'").all().map((row) => row.username), ['explicit_admin']);
  db.close();
});

test('日志不包含凭证、cookie、票据或Wi-Fi内容，包括非法JSON和错误路径', async (t) => {
  let logs = '';
  const stream = new Writable({ write(chunk, _encoding, done) { logs += String(chunk); done(); } });
  const f = await fixture(t, { logger: { level: 'trace', stream } });
  const cookie = await f.register();
  for (const request of [
    { method: 'POST' as const, url: '/api/device/provisioning/claim', headers: headers(), payload: { operationId: randomUUID(), ticket: 'ticket-secret-marker', ssid: 'wifi-secret-marker' } },
    { method: 'POST' as const, url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"password":"json-secret-marker"' },
    { method: 'GET' as const, url: '/api/not-a-route?token=url-secret-marker', headers: { cookie } },
  ]) await f.app.inject(request);
  for (const secret of ['test-token-coaster-01', cookie.split('=')[1], 'ticket-secret-marker', 'wifi-secret-marker', 'json-secret-marker', 'url-secret-marker', 'password-123']) {
    assert.equal(logs.includes(secret), false, 'request secrets must not appear in logs');
  }
});

test('版本化迁移为明确归属生成legacy批次，未归属隔离，重开不会重复或夺取历史', (t) => {
  const keys = keyFixture(t);
  const dbPath = join(keys.directory, 'legacy.sqlite');
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE devices(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT UNIQUE REFERENCES users(id), created_at INTEGER NOT NULL);
    CREATE TABLE device_events(device_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, amount_ml REAL NOT NULL, before_grams REAL NOT NULL, after_grams REAL NOT NULL, occurred_at TEXT NOT NULL, revoked_at TEXT, PRIMARY KEY(device_id,id));
    CREATE TABLE device_status(id TEXT PRIMARY KEY, last_seen_at TEXT NOT NULL, payload TEXT NOT NULL);`);
  const userId = randomUUID();
  old.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(userId, 'old_owner', 'passwordhash', 'salt', 10);
  old.prepare('INSERT INTO devices VALUES (?, ?, ?, ?)').run('owned', hash('owned-token'), userId, 1);
  old.prepare('INSERT INTO devices VALUES (?, ?, NULL, ?)').run('unowned', hash('unowned-token'), 1);
  for (const id of ['owned', 'unowned']) {
    old.prepare('INSERT INTO device_events VALUES (?, ?, ?, ?, ?, ?, ?, NULL)').run(id, randomUUID(), 'drink', 50, 500, 450, '2026-10-09T01:00:00.000Z');
    old.prepare('INSERT INTO device_status VALUES (?, ?, ?)').run(id, '2026-10-09T01:00:00.000Z', JSON.stringify(heartbeat));
  }
  old.close();
  let db = openDatabase(dbPath);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 3);
  const bindingId = db.prepare('SELECT binding_id FROM devices WHERE id = ?').get('owned')!.binding_id;
  assert.ok(bindingId);
  assert.equal(db.prepare('SELECT binding_id FROM device_events WHERE device_id = ?').get('owned')!.binding_id, bindingId);
  assert.equal(db.prepare('SELECT binding_id FROM device_events WHERE device_id = ?').get('unowned')!.binding_id, null);
  assert.equal(db.prepare('SELECT role FROM users').get()!.role, 'user');
  db.close();
  db = openDatabase(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_bindings').get()!.n, 1);
  assert.equal(db.prepare('SELECT binding_id FROM devices WHERE id = ?').get('owned')!.binding_id, bindingId);
  db.exec('PRAGMA user_version = 999'); db.close();
  assert.throws(() => openDatabase(dbPath), /禁止降级/);
});
