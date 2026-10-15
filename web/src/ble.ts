import { uuidPattern } from './session';

export const BLE_UUID = {
  service: '7d2a0001-7b9c-4e6a-9f21-531bd67a0c10',
  info: '7d2a0002-7b9c-4e6a-9f21-531bd67a0c10',
  config: '7d2a0003-7b9c-4e6a-9f21-531bd67a0c10',
  status: '7d2a0004-7b9c-4e6a-9f21-531bd67a0c10',
  wifi: '7d2a0005-7b9c-4e6a-9f21-531bd67a0c10',
} as const;

// Only the Web Bluetooth surface this transport uses. No ambient browser patches.
export interface BleCharacteristic extends EventTarget {
  readValue(): Promise<DataView>;
  writeValueWithResponse(value: Uint8Array<ArrayBuffer>): Promise<void>;
  startNotifications(): Promise<BleCharacteristic>;
}
export interface BleServer {
  connected: boolean;
  connect(): Promise<BleServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<BleCharacteristic> }>;
}
export interface BleDevice extends EventTarget { gatt?: BleServer }
export interface BluetoothAccess {
  requestDevice(options: { filters: { services: string[] }[]; optionalServices: string[] }): Promise<BleDevice>;
}
export interface DeviceInfo {
  protocolVersion: 1 | 2;
  deviceId: string;
  hardwareId?: string;
  deploymentId: string;
  challenge: string;
  trusted: boolean;
  wifiScan?: boolean;
}
export interface WifiNetwork {
  ssid: string;
  rssi: number;
  channel: number;
  secure: boolean;
}
interface WifiScan {
  state: 'idle' | 'scanning' | 'ready' | 'failed';
  count: number;
  index?: number;
  network?: WifiNetwork;
  code?: string;
}
export const bleStages = ['idle', 'received', 'wifi_connecting', 'cloud_verifying', 'bound', 'saving', 'completed', 'failed', 'recovering'] as const;
export interface BleStatus {
  operationId: string;
  stage: typeof bleStages[number];
  message: string;
  sequence: number;
  code?: string;
}
export interface SignedProvisionConfig {
  protocolVersion: 1;
  operationId: string;
  ssid: string;
  password: string;
  authorization: { payload: string; signature: string };
}
export interface EnrollmentConfig {
  protocolVersion: 2;
  operationId: string;
  hardwareId: string;
  challenge: string;
  ssid: string;
  password: string;
  serverUrl: string;
  ticket: string;
  expiresAt: number;
}
export type ProvisionConfig = SignedProvisionConfig | EnrollmentConfig;

export function bluetoothCompatibility(secure: boolean, bluetooth?: BluetoothAccess): string {
  if (!secure) return '浏览器只允许在 HTTPS 或本机 localhost 页面使用蓝牙，请使用对应地址。';
  if (!bluetooth) return '当前浏览器不支持网页蓝牙。请用 Android 或电脑上的 Chrome / Edge；iPhone、iPad 或应用内浏览器可用下方热点方式，但杯垫必须已由管理员预配服务器地址。';
  return '';
}

export function validateWifi(ssid: string, password: string) {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password).length;
  if (ssid.includes('\0') || encoder.encode(ssid).length < 1 || encoder.encode(ssid).length > 32) {
    throw new Error('Wi-Fi 名称需为 1–32 字节，中文会占多个字节。');
  }
  if (password.includes('\0') || (passwordBytes !== 0 && (passwordBytes < 8 || passwordBytes > 63))) {
    throw new Error('Wi-Fi 密码需为 8–63 字节；开放网络请留空。');
  }
}

export function encodeFrames(config: ProvisionConfig): Uint8Array<ArrayBuffer>[] {
  const bytes = new TextEncoder().encode(JSON.stringify(config));
  if (!bytes.length || bytes.length > 4096) throw new Error('配网数据超过设备允许的大小。');
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0, sequence = 0; offset < bytes.length; offset += 17, sequence++) {
    const chunk = bytes.subarray(offset, offset + 17);
    const frame = new Uint8Array(3 + chunk.length);
    frame[0] = (offset === 0 ? 1 : 0) | (offset + chunk.length === bytes.length ? 2 : 0);
    new DataView(frame.buffer).setUint16(1, sequence, true);
    frame.set(chunk, 3);
    frames.push(frame);
  }
  return frames;
}

function readJson(value: DataView): Record<string, unknown> {
  try {
    if (value.byteLength > 4096) throw new Error();
    const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch { throw new Error('杯垫返回的数据不完整，请重新连接。'); }
}

export function parseInfo(value: DataView): DeviceInfo {
  const data = readJson(value);
  if (data.protocolVersion === 2) {
    if (typeof data.hardwareId !== 'string' || !/^[a-f0-9]{12}$/.test(data.hardwareId)
      || typeof data.deviceId !== 'string' || !/^[\w-]{0,64}$/.test(data.deviceId)
      || typeof data.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(data.challenge)) {
      throw new Error('杯垫返回的设备信息无效，请重新连接。');
    }
    return { protocolVersion: 2, hardwareId: data.hardwareId, deviceId: data.deviceId, challenge: data.challenge, deploymentId: '', trusted: true,
      ...(data.wifiScan === true ? { wifiScan: true } : {}) };
  }
  if (data.protocolVersion !== 1 || typeof data.deviceId !== 'string' || !/^[\w-]{1,64}$/.test(data.deviceId)
    || typeof data.deploymentId !== 'string' || (data.trusted !== false && !uuidPattern.test(data.deploymentId))
    || typeof data.challenge !== 'string' || !/^[0-9a-f]{64}$/i.test(data.challenge) || typeof data.trusted !== 'boolean') {
    throw new Error('杯垫不支持当前蓝牙配网协议，请联系管理员检查固件。');
  }
  return data as unknown as DeviceInfo;
}

export function parseStatus(value: DataView): BleStatus {
  const data = readJson(value);
  if (!bleStages.includes(data.stage as BleStatus['stage']) || typeof data.operationId !== 'string'
    || (!((data.stage === 'idle' || data.stage === 'failed') && data.operationId === '') && !uuidPattern.test(data.operationId)) || typeof data.message !== 'string'
    || !Number.isSafeInteger(data.sequence) || Number(data.sequence) < 0
    || (data.code !== undefined && typeof data.code !== 'string')) throw new Error('暂时无法读取完整配网状态，请重新查询。');
  return data as unknown as BleStatus;
}

export function parseWifiScan(value: DataView): WifiScan {
  const data = readJson(value);
  const invalid = () => new Error('杯垫返回的 Wi-Fi 列表不完整，请重新扫描。');
  if (!['idle', 'scanning', 'ready', 'failed'].includes(data.state as string)
    || !Number.isInteger(data.count) || Number(data.count) < 0 || Number(data.count) > 20
    || (data.state !== 'ready' && data.count !== 0)
    || (data.code !== undefined && typeof data.code !== 'string')) throw invalid();
  if (data.state === 'ready' && Number(data.count) > 0) {
    const network = data.network as Partial<WifiNetwork> | undefined;
    if (!Number.isInteger(data.index) || Number(data.index) < 0 || Number(data.index) >= Number(data.count)
      || !network || typeof network.ssid !== 'string' || network.ssid.includes('\0')
      || new TextEncoder().encode(network.ssid).length < 1 || new TextEncoder().encode(network.ssid).length > 32
      || !Number.isInteger(network.rssi) || Number(network.rssi) < -127 || Number(network.rssi) > 0
      || !Number.isInteger(network.channel) || Number(network.channel) < 1 || Number(network.channel) > 14
      || typeof network.secure !== 'boolean') throw invalid();
  }
  return data as unknown as WifiScan;
}

function deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DOMException('蓝牙响应超时，请重新连接后查询同一次配网。', 'TimeoutError')), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export class BleTransport {
  private device?: BleDevice;
  private config?: BleCharacteristic;
  private status?: BleCharacteristic;
  private wifi?: BleCharacteristic;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private notificationRead = false;
  private notificationDirty = false;
  private readingStatus = false;
  private detach?: () => void;
  private disconnected?: () => void;

  constructor(private readonly bluetooth: BluetoothAccess | undefined, private readonly handlers: {
    status: (value: BleStatus) => void;
    disconnected: () => void;
    error: (cause: unknown) => void;
  }, private readonly timeoutMs = 15000, private readonly pairingTimeoutMs = 60000) {}

  get connected() { return Boolean(this.device?.gatt?.connected && this.config && this.status); }

  async choose(): Promise<DeviceInfo> {
    this.disconnect();
    const version = this.generation;
    if (!this.bluetooth) throw new Error('此浏览器不支持网页蓝牙。');
    // Must execute in the button's click stack, before any other await.
    const selected = await deadline(this.bluetooth.requestDevice({ filters: [{ services: [BLE_UUID.service] }], optionalServices: [BLE_UUID.service] }), 60000);
    this.assertCurrent(version);
    this.device = selected;
    return this.open(version);
  }

  async reconnect(): Promise<DeviceInfo> {
    if (!this.device) throw new Error('请先点击“选择杯垫”，允许浏览器连接蓝牙。');
    this.disconnect();
    return this.open(this.generation);
  }

  private assertCurrent(version: number) {
    if (version !== this.generation) throw new DOMException('蓝牙操作已停止。', 'AbortError');
  }

  private async open(version: number): Promise<DeviceInfo> {
    const device = this.device;
    if (!device?.gatt) throw new Error('无法连接此设备的蓝牙服务。');
    const gatt = device.gatt;
    const disconnected = () => {
      if (version !== this.generation) return;
      this.disconnect();
      this.handlers.disconnected();
    };
    device.addEventListener('gattserverdisconnected', disconnected);
    this.disconnected = () => device.removeEventListener('gattserverdisconnected', disconnected);
    try {
      const connected = gatt.connect().then(server => {
        if (version !== this.generation) { server.disconnect(); this.assertCurrent(version); }
        return server;
      });
      const server = await deadline(connected, this.timeoutMs);
      this.assertCurrent(version);
      const service = await deadline(server.getPrimaryService(BLE_UUID.service), this.timeoutMs);
      this.assertCurrent(version);
      const info = await deadline(service.getCharacteristic(BLE_UUID.info), this.timeoutMs);
      this.assertCurrent(version);
      // Reading info triggers encrypted pairing, only after the user chose a device.
      const result = parseInfo(await deadline(info.readValue(), this.pairingTimeoutMs));
      this.assertCurrent(version);
      const config = await deadline(service.getCharacteristic(BLE_UUID.config), this.timeoutMs);
      this.assertCurrent(version);
      this.config = config;
      const status = await deadline(service.getCharacteristic(BLE_UUID.status), this.timeoutMs);
      this.assertCurrent(version);
      this.status = status;
      if (result.wifiScan) {
        this.wifi = await deadline(service.getCharacteristic(BLE_UUID.wifi), this.timeoutMs);
        this.assertCurrent(version);
      }
      const changed = () => this.onNotification(version);
      status.addEventListener('characteristicvaluechanged', changed);
      this.detach = () => status.removeEventListener('characteristicvaluechanged', changed);
      // Keep notification reads behind startNotifications on the same GATT queue.
      await this.serial(() => status.startNotifications());
      this.assertCurrent(version);
      this.onNotification(version);
      return result;
    } catch (cause) {
      if (version === this.generation) this.disconnect();
      throw cause;
    }
  }

  private serial<T>(action: () => Promise<T>, timeoutMs = this.timeoutMs): Promise<T> {
    const version = this.generation;
    const result = this.queue.then(async () => {
      this.assertCurrent(version);
      if (!this.device?.gatt?.connected) throw new Error('蓝牙已断开，请重新连接后查询。');
      try {
        const value = await deadline(action(), timeoutMs);
        this.assertCurrent(version);
        return value;
      } catch (cause) {
        if (version === this.generation && cause instanceof DOMException && cause.name === 'TimeoutError') {
          this.disconnect();
          this.handlers.disconnected();
        }
        throw cause;
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private onNotification(version: number) {
    if (version !== this.generation || this.readingStatus) return;
    this.notificationDirty = true;
    if (this.notificationRead) return;
    this.notificationRead = true;
    void (async () => {
      try {
        do {
          this.notificationDirty = false;
          const status = await this.readStatus();
          if (version === this.generation) this.handlers.status(status);
        } while (this.notificationDirty && version === this.generation);
      } catch (cause) {
        if (version === this.generation) this.handlers.error(cause);
      } finally {
        if (version === this.generation) this.notificationRead = false;
      }
    })();
  }

  readStatus(): Promise<BleStatus> {
    return this.serial(async () => {
      if (!this.status) throw new Error('蓝牙状态服务尚未连接。');
      const version = this.generation;
      this.readingStatus = true;
      // Chromium also fires characteristicvaluechanged for readValue(). Ignore
      // that echo while reading, otherwise each read starts an infinite read loop.
      try { return parseStatus(await this.status.readValue()); }
      finally { if (version === this.generation) this.readingStatus = false; }
    });
  }

  scanWifi(): Promise<WifiNetwork[]> {
    const version = this.generation;
    return this.serial(async () => {
      const wifi = this.wifi;
      if (!wifi) throw new Error('当前杯垫固件不支持 Wi-Fi 扫描，请升级固件或手动输入。');
      const read = async () => {
        this.assertCurrent(version);
        const value = await wifi.readValue();
        this.assertCurrent(version);
        return parseWifiScan(value);
      };
      await wifi.writeValueWithResponse(new Uint8Array([1]));
      let result = await read();
      while (result.state === 'scanning') {
        await new Promise(resolve => setTimeout(resolve, 250));
        result = await read();
      }
      if (result.state === 'failed') throw new Error(result.code === 'WIFI_BUSY'
        ? '杯垫正在连接 Wi-Fi，请稍后重新扫描。' : '扫描未完成，请稍后重试。');
      if (result.state !== 'ready') throw new Error('扫描未开始，请重新扫描。');
      const count = result.count;
      const networks: WifiNetwork[] = [];
      for (let index = 0; index < count; index++) {
        if (index > 0) {
          this.assertCurrent(version);
          await wifi.writeValueWithResponse(new Uint8Array([2, index]));
          result = await read();
        }
        if (result.state !== 'ready' || result.count !== count || result.index !== index || !result.network) {
          throw new Error('Wi-Fi 列表已变化，请重新扫描。');
        }
        networks.push(result.network);
      }
      const seen = new Set<string>();
      return networks.sort((a, b) => b.rssi - a.rssi).filter(network => {
        if (seen.has(network.ssid)) return false;
        seen.add(network.ssid);
        return true;
      });
    }, this.timeoutMs * 2);
  }

  async send(config: ProvisionConfig): Promise<void> {
    validateWifi(config.ssid, config.password);
    const frames = encodeFrames(config);
    const version = this.generation;
    try {
      await this.serial(async () => {
        if (!this.config) throw new Error('蓝牙配置服务尚未连接。');
        for (const frame of frames) {
          this.assertCurrent(version);
          await this.config.writeValueWithResponse(frame);
        }
      }, 9500);
    } finally {
      // Do not retain the UTF-8 authorization or Wi-Fi credentials after a write.
      frames.forEach(frame => frame.fill(0));
    }
  }

  disconnect() {
    ++this.generation;
    this.detach?.();
    this.disconnected?.();
    this.detach = undefined;
    this.disconnected = undefined;
    this.config = undefined;
    this.status = undefined;
    this.wifi = undefined;
    this.notificationRead = false;
    this.notificationDirty = false;
    this.readingStatus = false;
    this.queue = Promise.resolve();
    this.device?.gatt?.disconnect();
  }
}
