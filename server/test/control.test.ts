import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, heartbeat } from './cloud-fixture.js';

test('空杯命令由设备心跳领取，设备确认前始终pending，同ID重试只返回原命令', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register(); await f.bind(cookie);
  const id = randomUUID();
  const first = await f.web(cookie, '/api/control/cup', { id });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().command.status, 'pending');
  assert.deepEqual((await f.web(cookie, '/api/control/cup', { id })).json(), first.json());
  assert.deepEqual((await f.web(cookie, `/api/control/commands/${id}`)).json(), first.json());
  assert.equal((await f.web(cookie, '/api/control/cup', { id: randomUUID() })).statusCode, 409);
  const command = (await f.report()).json().command;
  assert.equal(command.id, id); assert.equal(command.cmd, 'cup');
  assert.equal((await f.report()).json().command.id, id);
  const ack = await f.report('coaster-01', { ...heartbeat, emptyCupGrams: 135, commandResult: { id, ok: true, message: '空杯已记住' } });
  assert.equal(ack.json().command, null);
  const saved = (await f.web(cookie, `/api/control/commands/${id}`)).json();
  assert.equal(saved.command.status, 'succeeded');
  await f.report('coaster-01', { ...heartbeat, commandResult: { id, ok: false, message: '重复回执不能覆盖结果' } });
  assert.deepEqual((await f.web(cookie, `/api/control/commands/${id}`)).json(), saved);
  assert.deepEqual((await f.web(cookie, '/api/control/cup', { id })).json(), saved);
  assert.equal((await f.report()).json().command, null);
});

test('账号和设备之间不能读取或确认他人的命令', async (t) => {
  const f = await fixture(t);
  const one = await f.register(); await f.bind(one);
  const two = await f.register('user_two'); await f.bind(two, 'coaster-02');
  const id = randomUUID(); await f.web(one, '/api/control/cup', { id });
  assert.equal((await f.web(two, `/api/control/commands/${id}`)).statusCode, 404);
  assert.equal((await f.web(two, '/api/control/cup', { id })).statusCode, 404);
  assert.equal((await f.report('coaster-02', { ...heartbeat, commandResult: { id, ok: true, message: 'wrong device' } })).json().command, null);
  assert.equal((await f.web(one, `/api/control/commands/${id}`)).json().command.status, 'pending');
  await f.report('coaster-01', { ...heartbeat, commandResult: { id, ok: false, message: '请先放稳空杯' } });
  const failed = (await f.web(one, `/api/control/commands/${id}`)).json().command;
  assert.equal(failed.status, 'failed'); assert.equal(failed.message, '请先放稳空杯');
});

test('离线不能新建命令，过期命令不再下发，迟到确认不能变成功', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register(); await f.bind(cookie);
  f.advance(15_001);
  assert.equal((await f.web(cookie, '/api/control/cup', { id: randomUUID() })).statusCode, 409);
  await f.report();
  const id = randomUUID(); await f.web(cookie, '/api/control/cup', { id });
  f.advance(30_000);
  const ack = await f.report('coaster-01', { ...heartbeat, commandResult: { id, ok: true, message: '迟到' } });
  assert.equal(ack.json().command, null);
  assert.equal((await f.web(cookie, `/api/control/commands/${id}`)).json().command.status, 'expired');
  assert.equal((await f.web(cookie, '/api/control/cup', { id })).json().command.status, 'expired');
  assert.equal((await f.web(cookie, '/api/control/cup', { id: randomUUID() })).statusCode, 200);
});

test('云端用户接口只允许空杯设置，没有USB、归零或重量标定接口', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register(); await f.bind(cookie);
  for (const path of ['/api/setup/options', '/api/control/status']) assert.equal((await f.web(cookie, path)).statusCode, 404);
  for (const path of ['/api/control/calibrate', '/api/setup/calibrate', '/api/setup/wifi']) assert.equal((await f.web(cookie, path, { cmd: 'tare' })).statusCode, 404);
  for (const body of [{}, { id: 'bad' }, { id: randomUUID(), cmd: 'tare' }]) assert.equal((await f.web(cookie, '/api/control/cup', body)).statusCode, 400);
});
