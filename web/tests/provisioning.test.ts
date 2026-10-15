import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { ApiError } from '../src/api.ts';
import { ProvisionFlow, provisionStorageKey, type AuthorizationResult, type EnrollmentResult, type OperationStatus, type ProvisionState, type ProvisionTransport } from '../src/provisioning.ts';
import { commandStorageKey, type Session } from '../src/session.ts';
import type { BleStatus, DeviceInfo, ProvisionConfig, WifiNetwork } from '../src/ble.ts';

const id = '10000000-0000-4000-8000-000000000001';
const batch = '30000000-0000-4000-8000-000000000001';
const info: DeviceInfo = { protocolVersion: 1, deviceId: 'coaster-000001', deploymentId: '20000000-0000-4000-8000-000000000001', challenge: 'a'.repeat(64), trusted: true };
const signed: AuthorizationResult = { operationId: id, serverUrl: 'https://water.example', expiresAt: 300000,
  authorization: { payload: 'opaque-signed-authorization\nsecret-ticket', signature: 'b'.repeat(128) } };
const user: Session = { user: { id: 'user-1', username: 'water', role: 'user' }, deviceId: null, bindingId: null };
const bound: Session = { ...user, deviceId: info.deviceId, bindingId: batch };
const status: OperationStatus = { operationId: id, deviceId: info.deviceId, status: 'issued', bindingId: null };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

class MemoryStorage {
  values = new Map<string, string>();
  writes: string[] = [];
  failWrite = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { if (this.failWrite) throw new Error('quota'); this.values.set(key, value); this.writes.push(value); }
  removeItem(key: string) { this.values.delete(key); }
}
function fixture(initial: Session = user, storage = new MemoryStorage()) {
  let currentSession = { ...initial };
  let serverSession = { ...bound };
  let now = 0;
  let operationStatus = { ...status };
  let ble: BleStatus = { operationId: id, stage: 'received', sequence: 1, message: '已收到' };
  let selected = { ...info };
  let enrollment: EnrollmentResult | null = null;
  let getGate: ReturnType<typeof deferred<OperationStatus>> | null = null;
  let postGate: ReturnType<typeof deferred<AuthorizationResult>> | null = null;
  let finalGate: ReturnType<typeof deferred<Session>> | null = null;
  let requestError: unknown;
  let writeError: unknown;
  let scanError: unknown;
  let scanGate: ReturnType<typeof deferred<WifiNetwork[]>> | null = null;
  let scanCount = 0;
  const wifiNetworks: WifiNetwork[] = [{ ssid: '客厅', rssi: -50, channel: 6, secure: true }];
  const requests: { path: string; body: unknown }[] = [];
  const sent: ProvisionConfig[] = [];
  const completed: Session[] = [];
  const unauthorized: ApiError[] = [];
  const snapshots: ProvisionState[] = [];
  const transport: ProvisionTransport = {
    connected: false,
    async choose() { Object.assign(this, { connected: true }); return selected; },
    async reconnect() { Object.assign(this, { connected: true }); return selected; },
    disconnect() { Object.assign(this, { connected: false }); },
    async readStatus() { return ble; },
    async scanWifi() { scanCount++; if (scanError) throw scanError; return scanGate ? await scanGate.promise : wifiNetworks; },
    async send(value) { sent.push(structuredClone(value)); if (writeError) throw writeError; },
  };
  const flow = new ProvisionFlow({
    userId: initial.user!.id, currentSession: () => currentSession, transport, storage, now: () => now,
    async request<T>(path: string, body?: unknown): Promise<T> {
      requests.push({ path, body });
      if (requestError) throw requestError;
      let value: unknown;
      if (path === '/api/auth/session') value = finalGate ? await finalGate.promise : serverSession;
      else if (body) value = path === '/api/enrollment/operations' ? enrollment : postGate ? await postGate.promise : signed;
      else value = getGate ? await getGate.promise : operationStatus;
      return value as T;
    },
    changed: value => snapshots.push(value), completed: value => completed.push(value), unauthorized: cause => unauthorized.push(cause),
  });
  return {
    flow, storage, transport, requests, sent, completed, unauthorized, snapshots,
    setStatus(value: Partial<OperationStatus>) { operationStatus = { ...operationStatus, ...value }; },
    setBle(value: Partial<BleStatus>) { ble = { ...ble, ...value }; return ble; },
    setInfo(value: Partial<DeviceInfo>) { selected = { ...selected, ...value }; },
    setEnrollment(value: EnrollmentResult) { enrollment = value; },
    setCurrent(value: Session) { currentSession = value; }, setServerSession(value: Session) { serverSession = value; },
    setNow(value: number) { now = value; },
    setGetGate(value: typeof getGate) { getGate = value; }, setPostGate(value: typeof postGate) { postGate = value; },
    setFinalGate(value: typeof finalGate) { finalGate = value; },
    setError(value: unknown) { requestError = value; }, setWriteError(value: unknown) { writeError = value; },
    setScanError(value: unknown) { scanError = value; }, setScanGate(value: typeof scanGate) { scanGate = value; },
    get scanCount() { return scanCount; }, wifiNetworks,
  };
}
async function start(f: ReturnType<typeof fixture>) { await f.flow.connect(); await f.flow.start('客厅', 'wifi-secret'); await settle(); }

test('支持扫描的杯垫连接后自动列出网络，扫描时不能申请票据或发送配置', async () => {
  const f = fixture();
  f.setInfo({ wifiScan: true });
  const gate = deferred<WifiNetwork[]>();
  f.setScanGate(gate);
  const connected = f.flow.connect();
  await settle();
  assert.equal(f.flow.state.scanning, true);
  assert.equal(f.flow.state.busy, true);
  await f.flow.start('客厅', 'wifi-secret');
  await f.flow.scanWifi();
  assert.equal(f.scanCount, 1);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.sent, []);
  gate.resolve(f.wifiNetworks);
  await connected;
  assert.deepEqual(f.flow.state.wifiNetworks, f.wifiNetworks);
  assert.equal(f.flow.state.busy, false);
  assert.deepEqual(f.storage.writes, []);
  const legacy = fixture();
  await legacy.flow.connect();
  assert.equal(legacy.flow.state.connected, true);
  assert.equal(legacy.scanCount, 0);
});

test('扫描失败保留蓝牙连接并允许重试，空列表不会制造网络', async () => {
  const f = fixture();
  f.setInfo({ wifiScan: true });
  f.setScanError(new Error('杯垫正在连接 Wi-Fi，请稍后重新扫描。'));
  await f.flow.connect();
  assert.match(f.flow.state.scanError, /重新扫描/);
  assert.equal(f.flow.state.connected, true);
  assert.equal(f.flow.state.busy, false);
  f.setScanError(undefined);
  f.wifiNetworks.length = 0;
  await f.flow.scanWifi();
  assert.equal(f.flow.state.scanError, '');
  assert.deepEqual(f.flow.state.wifiNetworks, []);
  assert.equal(f.scanCount, 2);
});

test('取消或断线后，旧扫描不能覆盖重新连接后的网络列表', async () => {
  for (const pause of [true, false]) {
    const f = fixture();
    f.setInfo({ wifiScan: true });
    const oldScan = deferred<WifiNetwork[]>();
    f.setScanGate(oldScan);
    const oldConnection = f.flow.connect();
    await settle();
    if (pause) f.flow.pause();
    else { f.transport.disconnect(); f.flow.disconnected(); }
    assert.equal(f.flow.state.scanning, false);
    assert.equal(f.flow.state.busy, false);
    f.setScanGate(null);
    await f.flow.connect(true);
    oldScan.resolve([{ ssid: '旧网络', rssi: -30, channel: 1, secure: false }]);
    await oldConnection;
    assert.deepEqual(f.flow.state.wifiNetworks, f.wifiNetworks);
    assert.equal(f.flow.state.connected, true);
    assert.equal(f.scanCount, 2);
    assert.deepEqual(f.requests, []);
  }
});

test('自动注册不需要设备编号或信任配置，先保存服务器分配的身份再显示绑定成功', async () => {
  const f = fixture();
  const hardwareId = 'aabbccddeeff';
  const enrollment: EnrollmentResult = { operationId: id, hardwareId, deviceId: null, serverUrl: 'http://192.168.1.10:3001', ticket: 'c'.repeat(64), expiresAt: 300000 };
  f.setInfo({ protocolVersion: 2, deviceId: '', hardwareId, deploymentId: '', trusted: false });
  f.setEnrollment(enrollment);
  f.setStatus({ deviceId: null, hardwareId });
  await start(f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].protocolVersion, 2);
  assert.equal('ticket' in f.sent[0] && f.sent[0].ticket, enrollment.ticket);
  assert.deepEqual(f.requests.find(call => call.body)?.body, { hardwareId, deviceId: null, challenge: info.challenge });
  assert.equal(f.requests.find(call => call.body)?.path, '/api/enrollment/operations');
  for (const value of f.storage.writes) {
    assert.equal(value.includes(enrollment.ticket), false);
    assert.doesNotMatch(value, /wifi-secret|serverUrl|password/);
  }
  f.setStatus({ status: 'claimed', deviceId: info.deviceId, bindingId: batch });
  await f.flow.poll(true);
  assert.equal(f.flow.state.operation?.deviceId, info.deviceId);
  assert.equal(f.completed.length, 0);
  const resumed = fixture(user, f.storage);
  resumed.setStatus({ status: 'completed', hardwareId, deviceId: info.deviceId, bindingId: batch });
  await resumed.flow.poll(true);
  assert.deepEqual(resumed.completed, [bound]);
  assert.equal(resumed.sent.length, 0);
  assert.equal(resumed.requests[0].path, `/api/enrollment/operations/${id}`);
  f.flow.dispose(); resumed.flow.dispose();
});

test('自动注册尚未分配编号时，重连按硬件标识确认同一杯垫', async () => {
  const f = fixture();
  const hardwareId = 'aabbccddeeff';
  f.setInfo({ protocolVersion: 2, deviceId: '', hardwareId, deploymentId: '', trusted: false });
  f.setEnrollment({ operationId: id, hardwareId, deviceId: null, serverUrl: 'http://192.168.1.10:3001', ticket: 'c'.repeat(64), expiresAt: 300000 });
  f.setStatus({ deviceId: null, hardwareId });
  await start(f);
  f.flow.disconnected();
  f.setInfo({ hardwareId: '001122334455' });
  await f.flow.connect(true);
  assert.match(f.flow.state.error, /同一台杯垫/);
  f.setInfo({ hardwareId, deviceId: info.deviceId });
  await f.flow.connect(true);
  assert.equal(f.flow.state.connected, true);
  f.flow.dispose();
});

test('unbound onboarding sends opaque authorization to BLE, retains only safe identifiers, and requires persistent completion', async () => {
  const f = fixture();
  await start(f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].password, 'wifi-secret');
  assert.deepEqual(f.sent[0].authorization, signed.authorization);
  assert.deepEqual(f.requests.find(call => call.body)?.body, { deviceId: info.deviceId, deploymentId: info.deploymentId, challenge: info.challenge });
  for (const value of f.storage.writes) {
    assert.doesNotMatch(value, /wifi-secret|secret-ticket|authorization|serverUrl|password/);
  }
  assert.equal(f.flow.state.complete, false);
  f.setStatus({ status: 'claimed', bindingId: batch });
  f.flow.receiveStatus(f.setBle({ stage: 'completed', sequence: 4 }));
  await settle();
  assert.equal(f.completed.length, 0, 'BLE completion alone does not prove cloud completion');
  assert.match(f.flow.state.message, /持久保存/);
  f.setStatus({ status: 'completed', bindingId: batch });
  await f.flow.poll(true);
  assert.deepEqual(f.completed, [bound]);
  assert.equal(f.storage.getItem(provisionStorageKey('user-1')), null);
});

test('a refreshed page resumes the durable operation without selecting Bluetooth or requesting a new ticket', async () => {
  const original = fixture();
  await start(original);
  original.flow.dispose();
  const resumed = fixture(user, original.storage);
  resumed.setStatus({ status: 'completed', bindingId: batch });
  await resumed.flow.poll(true);
  assert.equal(resumed.completed.length, 1);
  assert.equal(resumed.sent.length, 0);
  assert.equal(resumed.requests.filter(call => call.body).length, 0);
  assert.equal(resumed.transport.connected, false);
});

test('same-owner reconfiguration rejects a different device before issuing authorization', async () => {
  const f = fixture(bound);
  f.setInfo({ deviceId: 'coaster-000002' });
  await f.flow.connect();
  assert.equal(f.flow.state.connected, false);
  assert.match(f.flow.state.error, /同一台/);
  await f.flow.start('home', 'wifi-secret');
  assert.equal(f.requests.length, 0);
  f.setInfo({ deviceId: info.deviceId });
  await start(f);
  f.setStatus({ status: 'completed', bindingId: batch });
  await f.flow.poll(true);
  assert.equal(f.completed[0]?.bindingId, batch);
});

test('disconnect and ambiguous send keep the operation id; explicit retry reuses the authorization only on the same challenge', async () => {
  const f = fixture();
  f.setWriteError(new DOMException('link lost', 'NetworkError'));
  await start(f);
  f.transport.disconnect();
  f.flow.disconnected();
  assert.equal(f.flow.state.operation?.operationId, id);
  assert.equal(f.flow.canStart, false);
  await f.flow.connect(true);
  assert.equal(f.flow.canResend, true);
  f.setWriteError(null);
  await f.flow.resend('home', 'wifi-secret');
  await settle();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].operationId, f.sent[0].operationId);
  assert.equal(f.requests.filter(call => call.body).length, 1);
  f.transport.disconnect();
  f.flow.disconnected();
  f.setInfo({ challenge: 'c'.repeat(64) });
  await f.flow.connect(true);
  assert.equal(f.flow.canResend, false);
  await f.flow.resend('home', 'wifi-secret');
  assert.equal(f.sent.length, 2);
});

test('cancel while authorization is in flight never writes Wi-Fi and preserves a late operation id', async () => {
  const f = fixture();
  const gate = deferred<AuthorizationResult>();
  f.setPostGate(gate);
  await f.flow.connect();
  const pending = f.flow.start('home', 'wifi-secret');
  f.flow.pause();
  assert.equal(f.flow.canStart, false, 'cannot issue another operation while the first response is outstanding');
  gate.resolve(signed);
  await pending;
  assert.equal(f.sent.length, 0);
  assert.equal(f.flow.state.paused, true);
  assert.equal(f.flow.state.operation?.operationId, id);
  assert.ok(f.storage.getItem(provisionStorageKey('user-1'))?.includes(id));
  assert.equal(f.flow.canStart, false);
});

test('polls are single-flight; stale pre-cancel responses and out-of-order device sequences are ignored', async () => {
  const f = fixture();
  await start(f);
  f.flow.receiveStatus(f.setBle({ stage: 'saving', sequence: 5 }));
  f.flow.receiveStatus(f.setBle({ stage: 'received', sequence: 2 }));
  f.flow.receiveStatus({ ...f.setBle({ stage: 'failed', sequence: 99 }), operationId: '10000000-0000-4000-8000-000000000002' });
  assert.equal(f.flow.state.ble?.stage, 'saving');
  const gate = deferred<OperationStatus>();
  f.setGetGate(gate);
  const before = f.requests.length;
  const pending = f.flow.poll(true);
  await Promise.all([f.flow.poll(), f.flow.poll(true)]);
  assert.equal(f.requests.length, before + 1);
  f.flow.pause();
  f.setGetGate(null);
  f.setStatus({ status: 'claimed', bindingId: batch });
  await f.flow.poll(true);
  gate.resolve({ ...status, status: 'completed', bindingId: batch });
  await pending;
  assert.equal(f.flow.state.server?.status, 'claimed');
  assert.equal(f.completed.length, 0);
});

test('final target check rejects another account, another device, or a replaced binding', async () => {
  for (const wrong of [
    { ...bound, user: { ...bound.user!, id: 'other-user' } },
    { ...bound, deviceId: 'coaster-000002' },
    { ...bound, bindingId: '30000000-0000-4000-8000-000000000002' },
  ]) {
    const f = fixture();
    await start(f);
    f.setStatus({ status: 'completed', bindingId: batch });
    f.setServerSession(wrong);
    await f.flow.poll(true);
    assert.equal(f.completed.length, 0);
    assert.equal(f.flow.state.complete, false);
    assert.equal(f.flow.state.paused, true);
    assert.match(f.flow.state.error, /账号或设备批次/);
  }
});

test('an account change while final session lookup is pending cannot complete the old view', async () => {
  const f = fixture();
  await start(f);
  f.setStatus({ status: 'completed', bindingId: batch });
  const gate = deferred<Session>();
  f.setFinalGate(gate);
  const pending = f.flow.poll(true);
  await tick();
  f.setCurrent({ ...user, user: { ...user.user!, id: 'other-user' } });
  gate.resolve(bound);
  await pending;
  assert.equal(f.completed.length, 0);
});

test('timeout pauses instead of declaring failure; 403 keeps login, 401 expires it, terminal errors allow a new operation', async () => {
  const f = fixture();
  await start(f);
  f.setNow(120001);
  const before = f.requests.length;
  await f.flow.poll();
  assert.equal(f.requests.length, before);
  assert.equal(f.flow.state.paused, true);
  assert.equal(f.flow.canStart, false);
  f.setError(new ApiError('forbidden', 403));
  await f.flow.poll(true);
  assert.equal(f.unauthorized.length, 0);
  assert.match(f.flow.state.error, /登录状态已保留/);
  f.setError(new ApiError('expired', 401));
  await f.flow.poll(true);
  assert.equal(f.unauthorized.length, 1);
  f.setError(null);
  for (const terminal of ['expired', 'failed', 'cancelled'] as const) {
    f.setStatus({ status: terminal });
    await f.flow.poll(true);
    assert.equal(f.flow.canStart, true);
    assert.equal(f.flow.state.complete, false);
  }
});

test('unavailable storage prevents authorization and credentials from leaving the page', async () => {
  const storage = new MemoryStorage();
  storage.failWrite = true;
  const f = fixture(user, storage);
  await start(f);
  assert.equal(f.requests.length, 0);
  assert.equal(f.sent.length, 0);
  assert.match(f.flow.state.error, /存储/);
});

test('explicit device failure confirmed still issued requires a new challenge before a new operation', async () => {
  for (const code of ['WIFI_FAILED', 'INVALID_AUTHORIZATION', 'INTERRUPTED']) {
    const f = fixture();
    await start(f);
    f.flow.receiveStatus(f.setBle({ stage: 'failed', code, sequence: 3, message: 'firmware english error' }));
    await settle();
    assert.equal(f.flow.needsFreshConnection, true);
    assert.equal(f.flow.canStart, false);
    assert.equal(f.flow.canResend, false);
    assert.doesNotMatch(f.flow.state.error, /firmware english/);
    await f.flow.connect(true);
    assert.equal(f.flow.canStart, false, 'same consumed challenge is not reusable');
    f.setInfo({ challenge: 'd'.repeat(64) });
    await f.flow.connect(true);
    assert.equal(f.flow.canStart, true);
    f.flow.receiveStatus(f.setBle({ stage: 'recovering', sequence: 4 }));
    assert.equal(f.flow.canStart, false, 'a newer recovering status immediately removes permission to start again');
  }
  const claimed = fixture();
  await start(claimed);
  claimed.setStatus({ status: 'claimed', bindingId: batch });
  claimed.flow.receiveStatus(claimed.setBle({ stage: 'failed', code: 'INTERRUPTED', sequence: 3 }));
  await settle();
  claimed.setInfo({ challenge: 'd'.repeat(64) });
  await claimed.flow.connect(true);
  assert.equal(claimed.flow.canStart, false, 'a claimed operation may still finish recovery');
  claimed.flow.receiveStatus(claimed.setBle({ stage: 'recovering', sequence: 4 }));
  await claimed.flow.poll(true);
  assert.equal(claimed.flow.canStart, false);
});

test('a failed BLE status with empty operation id is associated only with this connection’s actual send', async () => {
  const f = fixture();
  await start(f);
  f.flow.receiveStatus({ operationId: '', stage: 'failed', sequence: 2, message: 'bad auth', code: 'INVALID_AUTHORIZATION' });
  await settle();
  assert.equal(f.flow.state.ble?.operationId, id);
  assert.match(f.flow.state.error, /本次配置/);
  f.flow.pause();
  await f.flow.connect(true);
  f.flow.receiveStatus({ operationId: '', stage: 'failed', sequence: 100, message: 'unrelated', code: 'INVALID_FRAME' });
  assert.equal(f.flow.state.ble?.sequence, 2);
});

test('authorization ownership conflicts explain who must unbind, without logging the account out', async () => {
  const f = fixture();
  f.setError(new ApiError('opaque english error', 409, 'DEVICE_ALREADY_BOUND'));
  await start(f);
  assert.match(f.flow.state.error, /当前主人先解绑/);
  assert.equal(f.unauthorized.length, 0);
  assert.equal(f.sent.length, 0);
});

test('command recovery keys isolate repeated ownership of the same physical device', () => {
  const oldKey = commandStorageKey('user-1', info.deviceId, batch);
  const newKey = commandStorageKey('user-1', info.deviceId, 'new-batch');
  const otherUser = commandStorageKey('user-2', info.deviceId, batch);
  const legacy = commandStorageKey('user-1', info.deviceId, null);
  assert.equal(new Set([oldKey, newKey, otherUser, legacy]).size, 4);
  assert.notEqual(legacy, `water-cup-command:user-1:${info.deviceId}`);
});
