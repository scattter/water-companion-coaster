import { addPluginListener, invoke, type PluginListener } from '@tauri-apps/api/core';
import { BLE_UUID, type BluetoothAccess, type BleCharacteristic, type BleServer, type BleDevice } from '../../../web/src/ble';
import { nativeError } from './errors';

export interface BleEvent { type: 'value' | 'disconnected'; connection: number; uuid?: string }
export type Call = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const call: Call = <T>(command: string, args?: Record<string, unknown>) => invoke<T>(`plugin:coaster-mobile|${command}`, args).catch((cause: unknown) => { throw nativeError(cause); });

class Characteristic extends EventTarget implements BleCharacteristic {
  constructor(private readonly server: Server, readonly uuid: string) { super(); }
  async readValue(): Promise<DataView> {
    const result = await this.server.operation<{ value: string }>('read', this.uuid);
    const bytes = Uint8Array.from(atob(result.value), char => char.charCodeAt(0));
    return new DataView(bytes.buffer);
  }
  async writeValueWithResponse(value: Uint8Array<ArrayBuffer>) {
    await this.server.operation('write', this.uuid, btoa(String.fromCharCode(...value)));
  }
  async startNotifications() { await this.server.operation('subscribe', this.uuid); return this; }
}
class Server implements BleServer {
  connected = false;
  connection = 0;
  private version = 0;
  private characteristics = new Map<string, Characteristic>();
  constructor(private readonly device: Device, private readonly call: Call) {}
  async connect() {
    const version = this.version;
    const value = await this.call<{ connection: number }>('connect', { id: this.device.id });
    if (version !== this.version) {
      void this.call('disconnect', { connection: value.connection }).catch(() => undefined);
      throw new DOMException('蓝牙操作已停止。', 'AbortError');
    }
    this.connection = value.connection;
    this.connected = true;
    return this;
  }
  disconnect() {
    ++this.version;
    const connected = this.connected;
    this.connected = false;
    this.characteristics.clear();
    if (connected) void this.call('disconnect', { connection: this.connection }).catch(() => undefined);
  }
  async getPrimaryService(uuid: string) {
    if (uuid !== BLE_UUID.service || !this.connected) throw new Error('杯垫蓝牙服务未连接。');
    return { getCharacteristic: async (id: string) => {
      let characteristic = this.characteristics.get(id);
      if (!characteristic) { characteristic = new Characteristic(this, id); this.characteristics.set(id, characteristic); }
      return characteristic;
    } };
  }
  async operation<T>(command: string, uuid: string, value?: string): Promise<T> {
    if (!this.connected) throw new Error('蓝牙已断开。');
    const version = this.version;
    const result = await this.call<T>(command, { uuid, connection: this.connection, value });
    if (!this.connected || version !== this.version) throw new DOMException('蓝牙连接已变化。', 'AbortError');
    return result;
  }
  receive(event: BleEvent) {
    if (!this.connected || event.connection !== this.connection) return;
    if (event.type === 'disconnected') {
      this.connected = false;
      ++this.version;
      this.device.dispatchEvent(new Event('gattserverdisconnected'));
    } else if (event.uuid) this.characteristics.get(event.uuid)?.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}
class Device extends EventTarget implements BleDevice {
  readonly gatt: Server;
  constructor(readonly id: string, call: Call) { super(); this.gatt = new Server(this, call); }
}
export class AndroidBluetooth implements BluetoothAccess {
  private device?: Device;
  private listener?: PluginListener;
  constructor(private readonly native: Call = call) {}
  async listen() { this.listener = await addPluginListener<BleEvent>('coaster-mobile', 'ble', event => this.receive(event)); }
  receive(event: BleEvent) { this.device?.gatt.receive(event); }
  async requestDevice() {
    this.device?.gatt.disconnect();
    const { id } = await this.native<{ id: string }>('choose');
    this.device = new Device(id, this.native);
    return this.device;
  }
  dispose() { this.device?.gatt.disconnect(); void this.listener?.unregister(); }
}
