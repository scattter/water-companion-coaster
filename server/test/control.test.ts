import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';

const auth = { authorization: 'Bearer test-control-token', 'x-device-id': 'coaster-01' };
const heartbeat = {
  weightGrams: null, stable: false, cupPresent: false, source: 'hx711', calibrated: false,
  emptyCupGrams: null, pendingCount: 0, timePendingCount: 0, clockSynced: true,
  error: '请先校准', firmwareVersion: '0.4.4',
};
const device = () => ({
  firmwareVersion: '0.4.4', raw: 100000, weightGrams: null as number | null, stable: false,
  calibrated: false, emptyCupGrams: 0, wifiConnected: true, serverConnected: true,
  ip: '192.168.1.25', restartRequired: false, error: '请先校准' as string | null,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

async function fixture(t: TestContext) {
  let currentTime = new Date('2026-10-12T10:00:00Z');
  const state = device();
  const calls: { url: string; options: RequestInit }[] = [];
  let handler: ((input?: Record<string, unknown>) => Promise<Response> | Response) | undefined;
  const app = createApp({
    deviceToken: 'test-control-token', dbPath: ':memory:', now: () => currentTime,
    controlFetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const input = options.body ? JSON.parse(String(options.body)) : undefined;
      if (handler) return handler(input);
      if (!input) return json({ ...state, token: 'test-control-token' });
      if (input.cmd === 'tare') Object.assign(state, { calibrated: false, weightGrams: null, emptyCupGrams: 0 });
      if (input.cmd === 'calibrate') Object.assign(state, { calibrated: true, weightGrams: input.grams, emptyCupGrams: 0 });
      if (input.cmd === 'cup') Object.assign(state, { emptyCupGrams: 120, error: null });
      return json({ ok: true, message: '设备已保存', device: { ...state, token: 'test-control-token' } });
    },
  });
  t.after(() => app.close());
  await app.ready();
  return {
    app, state, calls,
    report: (address = '192.168.1.25', headers = auth) => app.inject({ method: 'POST', url: '/api/device/heartbeat',
      remoteAddress: address, headers, payload: heartbeat }),
    respond: (value: typeof handler) => { handler = value; },
    advance: () => { currentTime = new Date(currentTime.getTime() + 16_000); },
    calibrate: (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/control/calibrate', payload }),
  };
}

test('Wi-Fi 校准复用设备凭证和三步命令，状态来自设备确认且不回传凭证', async (t) => {
  const f = await fixture(t);
  await f.report('::ffff:192.168.1.25');
  const status = await f.app.inject('/api/control/status');
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().device.calibrated, false);
  assert.equal(status.body.includes('test-control-token'), false);
  assert.equal((await f.calibrate({ cmd: 'tare' })).json().device.calibrated, false);
  const calibrated = await f.calibrate({ cmd: 'calibrate', grams: 500 });
  assert.equal(calibrated.statusCode, 200);
  assert.equal(calibrated.json().device.calibrated, true);
  assert.equal(calibrated.body.includes('test-control-token'), false);
  assert.equal((await f.calibrate({ cmd: 'cup' })).json().device.emptyCupGrams, 120);
  assert.equal(f.calls.length, 4);
  for (const call of f.calls) {
    assert.ok(call.url.startsWith('http://192.168.1.25/api/control/'));
    assert.deepEqual(new Headers(call.options.headers).get('authorization'), auth.authorization);
    assert.equal(new Headers(call.options.headers).get('x-device-id'), auth['x-device-id']);
    assert.equal(call.options.redirect, 'error');
  }
});

test('只接受已认证心跳的私有地址，未上线、过期和不可信地址不发控制请求', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.calibrate({ cmd: 'tare' })).statusCode, 409);
  assert.equal((await f.report('192.168.1.99', { ...auth, authorization: 'Bearer wrong-token' })).statusCode, 401);
  assert.equal((await f.app.inject('/api/control/status')).statusCode, 409);
  for (const address of ['127.0.0.1', '8.8.8.8', '::1']) {
    await f.report(address);
    assert.equal((await f.app.inject('/api/control/status')).statusCode, 409);
  }
  await f.report();
  f.advance();
  assert.equal((await f.calibrate({ cmd: 'tare' })).statusCode, 409);
  assert.equal(f.calls.length, 0);
  await f.report('192.168.1.26');
  await f.app.inject('/api/control/status');
  assert.equal(f.calls[0].url, 'http://192.168.1.26/api/control/status');
});

test('本机限制和参数校验在发送前执行，不能透传任意命令或地址', async (t) => {
  const f = await fixture(t);
  await f.report();
  for (const payload of [{ cmd: 'wifi' }, { cmd: 'reboot' }, { cmd: 'calibrate' },
    { cmd: 'calibrate', grams: 49 }, { cmd: 'tare', url: 'http://10.0.0.1' }]) {
    assert.equal((await f.calibrate(payload)).statusCode, 400);
  }
  for (const options of [{ remoteAddress: '192.168.1.20' }, { headers: { origin: 'https://untrusted.example' } },
    { headers: { host: 'untrusted.example:3001' } }, { headers: { 'sec-fetch-site': 'cross-site' } }]) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/control/calibrate', payload: { cmd: 'tare' }, ...options })).statusCode, 403);
  }
  assert.equal(f.calls.length, 0);
});

test('固件拒绝、旧版本、超时和缺失确认都不显示成功或自动重发', async (t) => {
  const f = await fixture(t);
  await f.report();
  f.respond(() => json({ ok: false, error: '零点采样不稳定' }, 400));
  assert.match((await f.calibrate({ cmd: 'tare' })).json().error, /采样不稳定/);
  for (const code of [403, 404]) {
    f.respond(() => new Response('Unsupported', { status: code }));
    assert.match((await f.app.inject('/api/control/status')).json().error, /0\.4\.4/);
  }
  f.respond(() => new Response('Unauthorized', { status: 401 }));
  assert.match((await f.calibrate({ cmd: 'tare' })).json().error, /凭证不一致/);
  const count = f.calls.length;
  f.respond(() => { throw new Error('timeout test-control-token'); });
  const timeout = await f.calibrate({ cmd: 'tare' });
  assert.equal(timeout.statusCode, 504);
  assert.match(timeout.json().error, /结果尚未确认/);
  assert.equal(timeout.body.includes('test-control-token'), false);
  assert.equal(f.calls.length, count + 1);
  f.respond(() => json({ device: f.state }));
  assert.match((await f.calibrate({ cmd: 'tare' })).json().error, /结果尚未确认/);
  f.respond(() => json({ ok: true }));
  assert.match((await f.calibrate({ cmd: 'tare' })).json().error, /已确认保存.*状态读取失败/);
});

test('未确认的设备操作期间拒绝并发校准，完成后可继续', async (t) => {
  const f = await fixture(t);
  await f.report();
  let release!: (response: Response) => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => { started = resolve; });
  f.respond(() => new Promise<Response>((resolve) => { release = resolve; started(); }));
  const operation = f.calibrate({ cmd: 'tare' });
  await pending;
  assert.equal((await f.calibrate({ cmd: 'cup' })).statusCode, 409);
  assert.equal(f.calls.length, 1);
  release(json({ ok: true, message: '已保存', device: f.state }));
  assert.equal((await operation).statusCode, 200);
  f.respond(undefined);
  assert.equal((await f.app.inject('/api/control/status')).statusCode, 200);
});
