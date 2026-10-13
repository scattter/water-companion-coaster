import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Fastify, { type FastifyError, type FastifyServerOptions } from 'fastify';
import { DeviceSetup, SetupError, setupRoutes } from './setup.js';
import { DeviceControl, controlRoutes } from './control.js';

export interface AppOptions {
  deviceToken: string;
  deviceId?: string;
  dbPath?: string;
  timeZone?: string;
  now?: () => Date;
  allowedOrigins?: string[];
  logger?: FastifyServerOptions['logger'];
  setup?: DeviceSetup;
  controlFetch?: typeof fetch;
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
}

interface DeviceRow {
  lastSeenAt: string;
  payload: string;
}

const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const dayMs = 86_400_000;
const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const defaultOrigins = ['localhost', '127.0.0.1', '[::1]']
  .flatMap((host) => [3001, 5173].map((port) => `http://${host}:${port}`));

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
  if (!options.deviceToken?.trim()) throw new Error('必须显式设置 DEVICE_TOKEN');
  const deviceId = options.deviceId ?? 'coaster-01';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deviceId)) throw new Error('DEVICE_ID 格式无效');
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
  const control = new DeviceControl({ deviceId, deviceToken: options.deviceToken, now, fetch: options.controlFetch });
  const dbPath = options.dbPath ?? resolve('data/coaster-hardware.sqlite');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS device_events (
      device_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('drink', 'refill')),
      amount_ml REAL NOT NULL,
      before_grams REAL NOT NULL,
      after_grams REAL NOT NULL,
      occurred_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY (device_id, id)
    );
    CREATE INDEX IF NOT EXISTS device_events_occurred_at ON device_events(device_id, occurred_at);
    CREATE TABLE IF NOT EXISTS device_status (
      id TEXT PRIMARY KEY,
      last_seen_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
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
    bodyLimit: 512 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const allowedOrigins = new Set(options.allowedOrigins ?? defaultOrigins);
  const token = Buffer.from(`Bearer ${options.deviceToken}`);

  app.addHook('onClose', async () => { db.close(); });
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.url?.startsWith('/api/device/')) {
      // 设备经局域网上报；浏览器页面不能利用此入口绕过本机访问限制。
      if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] === 'cross-site') {
        return reply.code(403).send({ error: '设备接口不接受浏览器跨域请求' });
      }
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== token.length || !timingSafeEqual(supplied, token)
        || request.headers['x-device-id'] !== deviceId) {
        return reply.code(401).send({ error: '设备编号或凭证无效' });
      }
      return;
    }
    if (!localAddresses.has(request.ip) || !localHost.test(request.headers.host ?? '')
      || (request.headers.origin !== undefined && !allowedOrigins.has(request.headers.origin))
      || request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: '网页接口仅允许本机访问' });
    }
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    if (error instanceof SetupError) return reply.code(error.statusCode).send({ error: error.message });
    if (error.validation || error.statusCode === 400) {
      return reply.code(400).send({ error: '请求参数无效' });
    }
    if (error.statusCode === 415) return reply.code(415).send({ error: '请使用 JSON 请求' });
    request.log.error(error);
    return reply.code(500).send({ error: '服务暂时不可用' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '接口不存在' }));

  app.get('/api/health', async () => ({ ok: true }));
  if (options.setup) setupRoutes(app, options.setup);
  controlRoutes(app, control);

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
        },
      },
    },
  }, async (request, reply) => {
    const heartbeat = request.body;
    if (heartbeat.timePendingCount > heartbeat.pendingCount
      || (!heartbeat.calibrated && (heartbeat.weightGrams !== null || heartbeat.stable))
      || (heartbeat.stable && heartbeat.weightGrams === null)) {
      return reply.code(400).send({ error: '设备状态不一致' });
    }
    const currentTime = now();
    saveDevice.run(deviceId, currentTime.toISOString(), JSON.stringify(heartbeat));
    control.seen(request.ip);
    return { ok: true, serverTimeMs: currentTime.getTime() };
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
