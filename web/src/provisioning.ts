import { ApiError } from './api';
import type { BleStatus, DeviceInfo, ProvisionConfig, WifiNetwork } from './ble';
import { validateWifi } from './ble';
import type { Session } from './session';
import { sameBinding, uuidPattern } from './session';

export interface AuthorizationResult {
  operationId: string;
  serverUrl: string;
  expiresAt: number;
  authorization: { payload: string; signature: string };
}
export interface EnrollmentResult {
  operationId: string;
  hardwareId: string;
  deviceId: string | null;
  serverUrl: string;
  ticket: string;
  expiresAt: number;
}
export interface OperationStatus {
  operationId: string;
  deviceId: string | null;
  hardwareId?: string;
  status: 'issued' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'expired';
  bindingId: string | null;
  code?: string;
  message?: string;
}
export interface RememberedOperation {
  operationId: string;
  deviceId: string;
  deploymentId: string;
  expiresAt: number;
  protocolVersion?: 1 | 2;
  hardwareId?: string;
}
export interface ProvisionState {
  info: DeviceInfo | null;
  operation: RememberedOperation | null;
  server: OperationStatus | null;
  ble: BleStatus | null;
  connected: boolean;
  busy: boolean;
  paused: boolean;
  complete: boolean;
  message: string;
  messageKind: 'progress' | 'notice' | 'silent';
  error: string;
  wifiNetworks: WifiNetwork[];
  scanning: boolean;
  scanError: string;
}
interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface ProvisionTransport {
  readonly connected: boolean;
  choose(): Promise<DeviceInfo>;
  reconnect(): Promise<DeviceInfo>;
  readStatus(): Promise<BleStatus>;
  scanWifi(): Promise<WifiNetwork[]>;
  send(config: ProvisionConfig): Promise<void>;
  disconnect(): void;
}
interface Dependencies {
  userId: string;
  currentSession(): Session;
  transport: ProvisionTransport;
  request<T>(path: string, body?: unknown): Promise<T>;
  storage: Storage;
  changed(state: ProvisionState): void;
  completed(session: Session): void;
  unauthorized(cause: ApiError): void;
  now?: () => number;
}
const terminal = new Set<OperationStatus['status']>(['completed', 'failed', 'cancelled', 'expired']);
const stages: Record<BleStatus['stage'], string> = {
  idle: '等待配网', received: '已收到配置', wifi_connecting: '正在连接 Wi-Fi', cloud_verifying: '正在验证云端授权',
  bound: '已认领，等待设备保存', saving: '正在保存设备配置', completed: '设备已保存，正在确认云端', failed: '设备配网失败', recovering: '正在恢复上次配网',
};

const failureCodes: Record<string, string> = {
  INVALID_FRAME: '蓝牙数据帧未完整送达，请重连并查询本次结果。',
  CHALLENGE_EXPIRED: '蓝牙配网会话已过期，请重新开启杯垫配网窗口。',
  INVALID_AUTHORIZATION: '本次配置与设备或配网会话不符，请重新连接杯垫；已有设备需使用原服务地址。',
  WIFI_FAILED: 'Wi-Fi 连接失败，请检查网络名称和密码。',
  WIFI_CONNECT_FAILED: 'Wi-Fi 连接失败，请检查网络名称和密码。',
  INTERRUPTED: '上次配网在完成前中断，请重新连接杯垫并开始配网。',
  DEVICE_ALREADY_BOUND: '此杯垫已属于其他账号，请由当前主人先解绑。',
  USER_ALREADY_BOUND: '当前账号已绑定另一台杯垫，请先解绑原杯垫。',
  SIGNING_NOT_READY: '云端签名服务尚未就绪，请联系管理员检查部署配置。',
  DEPLOYMENT_MISMATCH: '杯垫信任的部署与当前网站不符，请联系管理员通过 USB 检查配置。',
  CHALLENGE_REUSED: '当前配网会话已使用，请重连杯垫获取新的会话后重试。',
  OPERATION_NOT_FOUND: '当前账号无法查询此操作，请确认登录账号与设备归属。',
  SERVER_URL_NOT_CONFIGURED: '管理员尚未配置配网服务器地址，请联系管理员处理。',
  CONFIG_CHANGED: '管理员已更新服务器配置，本次授权已作废，请重新配网。',
  BINDING_ENDED: '当前绑定已结束，本次配网操作已作废。',
  DEVICE_MISMATCH: '设备身份与已有记录不一致，请确认连接的是原来的杯垫。',
  DEVICE_AUTH_FAILED: '设备身份验证失败，请继续查询上次配网结果，或重新连接原设备。',
  OPERATION_EXPIRED: '本次授权已过期，请重新连接杯垫并开始配网。',
};
export function provisioningFailure(code?: string) { return code ? failureCodes[code] : undefined; }

export function provisionStorageKey(userId: string) { return `water-provision:v1:${encodeURIComponent(userId)}`; }

export class ProvisionFlow {
  readonly state: ProvisionState = {
    info: null, operation: null, server: null, ble: null, connected: false, busy: false, paused: false,
    complete: false, message: '', messageKind: 'progress', error: '',
    wifiNetworks: [], scanning: false, scanError: '',
  };
  private version = 0;
  private scanVersion = 0;
  private disposed = false;
  private polling: number | null = null;
  private authorization: AuthorizationResult | EnrollmentResult | null = null;
  private authorizationChallenge: string | null = null;
  private issuing = false;
  private sentOnConnection: string | null = null;
  private rejectedChallenge: string | null = null;
  private deviceFailureVersion = 0;
  private deviceFailureConfirmed = false;
  private pollUntil = 0;
  private readonly key: string;
  private readonly now: () => number;
  private readonly initialSession: Session;

  constructor(private readonly deps: Dependencies) {
    this.key = provisionStorageKey(deps.userId);
    this.now = deps.now ?? Date.now;
    this.initialSession = { ...deps.currentSession() };
    try {
      const raw = deps.storage.getItem(this.key);
      if (raw) {
        const value = JSON.parse(raw) as RememberedOperation;
        if (!uuidPattern.test(value.operationId) || (value.protocolVersion === 2 ? !/^[a-f0-9]{12}$/.test(value.hardwareId ?? '') : !uuidPattern.test(value.deploymentId))
          || typeof value.deviceId !== 'string' || !Number.isFinite(value.expiresAt)) throw new Error();
        this.state.operation = { operationId: value.operationId, deploymentId: value.deploymentId, deviceId: value.deviceId, expiresAt: value.expiresAt,
          ...(value.protocolVersion === 2 ? { protocolVersion: 2, hardwareId: value.hardwareId } : {}) };
        this.message('找到上次配网，先查询同一次操作。刷新后无需重新发送密码。');
        this.pollUntil = this.now() + 120000;
      }
    } catch { this.state.error = '无法读取上次配网编号。请先确认杯垫和账号状态，再开始新的配网。'; }
  }

  private publish() { if (!this.disposed) this.deps.changed({ ...this.state }); }
  private message(text: string, kind: ProvisionState['messageKind'] = 'progress') {
    this.state.message = text;
    this.state.messageKind = kind;
  }
  private valid(version: number) {
    return !this.disposed && version === this.version && sameBinding(this.initialSession, this.deps.currentSession());
  }
  private failure(cause: unknown, fallback: string) {
    if (cause instanceof ApiError && cause.status === 401) this.deps.unauthorized(cause);
    // Avoid displaying untrusted response bodies that might echo credentials.
    this.state.error = cause instanceof ApiError && provisioningFailure(cause.code)
      ? provisioningFailure(cause.code)!
      : cause instanceof ApiError && cause.status === 403
        ? '当前账号没有此操作的权限，请确认设备归属；登录状态已保留。'
        : fallback;
  }

  get needsFreshConnection() { return this.deviceFailureConfirmed && (!this.state.connected || this.state.info?.challenge === this.rejectedChallenge); }
  get canStart() {
    return !this.issuing && (!this.state.operation || (this.state.server !== null && terminal.has(this.state.server.status))
      || (this.deviceFailureConfirmed && this.state.server?.status === 'issued' && this.state.connected && Boolean(this.state.info)
        && this.state.info?.challenge !== this.rejectedChallenge));
  }
  get canResend() {
    return this.state.ble?.stage !== 'failed' && this.state.connected && Boolean(this.authorization) && this.state.server?.status === 'issued'
      && this.state.info?.challenge === this.authorizationChallenge && this.now() < (this.authorization?.expiresAt ?? 0);
  }

  get canScanWifi() {
    return this.state.connected && this.state.info?.wifiScan === true && !this.state.complete && (this.canStart || this.canResend);
  }

  async scanWifi() {
    if (!this.canScanWifi || this.state.busy || this.disposed) return;
    const version = this.version;
    const scanVersion = ++this.scanVersion;
    const current = () => this.valid(version) && scanVersion === this.scanVersion && this.state.connected;
    this.state.scanning = this.state.busy = true;
    this.state.scanError = '';
    this.publish();
    try {
      const networks = await this.deps.transport.scanWifi();
      if (current()) this.state.wifiNetworks = networks;
    } catch (cause) {
      if (current()) this.state.scanError = cause instanceof Error ? cause.message : '扫描未完成，请稍后重试。';
    } finally {
      if (this.valid(version) && scanVersion === this.scanVersion) {
        this.state.scanning = this.state.busy = false;
        this.publish();
      }
    }
  }

  async connect(reconnect = false) {
    if (this.state.busy || this.disposed) return;
    const version = this.version;
    this.sentOnConnection = null;
    if (this.state.complete) {
      this.state.operation = null;
      this.state.server = null;
      this.state.ble = null;
    }
    this.state.complete = false;
    this.state.busy = true;
    this.state.connected = false;
    this.state.info = null;
    this.state.wifiNetworks = [];
    this.state.scanError = '';
    this.state.error = '';
    this.message('请按系统提示确认配对，或输入杯垫屏幕上的配对码。');
    this.publish();
    try {
      // choose() is invoked synchronously from the click handler.
      const info = await (reconnect ? this.deps.transport.reconnect() : this.deps.transport.choose());
      if (!this.valid(version)) return;
      if (info.protocolVersion === 1 && !info.trusted) throw new Error('untrusted');
      const target = this.state.operation && !this.canStart ? this.state.operation.deviceId : this.initialSession.deviceId;
      if (this.state.operation?.protocolVersion === 2 && !this.canStart) {
        if (info.hardwareId !== this.state.operation.hardwareId) throw new Error('wrong-device');
      } else if (target && info.deviceId !== target && !(info.protocolVersion === 2 && !info.deviceId)) throw new Error('wrong-device');
      if (info.protocolVersion === 1 && this.state.operation && !this.canStart && info.deploymentId !== this.state.operation.deploymentId) throw new Error('wrong-deployment');
      if (this.authorizationChallenge && info.challenge !== this.authorizationChallenge) this.authorization = null;
      this.state.info = info;
      this.state.connected = true;
      this.state.paused = false;
      this.pollUntil = this.now() + 120000;
      this.message('已连接杯垫。请使用 2.4 GHz Wi-Fi，并保持杯垫供电。');
    } catch (cause) {
      if (!this.valid(version)) return;
      this.deps.transport.disconnect();
      this.state.connected = false;
      this.state.info = null;
      const name = cause instanceof Error ? cause.name : '';
      this.state.error = name === 'NotFoundError' || name === 'AbortError' ? '已取消蓝牙选择或配对，可再次选择杯垫。'
        : name === 'NotAllowedError' ? '蓝牙权限未开启，请在浏览器或系统应用设置中允许访问后重试。'
        : cause instanceof Error && cause.message === 'wrong-device' ? '所选杯垫不是本次操作或当前账号的设备，请选择同一台杯垫。'
        : cause instanceof Error && ['untrusted', 'wrong-deployment'].includes(cause.message) ? '当前为旧版配网固件，请升级至 0.7.0 或更新版本以自动注册绑定。'
        : '蓝牙连接失败或超时。请确认蓝牙已打开、杯垫处于配网窗口，并按系统提示完成配对。';
      this.state.messageKind = 'silent';
    } finally {
      if (this.valid(version)) { this.state.busy = false; this.publish(); }
    }
    if (this.valid(version) && this.canScanWifi) await this.scanWifi();
  }

  async start(ssid: string, password: string) {
    if (this.state.busy || !this.canStart || !this.state.info || !this.state.connected || this.disposed) return;
    try { validateWifi(ssid, password); }
    catch (cause) { this.state.error = (cause as Error).message; this.publish(); return; }
    const version = ++this.version;
    const info = this.state.info;
    this.state.busy = true;
    this.state.complete = false;
    this.state.server = null;
    this.state.ble = null;
    this.rejectedChallenge = null;
    this.deviceFailureConfirmed = false;
    this.state.error = '';
    this.message('正在向云端申请本次配网授权…');
    this.publish();
    let issued = false;
    this.issuing = true;
    this.authorization = null;
    try {
      // Check storage before issuing an operation; never persist Wi-Fi or authorization.
      this.deps.storage.setItem(this.key, JSON.stringify({ storageCheck: true }));
      this.deps.storage.removeItem(this.key);
      this.state.operation = null;
      const result = info.protocolVersion === 2
        ? await this.deps.request<EnrollmentResult>('/api/enrollment/operations', { hardwareId: info.hardwareId, deviceId: info.deviceId || null, challenge: info.challenge })
        : await this.deps.request<AuthorizationResult>('/api/provisioning/operations', { deviceId: info.deviceId, deploymentId: info.deploymentId, challenge: info.challenge });
      if (!uuidPattern.test(result.operationId) || !Number.isFinite(result.expiresAt)
        || ('ticket' in result ? !/^[a-f0-9]{64}$/.test(result.ticket) || result.hardwareId !== info.hardwareId || typeof result.serverUrl !== 'string'
          : !result.authorization || typeof result.authorization.payload !== 'string' || !/^[0-9a-f]{128}$/i.test(result.authorization.signature))) throw new Error('invalid-authorization');
      issued = true;
      const operation: RememberedOperation = { operationId: result.operationId, deviceId: 'ticket' in result ? result.deviceId ?? '' : info.deviceId,
        deploymentId: info.deploymentId, expiresAt: result.expiresAt,
        ...(info.protocolVersion === 2 ? { protocolVersion: 2, hardwareId: info.hardwareId } : {}) };
      if (!this.disposed) this.state.operation = operation;
      // A cancel while HTTP was in flight must still preserve the returned ID, but never send it.
      this.deps.storage.setItem(this.key, JSON.stringify(operation));
      if (!this.valid(version)) {
        if (!this.disposed) { this.state.operation = operation; this.publish(); }
        return;
      }
      this.state.operation = operation;
      this.authorization = result;
      this.authorizationChallenge = info.challenge;
      this.state.paused = false;
      this.pollUntil = this.now() + 120000;
      this.message('正在发送配置。密码不会保存到浏览器。');
      this.publish();
      this.sentOnConnection = result.operationId;
      await this.deps.transport.send(this.config(result, info.challenge, ssid, password));
      if (!this.valid(version)) return;
      this.message('配置已发送，等待连接云端并持久保存。');
    } catch (cause) {
      if (!this.valid(version)) return;
      this.failure(cause, issued ? '配置发送结果尚未确认，请查询同一次操作。不要重复开始新的配网。'
        : '未能确认授权申请，尚未向杯垫发送配置。请检查网络和浏览器存储权限后重试。');
    } finally {
      password = '';
      this.issuing = false;
      if (this.valid(version)) { this.state.busy = false; this.publish(); void this.poll(true); }
      else this.publish();
    }
  }

  private config(result: AuthorizationResult | EnrollmentResult, challenge: string, ssid: string, password: string): ProvisionConfig {
    return 'ticket' in result
      ? { protocolVersion: 2, operationId: result.operationId, hardwareId: result.hardwareId, challenge, ssid, password,
        serverUrl: result.serverUrl, ticket: result.ticket, expiresAt: result.expiresAt }
      : { protocolVersion: 1, operationId: result.operationId, ssid, password, authorization: result.authorization };
  }

  async resend(ssid: string, password: string) {
    if (this.state.busy || !this.canResend || !this.authorization || !this.state.operation) return;
    const version = this.version;
    this.state.busy = true;
    this.state.error = '';
    if (this.state.messageKind !== 'progress') this.state.messageKind = 'silent';
    this.publish();
    try {
      validateWifi(ssid, password);
      this.sentOnConnection = this.state.operation.operationId;
      await this.deps.transport.send(this.config(this.authorization, this.authorizationChallenge!, ssid, password));
      if (this.valid(version)) this.message('已重发同一次配置，等待设备确认。');
    } catch (cause) {
      if (this.valid(version)) this.failure(cause, '重发结果未确认，请继续查询同一次操作。');
    } finally {
      password = '';
      if (this.valid(version)) { this.state.busy = false; this.publish(); void this.poll(true); }
    }
  }

  receiveStatus(status: BleStatus) {
    if (status.operationId === '' && status.stage === 'failed' && this.state.connected
      && this.sentOnConnection && this.sentOnConnection === this.state.operation?.operationId) {
      status = { ...status, operationId: this.sentOnConnection };
    }
    if (this.disposed || this.state.complete || this.state.paused || status.operationId !== this.state.operation?.operationId
      || (this.state.ble && status.sequence <= this.state.ble.sequence)) return;
    this.state.ble = status;
    if (status.stage !== 'failed') this.deviceFailureConfirmed = false;
    this.message(stages[status.stage]);
    if (status.stage === 'failed') {
      this.rejectedChallenge ??= this.authorizationChallenge ?? this.state.info?.challenge ?? null;
      this.authorization = null;
      this.deviceFailureConfirmed = false;
      ++this.deviceFailureVersion;
      this.state.error = provisioningFailure(status.code) ?? '杯垫报告配网失败，请查询云端确认最终结果。';
    }
    this.publish();
    if (status.stage === 'completed' || status.stage === 'failed') void this.poll();
  }

  disconnected() {
    if (this.disposed) return;
    ++this.scanVersion;
    if (this.state.scanning) this.state.scanning = this.state.busy = false;
    this.state.wifiNetworks = [];
    this.state.connected = false;
    this.sentOnConnection = null;
    this.message(this.state.operation ? '蓝牙已断开；配网可能仍在继续，将查询云端结果。可重连同一台杯垫。' : '蓝牙已断开，请重新连接杯垫。', 'notice');
    this.publish();
  }

  transportError() {
    if (!this.disposed && !this.state.paused) {
      this.state.error = '暂时无法读取蓝牙状态，仍可查询云端或重新连接同一台杯垫。';
      this.publish();
    }
  }

  async poll(manual = false) {
    const operation = this.state.operation;
    const version = this.version;
    if (!operation || this.disposed || this.state.busy || this.state.complete || this.polling === version || (!manual && this.state.paused)) return;
    if (!manual && this.now() > this.pollUntil) {
      this.state.paused = true;
      this.message('等待超时，尚未确认结果。自动查询已暂停，可继续查询同一次配网。', 'notice');
      this.publish();
      return;
    }
    if (manual) {
      this.state.paused = false;
      this.pollUntil = this.now() + 120000;
      if (this.state.messageKind !== 'progress') this.state.messageKind = 'silent';
    }
    this.polling = version;
    const failureVersion = this.deviceFailureVersion;
    const current = () => this.valid(version) && this.state.operation?.operationId === operation.operationId;
    try {
      const status = await this.deps.request<OperationStatus>(`/api/${operation.protocolVersion === 2 ? 'enrollment' : 'provisioning'}/operations/${encodeURIComponent(operation.operationId)}`);
      if (!current()) return;
      if (status.operationId !== operation.operationId
        || (operation.protocolVersion === 2 ? status.hardwareId !== operation.hardwareId || (operation.deviceId && status.deviceId !== operation.deviceId) : status.deviceId !== operation.deviceId)
        || !['issued', 'claimed', 'completed', 'failed', 'cancelled', 'expired'].includes(status.status)) throw new Error('wrong-operation');
      if (operation.protocolVersion === 2 && status.deviceId && !operation.deviceId) {
        operation.deviceId = status.deviceId;
        this.deps.storage.setItem(this.key, JSON.stringify(operation));
      }
      this.state.server = status;
      this.deviceFailureConfirmed = status.status === 'issued' && this.state.ble?.stage === 'failed'
        && this.rejectedChallenge !== null && failureVersion === this.deviceFailureVersion;
      this.state.error = this.state.ble?.stage === 'failed' && !terminal.has(status.status)
        ? provisioningFailure(this.state.ble.code) ?? '杯垫报告配网失败，请确认云端结果后重新连接。' : '';
      if (status.status === 'completed') {
        // The server only marks completed after the device commits configuration and batch.
        // Recheck both account and current batch at the final transition, even on reload.
        const session = await this.deps.request<Session>('/api/auth/session');
        if (!current()) return;
        if (session.user?.id !== this.deps.userId || session.deviceId !== operation.deviceId
          || !status.bindingId || session.bindingId !== status.bindingId) {
          this.state.paused = true;
          this.state.error = '配网已完成，但当前账号或设备批次已变化。请刷新账号状态，未将此操作显示为成功。';
          return;
        }
        this.state.complete = true;
        this.message('杯垫已保存配置并完成云端确认，配网成功。');
        this.authorization = null;
        try { this.deps.storage.removeItem(this.key); } catch { /* Confirmed IDs contain no secrets. */ }
        this.deps.completed(session);
      } else if (terminal.has(status.status)) {
        this.state.paused = true;
        this.authorization = null;
        this.state.error = provisioningFailure(status.code) ?? (status.status === 'expired' ? '本次授权已过期，请重新连接杯垫并开始配网。'
          : status.status === 'cancelled' ? '本次操作已作废，请确认账号和设备归属后重新配网。' : '云端确认本次配网失败，请检查杯垫提示后重新配网。');
      } else {
        this.message(this.deviceFailureConfirmed ? '杯垫已明确拒绝本次配置，云端确认尚未认领。请重连同一台杯垫，获取新的配网会话后重试。'
          : status.status === 'claimed' ? '云端已认领，等待杯垫持久保存并提交完成。' : '授权已签发，等待杯垫连接云端。');
        if (this.deps.transport.connected) {
          try {
            const ble = await this.deps.transport.readStatus();
            if (current()) this.receiveStatus(ble);
          } catch { if (current()) this.state.connected = this.deps.transport.connected; }
        }
      }
    } catch (cause) {
      if (current()) this.failure(cause, '暂时无法确认云端结果。操作编号已保留，请恢复网络后继续查询。');
    } finally {
      if (this.polling === version) this.polling = null;
      if (current()) this.publish();
    }
  }

  pause(notify = true) {
    ++this.version;
    ++this.scanVersion;
    this.state.scanning = false;
    this.state.wifiNetworks = [];
    this.state.busy = false;
    this.state.paused = true;
    this.state.connected = false;
    this.sentOnConnection = null;
    this.authorization = null;
    this.deps.transport.disconnect();
    this.message(this.state.operation ? '已停止本页等待。已发送的配网仍可能完成，编号已保留；继续查询可确认结果。' : '已停止蓝牙操作。', notify ? 'notice' : 'silent');
    this.publish();
  }

  dispose() { this.pause(false); this.disposed = true; }
}
