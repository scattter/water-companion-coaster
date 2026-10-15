import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import Fastify, { LogController, type FastifyError, type FastifyServerOptions } from 'fastify';
import { openDatabase, provisionDevice, hash, transaction } from './db.js';
import { authRoutes, fail } from './auth.js';
import { bindOwnership, eventBinding, heartbeatBinding, ownership } from './bindings.js';
import { provisioningSigner } from './signing.js';
import { provisioningRoutes } from './provisioning.js';
import { enrollmentRoutes } from './enrollment.js';
import { bindingSchema, emptyBody, idParams, uuidPattern, uuidSchema } from './validation.js';

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
  signingKeyPath?: string;
  deploymentId?: string;
  serverUrl?: string;
  allowLocalHttp?: boolean;
}

interface DeviceEvent {
  id: string;
  kind: 'drink' | 'refill';
  amountMl: number;
  beforeGrams: number;
  afterGrams: number;
  occurredAt: string;
  bindingId?: string | null;
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
  bindingId?: string | null;
  provisioningVersion?: 1;
  commandResult?: { id: string; ok: boolean; message: string; bindingId?: string | null };
}

interface DeviceRow {
  lastSeenAt: string;
  payload: string;
  bindingId: string | null;
}

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
    && existing.occurredAt === event.occurredAt && existing.bindingId === event.bindingId;
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
  let signer: ReturnType<typeof provisioningSigner>;
  try { signer = provisioningSigner(db, options); } catch (error) { db.close(); throw error; }
  const eventColumns = `e.id, e.kind, e.amount_ml AS amountMl, e.before_grams AS beforeGrams,
    e.after_grams AS afterGrams, e.occurred_at AS occurredAt, e.revoked_at AS revokedAt, e.binding_id AS bindingId`;
  const getEvent = db.prepare(`SELECT ${eventColumns} FROM device_events e WHERE e.device_id = ? AND e.id = ?`);
  const insertEvent = db.prepare(`INSERT INTO device_events
    (device_id, id, kind, amount_ml, before_grams, after_grams, occurred_at, binding_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const getEvents = db.prepare(`SELECT ${eventColumns} FROM device_events e JOIN device_bindings b ON b.id = e.binding_id
    WHERE b.user_id = ? AND e.occurred_at >= ? AND e.occurred_at < ? ORDER BY e.occurred_at DESC, e.id DESC`);
  const getDevice = db.prepare('SELECT last_seen_at AS lastSeenAt, payload, binding_id AS bindingId FROM device_status WHERE id = ?');
  const saveDevice = db.prepare(`INSERT INTO device_status (id, last_seen_at, payload, binding_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at, payload = excluded.payload, binding_id = excluded.binding_id`);

  const app = Fastify({
    logger: options.logger ?? false,
    // Request URLs can contain accidentally pasted credentials. Keep operational
    // errors, but never emit Fastify's automatic full-request URL logs.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: options.trustProxy ?? false,
    bodyLimit: 512 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  app.addHook('onClose', async () => { db.close(); });
  const auth = authRoutes(app, db, {
    now, allowedOrigins: options.allowedOrigins ?? (options.appOrigin ? [new URL(options.appOrigin).origin] : defaultOrigins),
    secureCookie: options.appOrigin?.startsWith('https://') ?? false,
  });
  provisioningRoutes(app, db, auth, signer, now, options.allowLocalHttp, options.serverUrl ?? options.appOrigin);
  enrollmentRoutes(app, db, auth, signer, now, { allowLocalHttp: options.allowLocalHttp, serverUrl: options.serverUrl ?? options.appOrigin });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error.validation || error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return reply.code(400).send({ error: '请求参数无效', code: 'INVALID_REQUEST' });
    }
    if (error.statusCode === 415) return reply.code(415).send({ error: '请使用 JSON 请求', code: 'JSON_REQUIRED' });
    if (error.statusCode && (error.statusCode >= 400 && error.statusCode < 500 || error.statusCode === 503)) return reply.code(error.statusCode).send({ error: error.message, code: error.code ?? 'REQUEST_FAILED' });
    // Never log request bodies or raw exception text that could contain secrets.
    request.log.error({ code: 'INTERNAL_ERROR' }, 'Request failed');
    return reply.code(500).send({ error: '服务暂时不可用', code: 'INTERNAL_ERROR' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '接口不存在' }));

  app.get('/api/health', async () => ({ ok: true }));
  function online(deviceId: string, timestamp: number) {
    const row = db.prepare('SELECT last_seen_at AS lastSeenAt FROM devices WHERE id = ?').get(deviceId) as { lastSeenAt: string | null };
    const age = row.lastSeenAt ? timestamp - Date.parse(row.lastSeenAt) : Infinity;
    return age >= 0 && age <= 15_000;
  }
  function expireCommands(deviceId: string, timestamp: number) {
    db.prepare(`UPDATE device_commands SET status = 'expired', message = '操作已过期，未在有效期内收到设备确认' WHERE device_id = ? AND status = 'pending' AND expires_at <= ?`)
      .run(deviceId, timestamp);
  }
  const commandColumns = 'id, status, message, expires_at AS expiresAt, binding_id AS bindingId';
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
    return transaction(db, () => {
      const binding = db.prepare(`SELECT b.device_id AS deviceId FROM binding_codes b JOIN devices d ON d.id = b.device_id
        WHERE b.code_hash = ? AND b.expires_at > ? AND d.user_id IS NULL`).get(hash(request.body.code), timestamp) as { deviceId: string } | undefined;
      if (!binding) fail('绑定码无效或已过期，请在杯垫配网页刷新绑定码', 400, 'INVALID_BINDING_CODE');
      if (!online(binding.deviceId, timestamp)) fail('杯垫已离线，请等待重新连接后绑定', 409, 'DEVICE_OFFLINE');
      const row = getDevice.get(binding.deviceId) as unknown as DeviceRow | undefined;
      const current = row ? JSON.parse(row.payload) as Heartbeat : undefined;
      const bindingId = bindOwnership(db, binding.deviceId, user.id, timestamp, current?.provisioningVersion === 1);
      return { deviceId: binding.deviceId, bindingId };
    });
  });
  app.post<{ Body: { id: string } }>('/api/control/cup', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } } },
  }, async (request) => {
    const deviceId = auth.deviceId(request);
    const timestamp = now().getTime();
    const id = request.body.id.toLowerCase();
    expireCommands(deviceId, timestamp);
    const bindingId = auth.identity(request).bindingId!;
    const existing = db.prepare(`SELECT ${commandColumns} FROM device_commands WHERE id = ? AND device_id = ? AND binding_id = ?`).get(id, deviceId, bindingId);
    if (existing) return { command: existing };
    if (db.prepare('SELECT id FROM device_commands WHERE id = ?').get(id)) fail('操作不存在', 404);
    const live = getDevice.get(deviceId) as unknown as DeviceRow | undefined;
    const statusAge = live ? timestamp - Date.parse(live.lastSeenAt) : Infinity;
    if (!live || live.bindingId !== bindingId || statusAge < 0 || statusAge > 15_000) fail('杯垫已离线，请等待连接后再设置空杯', 409, 'DEVICE_OFFLINE');
    if (db.prepare(`SELECT id FROM device_commands WHERE device_id = ? AND status = 'pending'`).get(deviceId)) fail('上一项空杯设置尚未完成，请稍后重试', 409);
    const expiresAt = timestamp + 30_000;
    db.prepare(`INSERT INTO device_commands (id, device_id, binding_id, status, message, created_at, expires_at) VALUES (?, ?, ?, 'pending', NULL, ?, ?)`)
      .run(id, deviceId, bindingId, timestamp, expiresAt);
    return { command: { id, status: 'pending', message: null, expiresAt, bindingId } };
  });
  app.get<{ Params: { id: string } }>('/api/control/commands/:id', {
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: uuidPattern } } } },
  }, async (request) => {
    const deviceId = auth.deviceId(request);
    expireCommands(deviceId, now().getTime());
    const command = db.prepare(`SELECT ${commandColumns} FROM device_commands WHERE id = ? AND device_id = ? AND binding_id = ?`).get(request.params.id.toLowerCase(), deviceId, auth.identity(request).bindingId);
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
          bindingId: bindingSchema, provisioningVersion: { const: 1 },
          commandResult: { type: 'object', additionalProperties: false, required: ['id', 'ok', 'message'], properties: {
            id: uuidSchema, ok: { type: 'boolean' }, message: { type: 'string', maxLength: 160 }, bindingId: bindingSchema,
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
    const timestamp = currentTime.getTime();
    // Upgraded firmware can retain an old receipt without a batch. Accept the
    // heartbeat so it can synchronize; only a matching receipt can confirm work.
    return transaction(db, () => {
      const device = ownership(db, deviceId);
      const bindingId = heartbeatBinding(device, heartbeat.bindingId);
      const matches = bindingId === device.bindingId;
      db.prepare('UPDATE devices SET last_seen_at = ?, provisioning_version = MAX(provisioning_version, ?) WHERE id = ?')
        .run(currentTime.toISOString(), heartbeat.provisioningVersion ?? 0, deviceId);
      if (matches) saveDevice.run(deviceId, currentTime.toISOString(), JSON.stringify(heartbeat), device.bindingId);
      expireCommands(deviceId, timestamp);
      const legacyAllowed = heartbeat.provisioningVersion === undefined && heartbeat.bindingId === undefined
        && device.bindingId !== null && device.bindingId === device.legacyBindingId;
      const versioned = heartbeat.provisioningVersion === 1 && typeof heartbeat.bindingId === 'string';
      const canCommand = matches && device.bindingId !== null && (legacyAllowed || versioned);
      if (commandResult && canCommand) {
        const resultBinding = commandResult.bindingId?.toLowerCase() ?? (legacyAllowed ? device.legacyBindingId : null);
        if (resultBinding === device.bindingId) db.prepare(`UPDATE device_commands SET status = ?, message = ?
          WHERE id = ? AND device_id = ? AND binding_id = ? AND status = 'pending' AND expires_at > ?`)
          .run(commandResult.ok ? 'succeeded' : 'failed', commandResult.message || null, commandResult.id.toLowerCase(), deviceId, resultBinding, timestamp);
      }
      const command = canCommand ? db.prepare(`SELECT id, expires_at AS expiresAt, binding_id AS bindingId FROM device_commands
        WHERE device_id = ? AND binding_id = ? AND status = 'pending'`).get(deviceId, device.bindingId) : undefined;
      return { ok: true, serverTimeMs: timestamp, bound: device.userId !== null, bindingId: device.bindingId, command: command ? { ...command, cmd: 'cup' } : null };
    });
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
                occurredAt: { type: 'string', maxLength: 35 }, bindingId: bindingSchema,
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
      const device = ownership(db, deviceId);
      for (const input of events) {
        const existing = getEvent.get(deviceId, input.id) as unknown as EventRow | undefined;
        // Upgraded V1 queues use explicit NULL, even for records already stored
        // under a migrated legacy batch. An identical retry acknowledges the
        // stored ownership; it never rewrites or reveals that ownership.
        const bindingId = input.bindingId == null && existing ? existing.bindingId ?? null : eventBinding(db, device, input.bindingId, input.occurredAt);
        const event = { ...input, bindingId };
        if (existing && !sameEvent(existing, event)) {
          db.exec('ROLLBACK');
          return reply.code(409).send({ error: '同一事件编号的内容不一致', code: 'EVENT_CONFLICT' });
        }
        if (!existing) {
          insertEvent.run(deviceId, event.id, event.kind, event.amountMl, event.beforeGrams, event.afterGrams, event.occurredAt, bindingId);
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
    schema: { params: idParams, ...emptyBody },
  }, async (request) => {
    const id = request.params.id.toLowerCase();
    const userId = auth.identity(request).id;
    const owned = db.prepare(`SELECT e.device_id AS deviceId FROM device_events e JOIN device_bindings b ON b.id = e.binding_id
      WHERE e.id = ? AND b.user_id = ?`).all(id, userId);
    if (!owned.length) fail('记录不存在', 404, 'EVENT_NOT_FOUND');
    transaction(db, () => {
      for (const row of owned) db.prepare('UPDATE device_events SET revoked_at = ? WHERE device_id = ? AND id = ? AND revoked_at IS NULL').run(now().toISOString(), row.deviceId, id);
    });
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
    const user = auth.identity(request);
    const deviceId = user.deviceId;
    const date = request.query.date ?? localDate(now());
    if (!isDate(date)) return reply.code(400).send({ error: '日期无效' });
    const week = Array.from({ length: 7 }, (_, index) => ({ date: shiftDate(date, index - 6), drinkMl: 0 }));
    // 先按 UTC 扩大一天取数，再按配置时区分日，兼容时区偏移和夏令时。
    const rows = getEvents.all(user.id, `${shiftDate(week[0].date, -1)}T00:00:00.000Z`,
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
    const stored = deviceId ? getDevice.get(deviceId) as unknown as DeviceRow | undefined : undefined;
    const row = stored?.bindingId === user.bindingId ? stored : undefined;
    const status = row ? JSON.parse(row.payload) as Heartbeat : undefined;
    const age = row ? now().getTime() - Date.parse(row.lastSeenAt) : Infinity;
    return {
      date, timeZone, totals, week, events,
      device: !deviceId ? null : {
        id: deviceId, bindingId: user.bindingId, lastSeenAt: row?.lastSeenAt ?? null,
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
