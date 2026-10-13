import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import { openDatabase, provisionDevice, hash } from './db.js';
import { authRoutes, fail } from './auth.js';

export interface AppOptions {
  deviceToken?: string;
  deviceId?: string;
  dbPath?: string;
  timeZone?: string;
  now?: () => Date;
  appOrigin?: string;
  allowedOrigins?: string[];
  logger?: FastifyServerOptions['logger'];
  trustProxy?: FastifyServerOptions['trustProxy'];
}

interface DeviceEvent {
  id: string;
  kind: 'drink' | 'refill';
  amountMl: number;
  beforeGrams: number;
  afterGrams: number;
  occurredAt: string;
}

interface EventRow extends DeviceEvent {
  revokedAt: string | null;
}

interface Heartbeat {
  weightGrams: number | null;
  stable: boolean;
  cupPresent: boolean;
  source: 'hx711';
  calibrated: boolean;
  emptyCupGrams: number | null;
  pendingCount: number;
  timePendingCount: number;
  clockSynced: boolean;
  error: string | null;
  firmwareVersion: string;
  commandResult?: { id: string; ok: boolean; message: string };
}

interface DeviceRow {
  lastSeenAt: string;
  payload: string;
}

const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
/** 解析可信反代链，例如 `127.0.0.1,::1,172.28.0.0/16`；容器部署需要写明内网网段。 */
export function parseTrustedProxies(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean).map((entry) => {
    const [address, prefix, ...rest] = entry.split('/');
    const family = isIP(address);
    if (family === 0 || rest.length > 0) throw new Error(`TRUST_PROXY 含有无效的代理地址：${entry}`);
    if (prefix === undefined) return address;
    const bits = Number(prefix);
    // 不接受 /0：那等于信任任意来源的自报地址，限流和审计都会失效。
    if (!/^\d{1,3}$/.test(prefix) || bits < 1 || bits > (family === 4 ? 32 : 128)) {
      throw new Error(`TRUST_PROXY 含有无效的前缀长度：${entry}`);
    }
    return `${address}/${bits}`;
  });
}
const dayMs = 86_400_000;
const defaultOrigins = ['localhost', '127.0.0.1', '[::1]']
  .flatMap((host) => [80, 3001, 5173].map((port) => `http://${host}:${port}`));

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isTimestamp(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  return !!match && isDate(match[1]) && Number(match[2]) < 24 && Number(match[3]) < 60
    && Number(match[4]) < 60 && (!match[6] || (Number(match[6]) < 24 && Number(match[7]) < 60))
    && Number.isFinite(Date.parse(value));
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * dayMs).toISOString().slice(0, 10);
}

function sameEvent(existing: EventRow, event: DeviceEvent): boolean {
  return existing.kind === event.kind && existing.amountMl === event.amountMl
    && existing.beforeGrams === event.beforeGrams && existing.afterGrams === event.afterGrams
    && existing.occurredAt === event.occurredAt;
}

export function createApp(options: AppOptions) {
  const timeZone = options.timeZone ?? 'Asia/Shanghai';
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const localDate = (instant: Date | string) => {
    const parts = dateFormatter.formatToParts(new Date(instant));
    const value = (type: string) => parts.find((part) => part.type === type)!.value;
    return `${value('year')}-${value('month')}-${value('day')}`;
  };
  const now = options.now ?? (() => new Date());
  const db = openDatabase(options.dbPath);
  // 旧单机配置只登记一次；后续启动不能覆盖生产设备密钥或归属。
  if (options.deviceToken) {
    const id = options.deviceId ?? 'coaster-01';
    const existing = db.prepare('SELECT token_hash AS tokenHash FROM devices WHERE id = ?').get(id) as { tokenHash: string } | undefined;
    if (!existing) provisionDevice(db, id, options.deviceToken, now().getTime());
    else if (existing.tokenHash !== hash(options.deviceToken)) { db.close(); throw new Error('DEVICE_TOKEN 与已登记设备不一致'); }
  }
  const eventColumns = `id, kind, amount_ml AS amountMl, before_grams AS beforeGrams,
    after_grams AS afterGrams, occurred_at AS occurredAt, revoked_at AS revokedAt`;
  const getEvent = db.prepare(`SELECT ${eventColumns} FROM device_events WHERE device_id = ? AND id = ?`);
  const insertEvent = db.prepare(`INSERT INTO device_events
    (device_id, id, kind, amount_ml, before_grams, after_grams, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const getEvents = db.prepare(`SELECT ${eventColumns} FROM device_events
    WHERE device_id = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at DESC, id DESC`);
  const revokeEvent = db.prepare('UPDATE device_events SET revoked_at = ? WHERE device_id = ? AND id = ? AND revoked_at IS NULL');
  const getDevice = db.prepare('SELECT last_seen_at AS lastSeenAt, payload FROM device_status WHERE id = ?');
  const saveDevice = db.prepare(`INSERT INTO device_status (id, last_seen_at, payload) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, payload = excluded.payload`);

  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
    bodyLimit: 512 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  app.addHook('onClose', async () => { db.close(); });
  const auth = authRoutes(app, db, {
    now, allowedOrigins: options.allowedOrigins ?? (options.appOrigin ? [new URL(options.appOrigin).origin] : defaultOrigins),
    secureCookie: options.appOrigin?.startsWith('https://') ?? false,
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error.validation || error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return reply.code(400).send({ error: '请求参数无效' });
    }
    if (error.statusCode === 415) return reply.code(415).send({ error: '请使用 JSON 请求' });
    if (error.statusCode && (error.statusCode >= 400 && error.statusCode < 500 || error.statusCode === 503)) return reply.code(error.statusCode).send({ error: error.message });
    request.log.error(error);
    return reply.code(500).send({ error: '服务暂时不可用' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '接口不存在' }));

  app.get('/api/health', async () => ({ ok: true }));
  function online(deviceId: string, timestamp: number) {
    const row = getDevice.get(deviceId) as unknown as DeviceRow | undefined;
    const age = row ? timestamp - Date.parse(row.lastSeenAt) : Infinity;
    return age >= 0 && age <= 15_000;
  }
  function expireCommands(deviceId: string, timestamp: number) {
    db.prepare(`UPDATE device_commands SET status = 'expired', message = '操作已过期，未在有效期内收到设备确认' WHERE device_id = ? AND status = 'pending' AND expires_at <= ?`)
      .run(deviceId, timestamp);
  }
  const commandColumns = 'id, status, message, expires_at AS expiresAt';
  const emptyBody = { body: { type: 'object', additionalProperties: false } };
  app.post('/api/device/binding', { schema: emptyBody }, async (request) => {
    const deviceId = auth.deviceId(request);
    auth.limit(`issue-code:${deviceId}`, 10, 60_000);
    const timestamp = now().getTime();
    const device = db.prepare('SELECT user_id AS userId FROM devices WHERE id = ?').get(deviceId) as { userId: string | null };
    if (device.userId) fail('设备已经绑定账号', 409);
    if (!online(deviceId, timestamp)) fail('请先等待杯垫连接云端', 503);
    db.prepare('DELETE FROM binding_codes WHERE expires_at <= ?').run(timestamp);
    let code: string;
    do { code = randomInt(100_000_000).toString().padStart(8, '0'); }
    while (db.prepare('SELECT code_hash FROM binding_codes WHERE code_hash = ?').get(hash(code)));
    const expiresAt = timestamp + 5 * 60_000;
    db.prepare(`INSERT INTO binding_codes (code_hash, device_id, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at`)
      .run(hash(code), deviceId, expiresAt);
    return { code, expiresAt };
  });
  app.post<{ Body: { code: string } }>('/api/devices/bind', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['code'], properties: { code: { type: 'string', pattern: '^[0-9]{8}$' } } } },
  }, async (request) => {
    const user = auth.identity(request);
    auth.limit(`bind-user:${user.id}`, 10);
    auth.limit(`bind-ip:${request.ip}`, 40);
    const timestamp = now().getTime();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT id FROM devices WHERE user_id = ?').get(user.id)) fail('该账号已经绑定杯垫', 409);
      const binding = db.prepare(`SELECT b.device_id AS deviceId FROM binding_codes b JOIN devices d ON d.id = b.device_id
        WHERE b.code_hash = ? AND b.expires_at > ? AND d.user_id IS NULL`).get(hash(request.body.code), timestamp) as { deviceId: string } | undefined;
      if (!binding) fail('绑定码无效或已过期，请在杯垫配网页刷新绑定码', 400);
      if (!online(binding.deviceId, timestamp)) fail('杯垫已离线，请等待重新连接后绑定', 409);
      db.prepare('UPDATE devices SET user_id = ? WHERE id = ? AND user_id IS NULL').run(user.id, binding.deviceId);
      db.prepare('DELETE FROM binding_codes WHERE device_id = ?').run(binding.deviceId);
      db.exec('COMMIT');
      return { deviceId: binding.deviceId };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  app.post<{ Body: { id: string } }>('/api/control/cup', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } } },
  }, async (request) => {
    const deviceId = auth.deviceId(request);
    const timestamp = now().getTime();
    const id = request.body.id.toLowerCase();
    expireCommands(deviceId, timestamp);
    const existing = db.prepare(`SELECT ${commandColumns} FROM device_commands WHERE id = ? AND device_id = ?`).get(id, deviceId);
    if (existing) return { command: existing };
    if (db.prepare('SELECT id FROM device_commands WHERE id = ?').get(id)) fail('操作不存在', 404);
    if (!online(deviceId, timestamp)) fail('杯垫已离线，请等待连接后再设置空杯', 409);
    if (db.prepare(`SELECT id FROM device_commands WHERE device_id = ? AND status = 'pending'`).get(deviceId)) fail('上一项空杯设置尚未完成，请稍后重试', 409);
    const expiresAt = timestamp + 30_000;
    db.prepare(`INSERT INTO device_commands (id, device_id, status, message, created_at, expires_at) VALUES (?, ?, 'pending', NULL, ?, ?)`)
      .run(id, deviceId, timestamp, expiresAt);
    return { command: { id, status: 'pending', message: null, expiresAt } };
  });
  app.get<{ Params: { id: string } }>('/api/control/commands/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } } },
  }, async (request) => {
    const deviceId = auth.deviceId(request);
    expireCommands(deviceId, now().getTime());
    const command = db.prepare(`SELECT ${commandColumns} FROM device_commands WHERE id = ? AND device_id = ?`).get(request.params.id.toLowerCase(), deviceId);
    if (!command) fail('操作不存在', 404);
    return { command };
  });



  app.post<{ Body: Heartbeat }>('/api/device/heartbeat', {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['weightGrams', 'stable', 'cupPresent', 'source', 'calibrated', 'emptyCupGrams',
          'pendingCount', 'timePendingCount', 'clockSynced', 'error', 'firmwareVersion'],
        properties: {
          weightGrams: { anyOf: [{ type: 'number', minimum: -2000, maximum: 4000 }, { type: 'null' }] },
          stable: { type: 'boolean' }, cupPresent: { type: 'boolean' },
          source: { const: 'hx711' }, calibrated: { type: 'boolean' },
          emptyCupGrams: { anyOf: [{ type: 'number', minimum: 5, maximum: 1995 }, { type: 'null' }] },
          pendingCount: { type: 'integer', minimum: 0, maximum: 4097 },
          timePendingCount: { type: 'integer', minimum: 0, maximum: 4096 },
          clockSynced: { type: 'boolean' },
          error: { anyOf: [{ type: 'string', minLength: 1, maxLength: 160 }, { type: 'null' }] },
          firmwareVersion: { type: 'string', minLength: 1, maxLength: 32 },
          commandResult: { type: 'object', additionalProperties: false, required: ['id', 'ok', 'message'], properties: {
            id: { type: 'string', pattern: uuidPattern }, ok: { type: 'boolean' }, message: { type: 'string', maxLength: 160 },
          } },
        },
      },
    },
  }, async (request, reply) => {
    const deviceId = auth.deviceId(request);
    const { commandResult, ...heartbeat } = request.body;
    if (heartbeat.timePendingCount > heartbeat.pendingCount
      || (!heartbeat.calibrated && (heartbeat.weightGrams !== null || heartbeat.stable))
      || (heartbeat.stable && heartbeat.weightGrams === null)) {
      return reply.code(400).send({ error: '设备状态不一致' });
    }
    const currentTime = now();
    saveDevice.run(deviceId, currentTime.toISOString(), JSON.stringify(heartbeat));
    const timestamp = currentTime.getTime();
    expireCommands(deviceId, timestamp);
    if (commandResult) {
      db.prepare(`UPDATE device_commands SET status = ?, message = ? WHERE id = ? AND device_id = ? AND status = 'pending' AND expires_at > ?`)
        .run(commandResult.ok ? 'succeeded' : 'failed', commandResult.message || null, commandResult.id.toLowerCase(), deviceId, timestamp);
    }
    const command = db.prepare(`SELECT id, expires_at AS expiresAt FROM device_commands WHERE device_id = ? AND status = 'pending'`).get(deviceId);
    const owner = db.prepare('SELECT user_id AS userId FROM devices WHERE id = ?').get(deviceId) as { userId: string | null };
    return { ok: true, serverTimeMs: timestamp, bound: owner.userId !== null, command: command ? { ...command, cmd: 'cup' } : null };
  });

  app.post<{ Body: { events: DeviceEvent[] } }>('/api/device/events', {
    schema: {
      body: {
        type: 'object', additionalProperties: false, required: ['events'],
        properties: {
          events: {
            type: 'array', minItems: 1, maxItems: 1000,
            items: {
              type: 'object', additionalProperties: false,
              required: ['id', 'kind', 'amountMl', 'beforeGrams', 'afterGrams', 'occurredAt'],
              properties: {
                id: { type: 'string', pattern: uuidPattern },
                kind: { enum: ['drink', 'refill'] },
                amountMl: { type: 'number', minimum: 5, maximum: 2000 },
                beforeGrams: { type: 'number', minimum: 0, maximum: 2000 },
                afterGrams: { type: 'number', minimum: 0, maximum: 2000 },
                occurredAt: { type: 'string', maxLength: 35 },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const deviceId = auth.deviceId(request);
    for (const event of request.body.events) {
      const difference = event.kind === 'drink'
        ? event.beforeGrams - event.afterGrams : event.afterGrams - event.beforeGrams;
      if (!isTimestamp(event.occurredAt) || difference < 5 || Math.abs(difference - event.amountMl) > 0.1) {
        return reply.code(400).send({ error: '事件时间或称重差值无效' });
      }
    }
    const events = request.body.events.map((event) => ({
      ...event, id: event.id.toLowerCase(), occurredAt: new Date(event.occurredAt).toISOString(),
    }));
    let inserted = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) {
        const existing = getEvent.get(deviceId, event.id) as unknown as EventRow | undefined;
        if (existing && !sameEvent(existing, event)) {
          db.exec('ROLLBACK');
          return reply.code(409).send({ error: '同一事件编号的内容不一致' });
        }
        if (!existing) {
          insertEvent.run(deviceId, event.id, event.kind, event.amountMl, event.beforeGrams, event.afterGrams, event.occurredAt);
          inserted += 1;
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { acknowledged: [...new Set(events.map((event) => event.id))], inserted };
  });

  app.post<{ Params: { id: string } }>('/api/events/:id/revoke', {
    schema: {
      params: {
        type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } },
      },
    },
  }, async (request, reply) => {
    const deviceId = auth.deviceId(request);
    const id = request.params.id.toLowerCase();
    if (!getEvent.get(deviceId, id)) return reply.code(404).send({ error: '记录不存在' });
    revokeEvent.run(now().toISOString(), deviceId, id);
    return { ok: true };
  });

  app.get<{ Querystring: { date?: string } }>('/api/dashboard', {
    schema: {
      querystring: {
        type: 'object', additionalProperties: false,
        properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
      },
    },
  }, async (request, reply) => {
    const deviceId = auth.deviceId(request);
    const date = request.query.date ?? localDate(now());
    if (!isDate(date)) return reply.code(400).send({ error: '日期无效' });
    const week = Array.from({ length: 7 }, (_, index) => ({ date: shiftDate(date, index - 6), drinkMl: 0 }));
    // 先按 UTC 扩大一天取数，再按配置时区分日，兼容时区偏移和夏令时。
    const rows = getEvents.all(deviceId, `${shiftDate(week[0].date, -1)}T00:00:00.000Z`,
      `${shiftDate(date, 2)}T00:00:00.000Z`) as unknown as EventRow[];
    const events: EventRow[] = [];
    const totals = { drinkMl: 0, refillMl: 0, drinkCount: 0 };
    for (const event of rows) {
      const eventDate = localDate(event.occurredAt);
      if (eventDate === date) events.push(event);
      if (event.revokedAt !== null) continue;
      if (event.kind === 'drink') {
        const day = week.find((item) => item.date === eventDate);
        if (day) day.drinkMl += event.amountMl;
      }
      if (eventDate === date) {
        if (event.kind === 'drink') { totals.drinkMl += event.amountMl; totals.drinkCount += 1; }
        else totals.refillMl += event.amountMl;
      }
    }
    const row = getDevice.get(deviceId) as unknown as DeviceRow | undefined;
    const status = row ? JSON.parse(row.payload) as Heartbeat : undefined;
    const age = row ? now().getTime() - Date.parse(row.lastSeenAt) : Infinity;
    return {
      date, timeZone, totals, week, events,
      device: {
        id: deviceId, lastSeenAt: row?.lastSeenAt ?? null,
        online: age >= 0 && age <= 15_000, weightGrams: status?.weightGrams ?? null,
        stable: status?.stable ?? false, cupPresent: status?.cupPresent ?? false, source: 'hx711',
        calibrated: status?.calibrated ?? false, emptyCupGrams: status?.emptyCupGrams ?? null,
        pendingCount: status?.pendingCount ?? 0, timePendingCount: status?.timePendingCount ?? 0,
        clockSynced: status?.clockSynced ?? false, error: status?.error ?? null,
        firmwareVersion: status?.firmwareVersion ?? null,
      },
    };
  });

  return app;
}
