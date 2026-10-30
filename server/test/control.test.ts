import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fixture, heartbeat } from './cloud-fixture.js';

const cups = [{ id: 1, name: '默认杯', emptyCupGrams: 120 }, { id: 2, name: '保温杯A1', emptyCupGrams: 180 }];
const multiHeartbeat = { ...heartbeat, cups, activeCupId: 1, cupSetup: null, emptyCupGrams: 120 };

test('多杯命令完整保存参数，规范化重试，同编号更换操作拒绝，确认后状态同步', async t => {
  const f = await fixture(t); const cookie = await f.register(); await f.bind(cookie);
  await f.report('coaster-01', multiHeartbeat);
  const id = randomUUID();
  const body = { id, action: 'rename', cupId: 2, name: ' 办公杯 ' };
  const first = await f.web(cookie, '/api/control/cup', body);
  assert.equal(first.statusCode, 200);
  assert.deepEqual((await f.web(cookie, '/api/control/cup', { ...body, name: '办公杯' })).json(), first.json());
  assert.equal((await f.web(cookie, '/api/control/cup', { ...body, cupId: 1 })).statusCode, 409);
  const command = (await f.report('coaster-01', multiHeartbeat)).json().command;
  assert.equal(command.action, 'rename'); assert.equal(command.cupId, 2); assert.equal(command.name, '办公杯');
  const updated = cups.map(cup => cup.id === 2 ? { ...cup, name: '办公杯' } : cup);
  await f.report('coaster-01', { ...multiHeartbeat, cups: updated, commandResult: { id, ok: true, message: '杯名已保存' } });
  assert.equal((await f.web(cookie, `/api/control/commands/${id}`)).json().command.status, 'succeeded');
  const device = (await f.web(cookie, '/api/dashboard')).json().device;
  assert.deepEqual(device.cups, updated); assert.equal(device.activeCupId, 1); assert.equal(device.emptyCupGrams, 120);
});

test('多杯设置保留准备编号，旧固件不会执行新动作', async t => {
  const f = await fixture(t); const cookie = await f.register(); await f.bind(cookie);
  const id = randomUUID();
  assert.equal((await f.web(cookie, '/api/control/cup', { id, action: 'prepare', cupId: 2, name: '水杯' })).statusCode, 409);
  await f.report('coaster-01', multiHeartbeat);
  assert.equal((await f.web(cookie, '/api/control/cup', { id, action: 'prepare', cupId: 2, name: '保温杯A1' })).statusCode, 200);
  assert.equal((await f.report()).json().command, null);
  const preparation = (await f.report('coaster-01', multiHeartbeat)).json().command;
  assert.equal(preparation.action, 'prepare'); assert.equal(preparation.id, id);
  const cupSetup = { id, cupId: 2, name: '保温杯A1', expiresAt: preparation.expiresAt + 180000 };
  await f.report('coaster-01', { ...multiHeartbeat, cupSetup, commandResult: { id, ok: true, message: '已暂停记录' } });
  assert.deepEqual((await f.web(cookie, '/api/dashboard')).json().device.cupSetup, cupSetup);
  const saveId = randomUUID();
  assert.equal((await f.web(cookie, '/api/control/cup', { id: saveId, action: 'save', setupId: id })).statusCode, 200);
  assert.equal((await f.report('coaster-01', { ...multiHeartbeat, cupSetup })).json().command.setupId, id);
});

test('多杯名称、数量、当前杯一致性及操作参数均校验', async t => {
  const f = await fixture(t); const cookie = await f.register(); await f.bind(cookie);
  await f.report('coaster-01', multiHeartbeat);
  for (const name of ['', '123456', '杯 子', '杯!', '😀', 'カップ']) {
    assert.equal((await f.web(cookie, '/api/control/cup', { id: randomUUID(), action: 'rename', cupId: 1, name })).statusCode, 400);
  }
  for (const input of [{ action: 'save' }, { action: 'select', cupId: 4 }, { action: 'delete', cupId: 1, name: '杯子' }, { name: '杯子' }])
    assert.equal((await f.web(cookie, '/api/control/cup', { id: randomUUID(), ...input })).statusCode, 400);
  for (const state of [{ activeCupId: 3 }, { emptyCupGrams: 180 }, { cups: [...cups, cups[0]] },
    { cups: [...cups, { id: 3, name: '三', emptyCupGrams: 80 }, { id: 4, name: '四', emptyCupGrams: 90 }] }]) {
    assert.equal((await f.report('coaster-01', { ...multiHeartbeat, ...state })).statusCode, 400);
  }
  const empty = { ...multiHeartbeat, cups: [], activeCupId: null, emptyCupGrams: null };
  assert.equal((await f.report('coaster-01', empty)).statusCode, 200);
  assert.deepEqual((await f.web(cookie, '/api/dashboard')).json().device.cups, []);
});

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
  f.advance(90_001);
  assert.equal((await f.web(cookie, '/api/control/cup', { id: randomUUID() })).statusCode, 409);
  await f.report();
  const id = randomUUID(); await f.web(cookie, '/api/control/cup', { id });
  f.advance(120_000);
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

test('30 秒空闲心跳保持在线，空杯命令跨下一次心跳领取并确认，90 秒后离线', async (t) => {
  const f = await fixture(t);
  const cookie = await f.register(); await f.bind(cookie);
  f.advance(29_000);
  assert.equal((await f.web(cookie, '/api/dashboard')).json().device.online, true);
  const id = randomUUID();
  const created = await f.web(cookie, '/api/control/cup', { id });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().command.expiresAt, f.now().getTime() + 120_000);
  f.advance(30_000);
  assert.equal((await f.report()).json().command.id, id);
  f.advance(5_000);
  await f.report('coaster-01', { ...heartbeat, commandResult: { id, ok: true, message: '已保存' } });
  assert.equal((await f.web(cookie, `/api/control/commands/${id}`)).json().command.status, 'succeeded');
  f.advance(90_000);
  assert.equal((await f.web(cookie, '/api/dashboard')).json().device.online, true);
  f.advance(1);
  assert.equal((await f.web(cookie, '/api/dashboard')).json().device.online, false);
});
