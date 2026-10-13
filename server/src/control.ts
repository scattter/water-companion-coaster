import { isIPv4 } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { parseStatus, SetupError, type CalibrationInput } from './setup.js';

export class DeviceControl {
  private address: string | null = null;
  private lastSeen = 0;
  private busy = false;

  constructor(private options: {
    deviceId: string;
    deviceToken: string;
    now: () => Date;
    fetch?: typeof fetch;
  }) {}

  seen(address: string) {
    const ip = address.replace(/^::ffff:/i, '');
    this.address = isIPv4(ip) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ? ip : null;
    this.lastSeen = this.options.now().getTime();
  }

  private async send(input?: CalibrationInput): Promise<Record<string, unknown>> {
    const age = this.options.now().getTime() - this.lastSeen;
    if (!this.address || age < 0 || age > 15_000) throw new SetupError('杯垫尚未通过局域网连接，请等待设备在线后重试');
    if (this.busy) throw new SetupError('上一项杯垫操作尚未完成，请稍后重试');
    this.busy = true;
    try {
      const response = await (this.options.fetch ?? fetch)(`http://${this.address}/api/control/${input ? 'calibrate' : 'status'}`, {
        method: input ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${this.options.deviceToken}`, 'x-device-id': this.options.deviceId,
          ...(input ? { 'content-type': 'application/json' } : {}) },
        body: input ? JSON.stringify(input) : undefined,
        redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      if (response.status === 404 || response.status === 403) {
        throw new SetupError('当前固件不支持本页无线校准，请上传 0.4.4 或更新版本；也可展开 USB 备用设置', 409);
      }
      if (response.status === 401) throw new SetupError('杯垫与后端的设备凭证不一致，请检查联网配置', 502);
      const data: unknown = await response.json().catch(() => null);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid device response');
      const result = data as Record<string, unknown>;
      if (!response.ok || result.ok === false) {
        throw new SetupError(typeof result.error === 'string' ? result.error : '杯垫拒绝了操作，请检查设备状态');
      }
      if (input && result.ok !== true) throw new Error('Missing acknowledgement');
      return result;
    } catch (error) {
      if (error instanceof SetupError) throw error;
      // 写入不自动重试；超时可能发生在设备保存之后，不能将未知结果显示为成功。
      throw new SetupError(input ? '未收到设备确认，操作结果尚未确认；请刷新状态后再继续'
        : '无法读取杯垫状态，请确认电脑与杯垫处于同一网络', 504);
    } finally { this.busy = false; }
  }

  async status() {
    const device = parseStatus(await this.send());
    if (!device) throw new SetupError('杯垫状态响应无效，请检查固件版本', 502);
    return { device };
  }

  async calibrate(input: CalibrationInput) {
    if (input.cmd === 'calibrate' && (!Number.isFinite(input.grams) || input.grams! < 50 || input.grams! > 2000)) {
      throw new SetupError('请输入 50–2000 g 的已知物品重量', 400);
    }
    const result = await this.send(input);
    const value = result.device;
    const device = value && typeof value === 'object' && !Array.isArray(value)
      ? parseStatus(value as Record<string, unknown>) : null;
    if (!device) throw new SetupError('设备已确认保存，但最新状态读取失败，请刷新状态后再继续', 502);
    return { device, message: typeof result.message === 'string' ? result.message : '操作已保存' };
  }
}

export function controlRoutes(app: FastifyInstance, control: DeviceControl) {
  app.get('/api/control/status', () => control.status());
  app.post<{ Body: CalibrationInput }>('/api/control/calibrate', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['cmd'],
      properties: { cmd: { enum: ['tare', 'calibrate', 'cup'] }, grams: { type: 'number', minimum: 50, maximum: 2000 } } } },
  }, (request) => control.calibrate(request.body));
}
