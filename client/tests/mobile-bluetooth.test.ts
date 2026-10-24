import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidBluetooth, type Call } from '../src/mobile/bluetooth';
import { BLE_UUID } from '../../web/src/ble';
import { nativeError } from '../src/mobile/errors';

const options = { filters: [{ services: [BLE_UUID.service] }], optionalServices: [BLE_UUID.service] };
test('Android GATT adapter rejects late reads and ignores events from the previous connection', async () => {
  let connection = 0;
  let complete: ((value: unknown) => void) | undefined;
  const call: Call = async <T>(command: string): Promise<T> => {
    if (command === 'choose') return { id: 'coaster' } as T;
    if (command === 'connect') return { connection: ++connection } as T;
    if (command === 'read') return new Promise(resolve => { complete = value => resolve(value as T); });
    return {} as T;
  };
  const bluetooth = new AndroidBluetooth(call);
  const device = await bluetooth.requestDevice();
  await device.gatt.connect();
  const characteristic = await (await device.gatt.getPrimaryService(BLE_UUID.service)).getCharacteristic(BLE_UUID.info);
  const read = characteristic.readValue();
  device.gatt.disconnect();
  await device.gatt.connect();
  complete!({ value: btoa('old') });
  await assert.rejects(read, { name: 'AbortError' });
  bluetooth.receive({ type: 'disconnected', connection: 1 });
  assert.equal(device.gatt.connected, true);
  bluetooth.receive({ type: 'disconnected', connection: 2 });
  assert.equal(device.gatt.connected, false);
});

test('Android adapter preserves byte payloads and surfaces permission denial before connection', async () => {
  let sent: Record<string, unknown> | undefined;
  const call: Call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === 'choose') return { id: 'coaster' } as T;
    if (command === 'connect') return { connection: 7 } as T;
    if (command === 'write') sent = args;
    if (command === 'read') return { value: btoa(String.fromCharCode(0, 128, 255)) } as T;
    return {} as T;
  };
  const bluetooth = new AndroidBluetooth(call);
  const access: import('../../web/src/ble').BluetoothAccess = bluetooth;
  const device = await access.requestDevice(options);
  const server = await device.gatt!.connect();
  const characteristic = await (await server.getPrimaryService(BLE_UUID.service)).getCharacteristic(BLE_UUID.config);
  await characteristic.writeValueWithResponse(new Uint8Array([0, 128, 255]));
  assert.equal(sent!.connection, 7);
  assert.equal(sent!.value, 'AID/');
  assert.deepEqual([...new Uint8Array((await characteristic.readValue()).buffer)], [0, 128, 255]);
  const denied = new AndroidBluetooth(async () => { throw nativeError({ message: '附近设备权限未开启', code: 'BLE_PERMISSION_DENIED' }); });
  await assert.rejects(denied.requestDevice(), { name: 'NotAllowedError', message: '附近设备权限未开启' });
  assert.equal(nativeError({ message: 'HTTPS 证书验证失败' }).message, 'HTTPS 证书验证失败');
});

test('a cancelled connection closes its late native GATT without closing the next connection', async () => {
  let complete: ((value: { connection: number }) => void) | undefined;
  const closed: unknown[] = [];
  const native: Call = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (command === 'choose') return { id: 'coaster' } as T;
    if (command === 'connect') return new Promise(resolve => { complete = value => resolve(value as T); });
    if (command === 'disconnect') closed.push(args?.connection);
    return {} as T;
  };
  const device = await new AndroidBluetooth(native).requestDevice();
  const pending = device.gatt.connect();
  device.gatt.disconnect();
  complete!({ connection: 11 });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(closed, [11]);
  assert.equal(device.gatt.connected, false);
});
