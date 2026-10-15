import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { BLE_UUID, BleTransport, bluetoothCompatibility, encodeFrames, parseInfo, parseWifiScan, validateWifi,
  type BleCharacteristic, type BleServer, type BleStatus, type BluetoothAccess, type ProvisionConfig, type WifiNetwork } from '../src/ble.ts';

const operationId = '10000000-0000-4000-8000-000000000001';
const info = { protocolVersion: 1, deviceId: 'coaster-000001', deploymentId: '20000000-0000-4000-8000-000000000001', challenge: 'a'.repeat(64), trusted: true };
const config: ProvisionConfig = { protocolVersion: 1, operationId, ssid: '客厅 Wi-Fi', password: 'private-password', authorization: { payload: 'signed\nauthorization\n' + 'f'.repeat(64), signature: 'b'.repeat(128) } };
function view(value: unknown) { const bytes = new TextEncoder().encode(JSON.stringify(value)); return new DataView(bytes.buffer); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 8; i++) await tick(); }

class Peripheral {
  device = new EventTarget() as EventTarget & { gatt: BleServer };
  reads = 0;
  active = 0;
  maxActive = 0;
  chosen = false;
  received: Uint8Array[] = [];
  info: Record<string, unknown> = info;
  wifiNetworks: WifiNetwork[] = [];
  wifiState = 'ready';
  wifiCode = 'WIFI_BUSY';
  wifiIndex = 0;
  wifiPendingReads = 0;
  wifiGate: ReturnType<typeof deferred<DataView>> | null = null;
  wifiRequests: number[][] = [];
  status: BleStatus = { operationId, stage: 'saving', message: '保存中', sequence: 4 };
  statusGate: ReturnType<typeof deferred<DataView>> | null = null;
  infoGate: ReturnType<typeof deferred<DataView>> | null = null;
  notify!: BleCharacteristic;
  requested: string[] = [];
  constructor() {
    const self = this;
    const characteristic = (uuid: string): BleCharacteristic => {
      const target = new EventTarget() as BleCharacteristic;
      target.startNotifications = () => this.action(async () => target);
      target.readValue = () => this.action(async () => {
        assert.equal(this.chosen, true, 'info cannot be read before requestDevice');
        if (uuid === BLE_UUID.info) return this.infoGate ? await this.infoGate.promise : view(this.info);
        if (uuid === BLE_UUID.wifi) {
          if (this.wifiGate) return await this.wifiGate.promise;
          if (this.wifiPendingReads-- > 0) return view({ state: 'scanning', count: 0 });
          return view({ state: this.wifiState, count: this.wifiState === 'ready' ? this.wifiNetworks.length : 0,
            index: this.wifiIndex, network: this.wifiNetworks[this.wifiIndex], code: this.wifiCode });
        }
        assert.equal(uuid, BLE_UUID.status);
        this.reads++;
        const result = this.statusGate ? await this.statusGate.promise : view(this.status);
        // Browser readValue also dispatches characteristicvaluechanged.
        target.dispatchEvent(new Event('characteristicvaluechanged'));
        return result;
      });
      target.writeValueWithResponse = value => this.action(async () => {
        if (uuid === BLE_UUID.wifi) {
          this.wifiRequests.push([...value]);
          if (value[0] === 1) { assert.equal(value.length, 1); this.wifiIndex = 0; }
          else { assert.equal(value[0], 2); assert.equal(value.length, 2); this.wifiIndex = value[1]; }
          return;
        }
        assert.equal(uuid, BLE_UUID.config);
        this.received.push(value.slice());
        if (this.received.length === 2) this.notify.dispatchEvent(new Event('characteristicvaluechanged'));
      });
      return target;
    };
    this.notify = characteristic(BLE_UUID.status);
    this.device.gatt = {
      connected: false,
      async connect() { this.connected = true; return this; },
      disconnect() { const was = this.connected; this.connected = false; if (was) self.device.dispatchEvent(new Event('gattserverdisconnected')); },
      async getPrimaryService(uuid) {
        assert.equal(uuid, '7d2a0001-7b9c-4e6a-9f21-531bd67a0c10');
        return { async getCharacteristic(id) { self.requested.push(id); return id === BLE_UUID.status ? self.notify : characteristic(id); } };
      },
    };
  }
  private async action<T>(work: () => Promise<T>) {
    this.maxActive = Math.max(this.maxActive, ++this.active);
    try { await tick(); return await work(); } finally { this.active--; }
  }
  bluetooth: BluetoothAccess = {
    requestDevice: async options => {
      assert.deepEqual(options.filters, [{ services: ['7d2a0001-7b9c-4e6a-9f21-531bd67a0c10'] }]);
      this.chosen = true;
      return this.device;
    },
  };
}

// Independent device-side reassembler: rejects invalid flags/order and decodes UTF-8 only once.
function receive(frames: Uint8Array[]) {
  const data: number[] = [];
  let ended = false;
  frames.forEach((frame, i) => {
    assert.ok(frame.length <= 20 && frame.length > 3);
    assert.equal(frame[0] & 0xfc, 0);
    assert.equal(frame[1] + 256 * frame[2], i);
    assert.equal(Boolean(frame[0] & 1), i === 0);
    assert.equal(ended, false);
    ended = Boolean(frame[0] & 2);
    data.push(...frame.slice(3));
  });
  assert.equal(ended, true);
  assert.ok(data.length <= 4096);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(data)));
}

test('UTF-8 payload crosses 17-byte boundaries and round-trips through a 20-byte peripheral', () => {
  const frames = encodeFrames(config);
  assert.ok(frames.length > 20);
  assert.deepEqual(receive(frames), config);
  assert.throws(() => encodeFrames({ ...config, authorization: { ...config.authorization, payload: 'x'.repeat(4096) } }), /大小/);
  assert.throws(() => validateWifi('水'.repeat(11), ''), /32/);
  assert.throws(() => validateWifi('SSID', 'short'), /8–63/);
  validateWifi('空', '');
});

test('user selection precedes info; writes, short notifications and reads share one GATT queue', async () => {
  const peripheral = new Peripheral();
  const statuses: BleStatus[] = [];
  const failures: unknown[] = [];
  const transport = new BleTransport(peripheral.bluetooth, { status: value => statuses.push(value), error: error => failures.push(error), disconnected() {} });
  assert.equal(peripheral.chosen, false);
  assert.deepEqual(await transport.choose(), info);
  await settle();
  assert.deepEqual(peripheral.requested, [BLE_UUID.info, BLE_UUID.config, BLE_UUID.status]);
  await transport.send(config);
  await settle();
  assert.deepEqual(receive(peripheral.received), config);
  // Notification body is deliberately absent. The full status must come from readValue.
  peripheral.status = { ...peripheral.status, stage: 'completed', sequence: 5 };
  peripheral.notify.dispatchEvent(new Event('characteristicvaluechanged'));
  await settle();
  assert.equal(statuses.at(-1)?.stage, 'completed');
  assert.equal(peripheral.maxActive, 1);
  const reads = peripheral.reads;
  await settle();
  assert.equal(peripheral.reads, reads, 'read echo must not produce an infinite notification loop');
  assert.deepEqual(failures, []);
  transport.disconnect();
});

test('a status response arriving after disconnect cannot publish into a new connection', async () => {
  const peripheral = new Peripheral();
  const statuses: BleStatus[] = [];
  let disconnected = 0;
  const transport = new BleTransport(peripheral.bluetooth, { status: value => statuses.push(value), error() {}, disconnected() { disconnected++; } });
  await transport.choose();
  await settle();
  statuses.length = 0;
  peripheral.statusGate = deferred<DataView>();
  peripheral.notify.dispatchEvent(new Event('characteristicvaluechanged'));
  await tick();
  peripheral.device.gatt.disconnect();
  assert.equal(disconnected, 1);
  peripheral.statusGate.resolve(view({ ...peripheral.status, stage: 'completed', sequence: 99 }));
  await settle();
  assert.equal(statuses.length, 0);
  peripheral.statusGate = null;
  await transport.reconnect();
  await settle();
  assert.equal(statuses.at(-1)?.stage, 'saving');
  transport.disconnect();
});

test('read timeout closes GATT and rejects completion from the abandoned attempt', async () => {
  const peripheral = new Peripheral();
  peripheral.infoGate = deferred<DataView>();
  const transport = new BleTransport(peripheral.bluetooth, { status() {}, error() {}, disconnected() {} }, 15, 15);
  await assert.rejects(transport.choose(), { name: 'TimeoutError' });
  assert.equal(transport.connected, false);
  assert.equal(peripheral.device.gatt.connected, false);
  peripheral.infoGate.resolve(view(info));
  await settle();
  assert.equal(transport.connected, false);
});

test('cancelled picker does not read info and unsupported browsers get actionable compatibility text', async () => {
  let selected = 0;
  const bluetooth: BluetoothAccess = { requestDevice() { selected++; return Promise.reject(new DOMException('cancelled', 'NotFoundError')); } };
  const transport = new BleTransport(bluetooth, { status() {}, error() {}, disconnected() {} });
  await assert.rejects(transport.choose(), { name: 'NotFoundError' });
  assert.equal(selected, 1);
  assert.match(bluetoothCompatibility(false, bluetooth), /HTTPS/);
  assert.match(bluetoothCompatibility(true), /Chrome/);
  assert.equal(bluetoothCompatibility(true, bluetooth), '');
  assert.throws(() => parseInfo(view({ ...info, protocolVersion: 2 })), /设备信息/);
  const fresh = parseInfo(view({ protocolVersion: 2, deviceId: '', hardwareId: 'aabbccddeeff', challenge: 'a'.repeat(64) }));
  assert.equal(fresh.hardwareId, 'aabbccddeeff');
  assert.equal(fresh.deviceId, '');
  assert.equal(parseInfo(view({ ...info, deploymentId: '', trusted: false })).trusted, false);
});

const wifiInfo = { protocolVersion: 2, deviceId: '', hardwareId: 'aabbccddeeff', challenge: 'a'.repeat(64), wifiScan: true };
const homeWifi: WifiNetwork = { ssid: '客厅 Wi-Fi', rssi: -50, channel: 6, secure: true };

test('设备扫描按页读取 2.4 GHz 网络、按信号去重，并与状态读取共用 GATT 队列', async () => {
  const peripheral = new Peripheral();
  peripheral.info = wifiInfo;
  peripheral.wifiPendingReads = 1;
  peripheral.wifiNetworks = [
    { ...homeWifi, rssi: -80 },
    { ...homeWifi, ssid: '访客网络', rssi: -70, secure: false },
    homeWifi,
    ...Array.from({ length: 17 }, (_, index) => ({ ...homeWifi, ssid: `网络 ${index}`, rssi: -90 + index })),
  ];
  const transport = new BleTransport(peripheral.bluetooth, { status() {}, error() {}, disconnected() {} });
  assert.equal((await transport.choose()).wifiScan, true);
  await settle();
  const [networks] = await Promise.all([transport.scanWifi(), transport.readStatus()]);
  assert.equal(networks.length, 19);
  assert.deepEqual(networks[0], homeWifi);
  assert.equal(networks.find(network => network.ssid === '访客网络')?.secure, false);
  assert.equal(peripheral.wifiRequests.length, 20);
  assert.deepEqual(peripheral.wifiRequests.at(-1), [2, 19]);
  assert.equal(peripheral.maxActive, 1);
  assert.equal(peripheral.received.length, 0, '扫描不能写入配网配置');
  transport.disconnect();
});

test('空网络、设备忙和扫描失败均可重试，旧固件仍能连接', async () => {
  const peripheral = new Peripheral();
  const transport = new BleTransport(peripheral.bluetooth, { status() {}, error() {}, disconnected() {} });
  await transport.choose();
  await assert.rejects(transport.scanWifi(), /升级固件/);
  assert.equal(peripheral.wifiRequests.length, 0);
  peripheral.info = wifiInfo;
  await transport.reconnect();
  assert.deepEqual(await transport.scanWifi(), []);
  peripheral.wifiState = 'failed';
  await assert.rejects(transport.scanWifi(), /正在连接 Wi-Fi/);
  peripheral.wifiCode = 'SCAN_FAILED';
  await assert.rejects(transport.scanWifi(), /扫描未完成/);
  assert.equal(transport.connected, true);
  peripheral.wifiState = 'ready';
  peripheral.wifiNetworks = [homeWifi];
  assert.deepEqual(await transport.scanWifi(), [homeWifi]);
  transport.disconnect();
});

test('扫描超时关闭连接，迟到的数据不能继续读取下一页', async () => {
  const peripheral = new Peripheral();
  peripheral.info = wifiInfo;
  let disconnected = 0;
  const transport = new BleTransport(peripheral.bluetooth, { status() {}, error() {}, disconnected() { disconnected++; } }, 30);
  await transport.choose();
  await settle();
  peripheral.wifiGate = deferred<DataView>();
  await assert.rejects(transport.scanWifi(), { name: 'TimeoutError' });
  assert.equal(transport.connected, false);
  assert.equal(disconnected, 1);
  peripheral.wifiGate.resolve(view({ state: 'ready', count: 2, index: 0, network: homeWifi }));
  await settle();
  assert.deepEqual(peripheral.wifiRequests, [[1]]);
  peripheral.wifiGate = null;
  peripheral.wifiNetworks = [homeWifi];
  await transport.reconnect();
  assert.deepEqual(await transport.scanWifi(), [homeWifi]);
  transport.disconnect();
});

test('拒绝损坏、越界、5 GHz 或过长的扫描数据，长中文与转义名称可读取', () => {
  const response = { state: 'ready', count: 1, index: 0, network: homeWifi };
  for (const network of [
    { ...homeWifi, ssid: '' }, { ...homeWifi, ssid: '水'.repeat(11) }, { ...homeWifi, ssid: 'wifi\0evil' },
    { ...homeWifi, rssi: 1 }, { ...homeWifi, channel: 36 }, { ...homeWifi, secure: 'true' },
  ]) assert.throws(() => parseWifiScan(view({ ...response, network })), /不完整/);
  assert.throws(() => parseWifiScan(view({ ...response, count: 21 })), /不完整/);
  assert.throws(() => parseWifiScan(view({ ...response, index: 1 })), /不完整/);
  const escaped = { ...response, network: { ...homeWifi, ssid: '\n'.repeat(32) } };
  assert.ok(view(escaped).byteLength < 512);
  assert.equal(parseWifiScan(view(escaped)).network?.ssid, escaped.network.ssid);
  assert.equal(parseWifiScan(view({ ...response, network: { ...homeWifi, ssid: '水'.repeat(10) } })).count, 1);
});
