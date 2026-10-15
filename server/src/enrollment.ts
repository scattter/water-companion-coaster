import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { authRoutes, fail } from './auth.js';
import { bindOwnership, ownership } from './bindings.js';
import { hash, provisionDevice, transaction } from './db.js';
import { authorizationLifetimeMs, type ProvisioningSigner } from './signing.js';
import { hexSchema, idParams, uuidSchema, validateServerOrigin } from './validation.js';

interface Operation {
  id: string; hardwareId: string; deviceId: string | null; userId: string; ticketHash: string;
  status: 'issued' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'expired';
  bindingId: string | null; credential: string | null; expiresAt: number; code: string | null; message: string | null;
}
const columns = `id, hardware_id AS hardwareId, device_id AS deviceId, user_id AS userId, ticket_hash AS ticketHash,
  status, binding_id AS bindingId, credential, expires_at AS expiresAt, code, message`;
interface Ticket { operationId: string; hardwareId: string; ticket: string; deviceId?: string; identityProof?: string }
const hardwareSchema = { type: 'string', pattern: '^[a-f0-9]{12}$', minLength: 12, maxLength: 12 };
const deviceSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', maxLength: 64 };
const ticketSchema = { type: 'object', additionalProperties: false, required: ['operationId', 'hardwareId', 'ticket'],
  properties: { operationId: uuidSchema, hardwareId: hardwareSchema, ticket: hexSchema, deviceId: deviceSchema, identityProof: hexSchema } };

// Only a device holding the accepted ticket can recover a lost credential reply.
// The database stores the ticket hash and encrypted credential, never their plaintext pair.
function seal(token: string, ticket: string, operationId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(ticket, 'hex'), iv);
  cipher.setAAD(Buffer.from(operationId));
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('hex');
}
function unseal(value: string, ticket: string, operationId: string) {
  const data = Buffer.from(value, 'hex');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(ticket, 'hex'), data.subarray(0, 12));
  cipher.setAAD(Buffer.from(operationId));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
}

export function enrollmentRoutes(app: FastifyInstance, db: DatabaseSync, auth: ReturnType<typeof authRoutes>,
  signer: ProvisioningSigner, now: () => Date, options: { allowLocalHttp?: boolean; serverUrl?: string }) {
  function get(id: string): Operation {
    const row = db.prepare(`SELECT ${columns} FROM enrollment_operations WHERE id = ?`).get(id.toLowerCase()) as unknown as Operation | undefined;
    if (!row) fail('配网操作不存在', 404, 'OPERATION_NOT_FOUND');
    return row;
  }
  function refresh(row: Operation) {
    if (row.status === 'issued' && row.expiresAt <= now().getTime()) {
      db.prepare("UPDATE enrollment_operations SET status = 'expired', credential = NULL, code = 'OPERATION_EXPIRED', message = '本次配网已过期' WHERE id = ?").run(row.id);
    } else if ((row.status === 'claimed' || row.status === 'completed') && row.deviceId
      && ownership(db, row.deviceId).bindingId !== row.bindingId) {
      db.prepare("UPDATE enrollment_operations SET status = 'cancelled', credential = NULL, code = 'BINDING_ENDED', message = '绑定已结束' WHERE id = ?").run(row.id);
    }
    return get(row.id);
  }
  function active(row: Operation) {
    if (['failed', 'cancelled', 'expired'].includes(row.status)) fail(row.message ?? '配网操作已失效', 409, row.code ?? 'OPERATION_CANCELLED');
  }
  function status(row: Operation) {
    return { operationId: row.id, hardwareId: row.hardwareId, deviceId: row.deviceId, bindingId: row.bindingId,
      status: row.status, ...(row.code ? { code: row.code, message: row.message } : {}) };
  }
  function checkTicket(body: Ticket) {
    const row = get(body.operationId);
    if (row.hardwareId !== body.hardwareId || !timingSafeEqual(Buffer.from(hash(body.ticket)), Buffer.from(row.ticketHash))) {
      fail('配网凭证无效', 403, 'INVALID_TICKET');
    }
    return refresh(row);
  }
  function receipt(row: Operation, ticket: string) {
    return { ...status(row), serverTimeMs: now().getTime(),
      ...(row.status === 'claimed' && row.credential ? { token: unseal(row.credential, ticket, row.id) } : {}) };
  }
  function checkOwner(deviceId: string | null, userId: string) {
    if (deviceId) {
      const device = ownership(db, deviceId);
      if (device.userId && device.userId !== userId) fail('设备已绑定其他账号，请由原账号解绑', 409, 'DEVICE_ALREADY_BOUND');
    }
    if (db.prepare('SELECT id FROM devices WHERE user_id = ? AND (? IS NULL OR id <> ?)').get(userId, deviceId, deviceId)) {
      fail('该账号已经绑定杯垫', 409, 'USER_ALREADY_BOUND');
    }
  }
  function deviceCredential(body: Ticket, deviceId: string) {
    const row = db.prepare('SELECT token_hash AS tokenHash FROM devices WHERE id = ?').get(deviceId) as { tokenHash: string };
    const proof = createHmac('sha256', Buffer.from(row.tokenHash, 'hex'))
      .update(`${body.operationId.toLowerCase()}\n${body.hardwareId}\n${body.ticket}`).digest('hex');
    if (body.deviceId !== deviceId || !body.identityProof
      || !timingSafeEqual(Buffer.from(body.identityProof), Buffer.from(proof))) {
      fail('设备身份校验未通过，请重新连接原设备', 403, 'DEVICE_AUTH_FAILED');
    }
  }

  app.post<{ Body: { hardwareId: string; deviceId: string | null; challenge: string } }>('/api/enrollment/operations', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['hardwareId', 'deviceId', 'challenge'], properties: {
      hardwareId: hardwareSchema, deviceId: { anyOf: [deviceSchema, { type: 'null' }] }, challenge: hexSchema,
    },
  } } }, async (request) => {
    const user = auth.identity(request);
    auth.limit(`enroll-user:${user.id}`, 20);
    auth.limit(`enroll-hardware:${request.body.hardwareId}`, 30);
    let serverUrl: string;
    try { serverUrl = validateServerOrigin(signer.settings().serverUrl || options.serverUrl || '', options.allowLocalHttp); }
    catch { fail('尚未配置设备可访问的服务地址，请设置 APP_ORIGIN；本地开发可使用局域网 HTTP 地址', 503, 'SERVER_URL_NOT_CONFIGURED'); }
    return transaction(db, () => {
      const known = db.prepare('SELECT id FROM devices WHERE hardware_id = ?').get(request.body.hardwareId) as { id: string } | undefined;
      if (known && request.body.deviceId && known.id !== request.body.deviceId) fail('设备身份不一致', 409, 'DEVICE_MISMATCH');
      const registered = request.body.deviceId ? db.prepare('SELECT hardware_id AS hardwareId FROM devices WHERE id = ?')
        .get(request.body.deviceId) as { hardwareId: string | null } | undefined : undefined;
      if (registered?.hardwareId && registered.hardwareId !== request.body.hardwareId) fail('设备身份不一致', 409, 'DEVICE_MISMATCH');
      const deviceId = known?.id ?? (registered ? request.body.deviceId : null);
      checkOwner(deviceId, user.id);
      if (db.prepare('SELECT id FROM enrollment_operations WHERE hardware_id = ? AND challenge = ?').get(request.body.hardwareId, request.body.challenge)) {
        fail('此配网会话已使用，请重新连接杯垫', 409, 'CHALLENGE_REUSED');
      }
      const operationId = randomUUID(), ticket = randomBytes(32).toString('hex');
      const expiresAt = now().getTime() + authorizationLifetimeMs;
      db.prepare(`INSERT INTO enrollment_operations (id, hardware_id, device_id, user_id, challenge, server_url, ticket_hash, created_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued')`).run(operationId, request.body.hardwareId, deviceId, user.id,
        request.body.challenge, serverUrl, hash(ticket), now().getTime(), expiresAt);
      return { operationId, hardwareId: request.body.hardwareId, deviceId, serverUrl, ticket, expiresAt };
    });
  });
  app.get<{ Params: { id: string } }>('/api/enrollment/operations/:id', { schema: { params: idParams } }, async (request) => {
    const row = get(request.params.id);
    if (row.userId !== auth.identity(request).id) fail('配网操作不存在', 404, 'OPERATION_NOT_FOUND');
    return status(refresh(row));
  });
  app.post<{ Body: Ticket }>('/api/enrollment/claim', { schema: { body: ticketSchema } }, async (request) => {
    const found = checkTicket(request.body);
    auth.limit(`enroll-claim:${found.hardwareId}`, 60);
    return transaction(db, () => {
      const row = get(found.id);
      active(row);
      if (row.status !== 'issued') return receipt(row, request.body.ticket);
      const known = db.prepare('SELECT id FROM devices WHERE hardware_id = ?').get(row.hardwareId) as { id: string } | undefined;
      const existingId = known?.id ?? row.deviceId;
      checkOwner(existingId, row.userId);
      // An existing identity must prove its credential. After a normal reset,
      // hardware lookup still enforces the old account's ownership before recovery.
      const hasCredential = !!existingId && !!(request.body.deviceId || request.body.identityProof);
      if (hasCredential) deviceCredential(request.body, existingId!);
      else if (existingId && !known) fail('旧设备需要验证已有身份', 403, 'DEVICE_AUTH_FAILED');
      let deviceId = existingId;
      // Reprovisioning keeps a proven credential valid even if it is interrupted.
      // Only first registration or recovery after lost identity issues a new one.
      const token = hasCredential ? null : randomBytes(32).toString('hex');
      if (!deviceId) {
        do { deviceId = `coaster-${String(randomInt(1, 1_000_000)).padStart(6, '0')}`; }
        while (db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId));
        provisionDevice(db, deviceId, token!, now().getTime());
      }
      db.prepare('UPDATE devices SET hardware_id = ?, provisioning_version = 1 WHERE id = ?').run(row.hardwareId, deviceId);
      if (token) db.prepare('UPDATE devices SET token_hash = ? WHERE id = ?').run(hash(token), deviceId);
      const bindingId = bindOwnership(db, deviceId, row.userId, now().getTime(), true);
      db.prepare("UPDATE enrollment_operations SET device_id = ?, binding_id = ?, credential = ?, status = 'claimed' WHERE id = ?")
        .run(deviceId, bindingId, token ? seal(token, request.body.ticket, row.id) : null, row.id);
      db.prepare(`UPDATE enrollment_operations SET status = 'cancelled', credential = NULL, code = 'OPERATION_CANCELLED', message = '设备已完成另一配网操作'
        WHERE hardware_id = ? AND id <> ? AND status IN ('issued', 'claimed')`).run(row.hardwareId, row.id);
      return receipt(get(row.id), request.body.ticket);
    });
  });
  app.post<{ Body: Ticket }>('/api/enrollment/query', { schema: { body: ticketSchema } }, async (request) => receipt(checkTicket(request.body), request.body.ticket));
  app.post<{ Body: { operationId: string; bindingId: string } }>('/api/device/enrollment/complete', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['operationId', 'bindingId'], properties: { operationId: uuidSchema, bindingId: uuidSchema },
  } } }, async (request) => transaction(db, () => {
    const row = refresh(get(request.body.operationId));
    if (row.deviceId !== auth.deviceId(request)) fail('配网操作不存在', 404, 'OPERATION_NOT_FOUND');
    active(row);
    if (row.status === 'issued') fail('设备尚未认领', 409, 'OPERATION_NOT_CLAIMED');
    if (row.bindingId !== request.body.bindingId.toLowerCase()) fail('绑定批次不匹配', 409, 'BINDING_MISMATCH');
    db.prepare("UPDATE enrollment_operations SET status = 'completed', credential = NULL WHERE id = ?").run(row.id);
    return { ok: true, status: 'completed' };
  }));
}
