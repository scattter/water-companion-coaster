import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';

export interface PortInfo { path: string; manufacturer?: string }
export interface SerialConnection extends EventEmitter {
  isOpen: boolean;
  open(callback: (error: Error | null) => void): unknown;
  write(data: string, callback: (error?: Error | null) => void): unknown;
  close(callback: (error: Error | null) => void): unknown;
}

interface SetupOptions {
  deviceId: string;
  deviceToken: string;
  listPorts: () => Promise<PortInfo[]>;
  createPort: (path: string) => SerialConnection;
  serverUrls: () => string[];
  timeoutMs?: number;
  bootDelayMs?: number;
}

export interface SerialStatus {
  firmwareVersion: string;
  raw: number | null;
  weightGrams: number | null;
  stable: boolean;
  calibrated: boolean;
  emptyCupGrams: number;
  wifiConnected: boolean;
  serverConnected: boolean;
  ip: string;
  restartRequired: boolean;
  error: string | null;
}

export class SetupError extends Error {
  constructor(message: string, public statusCode = 409) { super(message); }
}

export interface CalibrationInput { cmd: 'tare' | 'calibrate' | 'cup'; grams?: number }

export function localServerUrls(port: number): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses ?? []).filter((item) => item.family === 'IPv4' && !item.internal
      && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))
      .map((item) => `http://${item.address}:${port}`)))];
}

export function parseStatus(value: Record<string, unknown>): SerialStatus | null {
  const nullableNumber = (item: unknown) => item === null || (typeof item === 'number' && Number.isFinite(item));
  if (typeof value.firmwareVersion !== 'string' || !nullableNumber(value.raw)
    || !nullableNumber(value.weightGrams) || typeof value.stable !== 'boolean'
    || typeof value.calibrated !== 'boolean' || typeof value.emptyCupGrams !== 'number'
    || typeof value.wifiConnected !== 'boolean' || typeof value.serverConnected !== 'boolean'
    || typeof value.ip !== 'string' || typeof value.restartRequired !== 'boolean'
    || !(value.error === null || typeof value.error === 'string')) return null;
  return {
    firmwareVersion: value.firmwareVersion, raw: value.raw as number | null,
    weightGrams: value.weightGrams as number | null, stable: value.stable,
    calibrated: value.calibrated, emptyCupGrams: value.emptyCupGrams,
    wifiConnected: value.wifiConnected, serverConnected: value.serverConnected,
    ip: value.ip, restartRequired: value.restartRequired, error: value.error,
  };
}

export class DeviceSetup {
  private port: SerialConnection | null = null;
  private path: string | null = null;
  private busy = false;
  private ready = false;
  private pending: {
    kind: 'status' | 'ack';
    resolve: (value: SerialStatus | string) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(private options: SetupOptions) {}

  async choices() {
    const ports = await this.options.listPorts().catch(() => { throw new SetupError('无法读取串口列表，请检查 USB 连接', 503); });
    return {
      ports: ports.map(({ path, manufacturer }) => ({ path, manufacturer })),
      serverUrls: this.options.serverUrls(), deviceId: this.options.deviceId,
    };
  }

  // 固件回复没有请求编号；整个配置过程独占串口，避免状态轮询抢走确认。
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new SetupError('上一项 USB 操作尚未完成，请稍后重试');
    this.busy = true;
    try { return await operation(); } finally { this.busy = false; }
  }

  private received(line: string) {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line); } catch { return; }
    if (!value || typeof value !== 'object' || !this.pending) return;
    if (this.pending.kind === 'status') {
      const status = parseStatus(value);
      if (status) this.pending.resolve(status);
    } else if (value.ok === true) {
      this.pending.resolve(typeof value.message === 'string' ? value.message : '操作成功');
    } else if (value.ok === false) {
      this.pending.reject(new SetupError(typeof value.error === 'string' ? value.error : '设备拒绝了操作'));
    }
  }

  private async exchange(command: Record<string, unknown>, kind: 'status' | 'ack'): Promise<SerialStatus | string> {
    const port = this.port;
    if (!port?.isOpen) throw new SetupError('请先连接 USB 杯垫');
    const data = `${JSON.stringify(command)}\n`;
    if (Buffer.byteLength(data) > 767) throw new SetupError('命令过长，请缩短配置内容', 400);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时后关闭连接，迟到的确认不能被下一条写入误认为成功。
        void this.close(new SetupError('设备未回复，操作结果尚未确认；请检查固件和 USB 后重新连接', 504));
      }, this.options.timeoutMs ?? 5000);
      const finish = () => { clearTimeout(timer); this.pending = null; };
      this.pending = {
        kind,
        resolve: (value) => { finish(); resolve(value); },
        reject: (error) => { finish(); reject(error); },
      };
      port.write(data, (error) => {
        if (error && this.port === port) void this.close(new SetupError('串口写入失败，请重新连接 USB', 503));
      });
    });
  }

  private readStatus() { return this.exchange({ cmd: 'status' }, 'status') as Promise<SerialStatus>; }
  private ack(command: Record<string, unknown>) { return this.exchange(command, 'ack') as Promise<string>; }
  private requireReady() {
    if (!this.ready || !this.port?.isOpen) throw new SetupError('请先连接 USB 杯垫');
  }

  async connect(path: string) {
    return this.run(async () => {
      const choices = await this.choices();
      if (!choices.ports.some((item) => item.path === path)) throw new SetupError('串口已不可用，请刷新端口列表', 400);
      await this.close();
      const port = this.options.createPort(path);
      this.port = port;
      this.path = path;
      let buffer = '';
      const decoder = new StringDecoder('utf8');
      port.on('data', (chunk: Buffer) => {
        if (this.port !== port) return;
        buffer += decoder.write(chunk);
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length <= 4096) this.received(line);
        }
        if (buffer.length > 4096) buffer = '';
      });
      const lost = () => {
        if (this.port === port) void this.close(new SetupError('USB 连接已断开，请重新连接', 503));
      };
      port.on('close', lost);
      port.on('error', lost);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new SetupError('打开串口超时，请检查 USB 连接后重试', 504)), this.options.timeoutMs ?? 5000);
          port.open((error) => {
            clearTimeout(timer);
            if (error) reject(new SetupError('无法打开串口，请关闭 Arduino 串口监视器并检查 USB 连接', 503));
            else if (this.port !== port) {
              if (port.isOpen) port.close(() => {});
              reject(new SetupError('USB 连接已断开，请重新连接', 503));
            } else resolve();
          });
        });
        await delay(this.options.bootDelayMs ?? 1200);
        await this.readStatus();
        await this.ack({ cmd: 'watch', enabled: false });
        const device = await this.readStatus();
        this.ready = true;
        return { connected: true, path, device };
      } catch (error) { await this.close(); throw error; }
    });
  }

  async status() {
    return this.run(async () => {
      if (!this.ready) return { connected: false, path: null, device: null };
      return { connected: true, path: this.path, device: await this.readStatus() };
    });
  }

  async configure(input: { ssid: string; password: string; serverUrl: string }) {
    return this.run(async () => {
      this.requireReady();
      const ssidLength = Buffer.byteLength(input.ssid);
      const passwordLength = Buffer.byteLength(input.password);
      if (ssidLength < 1 || ssidLength > 32 || (passwordLength !== 0 && (passwordLength < 8 || passwordLength > 63))
        || input.ssid.includes('\0') || input.password.includes('\0')) {
        throw new SetupError('Wi-Fi 名称需为 1–32 字节；密码为空或 8–63 字节', 400);
      }
      if (!this.options.serverUrls().includes(input.serverUrl)) throw new SetupError('请选择这台电脑当前的局域网地址', 400);
      if (!/^[!-~]{16,128}$/.test(this.options.deviceToken)) throw new SetupError('请先在 .env 配置 16–128 位设备凭证', 400);
      await this.ack({ cmd: 'wifi', ssid: input.ssid, password: input.password });
      try {
        await this.ack({ cmd: 'server', url: input.serverUrl, id: this.options.deviceId, token: this.options.deviceToken });
        await this.ack({ cmd: 'reboot' });
      } catch (error) {
        throw new SetupError(`Wi-Fi 已保存，但联网配置尚未全部确认。${error instanceof SetupError ? error.message : '请重新连接后再次配置'}`);
      }
      await this.close();
      return { message: '配置已保存，杯垫正在重启；等待屏幕与网页显示联网成功，校准前请重新连接 USB。' };
    });
  }

  async calibrate(input: CalibrationInput) {
    return this.run(async () => {
      this.requireReady();
      if (input.cmd === 'calibrate' && (!Number.isFinite(input.grams) || input.grams! < 50 || input.grams! > 2000)) {
        throw new SetupError('请输入 50–2000 g 的已知砝码质量', 400);
      }
      await this.ack(input.cmd === 'calibrate' ? { cmd: input.cmd, grams: input.grams } : { cmd: input.cmd });
      const message = {
        tare: '空载归零成功；接下来放上已知重量的物品。',
        calibrate: '重量校准成功；接下来放上日常空杯并更新空杯重量。',
        cup: '空杯重量已更新；可以加水后开始使用。',
      }[input.cmd];
      try {
        return { message, connected: true, path: this.path, device: await this.readStatus() };
      } catch {
        throw new SetupError(`${message}但最新状态读取失败，请重新连接 USB 检查。`, 503);
      }
    });
  }

  async disconnect() { return this.run(async () => { await this.close(); return { ok: true }; }); }

  async close(error = new SetupError('USB 连接已关闭')) {
    const port = this.port;
    this.port = null;
    this.path = null;
    this.ready = false;
    this.pending?.reject(error);
    if (port?.isOpen) await new Promise<void>((resolve) => port.close(() => resolve()));
  }
}

export function setupRoutes(app: FastifyInstance, setup: DeviceSetup) {
  app.addHook('onClose', async () => { await setup.close(); });
  app.get('/api/setup/options', () => setup.choices());
  app.get('/api/setup/status', () => setup.status());
  app.post<{ Body: { path: string } }>('/api/setup/connect', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string', minLength: 1, maxLength: 256 } } } },
  }, (request) => setup.connect(request.body.path));
  app.post('/api/setup/disconnect', () => setup.disconnect());
  app.post<{ Body: { ssid: string; password: string; serverUrl: string } }>('/api/setup/wifi', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['ssid', 'password', 'serverUrl'],
      properties: { ssid: { type: 'string', minLength: 1, maxLength: 32 }, password: { type: 'string', maxLength: 63 },
        serverUrl: { type: 'string', maxLength: 191 } } } },
  }, (request) => setup.configure(request.body));
  app.post<{ Body: CalibrationInput }>('/api/setup/calibrate', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['cmd'],
      properties: { cmd: { enum: ['tare', 'calibrate', 'cup'] }, grams: { type: 'number', minimum: 50, maximum: 2000 } } } },
  }, (request) => setup.calibrate(request.body));
}
