import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { authRoutes, fail } from './auth.js';
import { bindOwnership, endOwnership, ownership } from './bindings.js';
import { hash, transaction } from './db.js';
import { importRegistryRecords, validateProvisionRegistry } from './provision-registry.js';
import { authorizationLifetimeMs, type ProvisioningSigner } from './signing.js';
import { emptyBody, hexSchema, idParams, uuidSchema, validateServerOrigin } from './validation.js';

interface Operation {
  id: string; deviceId: string; userId: string; status: 'issued' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'expired';
  bindingId: string | null; ticketHash: string; expiresAt: number; code: string | null; message: string | null;
}
const operationColumns = `id, device_id AS deviceId, user_id AS userId, status, binding_id AS bindingId,
  ticket_hash AS ticketHash, expires_at AS expiresAt, code, message`;

export function provisioningRoutes(app: FastifyInstance, db: DatabaseSync, auth: ReturnType<typeof authRoutes>, signer: ProvisioningSigner, now: () => Date) {
  const deviceIdSchema = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
  const registryIdSchema = { type: 'string', minLength: 14, maxLength: 14, pattern: '^coaster-(?!000000)[0-9]{6}$' };
  const registrySchema = { type: 'object', additionalProperties: false, required: ['version', 'devices'], properties: {
    version: { const: 1 }, devices: { type: 'array', minItems: 1, maxItems: 1000, items: {
      type: 'object', additionalProperties: false, required: ['id', 'tokenHash', 'createdAt'], properties: {
        id: registryIdSchema, tokenHash: hexSchema, createdAt: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    } },
  } };
  app.get('/api/admin/devices', { schema: { querystring: { type: 'object', additionalProperties: false } } }, async () => ({
    devices: db.prepare(`SELECT d.id, d.created_at AS createdAt, d.user_id IS NOT NULL AS bound, u.username
      FROM devices d LEFT JOIN users u ON u.id = d.user_id ORDER BY d.id`).all().map((row) => ({ ...row, bound: !!row.bound })),
  }));
  app.post<{ Body: { id: string; token: string } }>('/api/admin/devices', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['id', 'token'], properties: {
      id: registryIdSchema, token: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[!-~]+$' },
    },
  } } }, async (request) => importRegistryRecords(db, { version: 1, devices: [{ id: request.body.id, tokenHash: hash(request.body.token), createdAt: now().getTime() }] }));
  app.post('/api/admin/devices/import', { schema: { body: registrySchema } }, async (request) => {
    let registry;
    try { registry = validateProvisionRegistry(request.body); }
    catch (error) { fail((error as Error).message, 400, 'INVALID_REGISTRY'); }
    return importRegistryRecords(db, registry);
  });
  app.get('/api/admin/settings', { schema: { querystring: { type: 'object', additionalProperties: false } } }, async () => signer.settings());
  app.post<{ Body: { serverUrl: string } }>('/api/admin/settings', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['serverUrl'], properties: { serverUrl: { type: 'string', minLength: 1, maxLength: 191 } },
  } } }, async (request) => {
    let serverUrl: string;
    try { serverUrl = validateServerOrigin(request.body.serverUrl); }
    catch { fail('服务器地址必须是 HTTPS origin，最多191字节，无路径、凭据、查询或片段', 400, 'INVALID_SERVER_URL'); }
    transaction(db, () => {
      if (signer.settings().serverUrl !== serverUrl) {
        db.prepare('UPDATE settings SET server_url = ?, config_version = config_version + 1 WHERE singleton = 1').run(serverUrl);
        db.prepare(`UPDATE provisioning_operations SET status = 'cancelled', code = 'CONFIG_CHANGED', message = '服务器配置已更新，请重新配网'
          WHERE status = 'issued'`).run();
      }
    });
    return signer.settings();
  });

  function operation(id: string): Operation {
    const row = db.prepare(`SELECT ${operationColumns} FROM provisioning_operations WHERE id = ?`).get(id.toLowerCase()) as unknown as Operation | undefined;
    if (!row) fail('配网操作不存在', 404, 'OPERATION_NOT_FOUND');
    return row;
  }
  function refresh(row: Operation): Operation {
    if (row.status === 'issued' && row.expiresAt <= now().getTime()) {
      db.prepare("UPDATE provisioning_operations SET status = 'expired', code = 'OPERATION_EXPIRED', message = '配网授权已过期' WHERE id = ? AND status = 'issued'").run(row.id);
    } else if ((row.status === 'claimed' || row.status === 'completed') && ownership(db, row.deviceId).bindingId !== row.bindingId) {
      db.prepare("UPDATE provisioning_operations SET status = 'cancelled', code = 'BINDING_ENDED', message = '绑定已结束' WHERE id = ?").run(row.id);
    }
    return operation(row.id);
  }
  function receipt(row: Operation) {
    return { operationId: row.id, bindingId: row.bindingId, status: row.status, serverTimeMs: now().getTime(),
      ...(row.code ? { code: row.code, message: row.message } : {}) };
  }
  function userStatus(row: Operation) {
    return { operationId: row.id, deviceId: row.deviceId, status: row.status, bindingId: row.bindingId,
      ...(row.code ? { code: row.code, message: row.message } : {}) };
  }
  function requireActive(row: Operation) {
    if (['failed', 'cancelled', 'expired'].includes(row.status)) fail(row.message ?? '配网操作已失效', 409, row.code ?? 'OPERATION_CANCELLED');
  }

  app.post<{ Body: { deviceId: string; deploymentId: string; challenge: string } }>('/api/provisioning/operations', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['deviceId', 'deploymentId', 'challenge'],
    properties: { deviceId: deviceIdSchema, deploymentId: uuidSchema, challenge: hexSchema },
  } } }, async (request) => {
    const user = auth.identity(request);
    auth.limit(`provision-user:${user.id}`, 20);
    auth.limit(`provision-device:${request.body.deviceId}`, 30);
    return transaction(db, () => {
      const config = signer.settings();
      if (!config.signingReady) fail('配网签名尚未配置，请联系管理员', 503, 'SIGNING_NOT_READY');
      if (request.body.deploymentId.toLowerCase() !== config.deploymentId) fail('设备信任的部署与此服务器不符', 409, 'DEPLOYMENT_MISMATCH');
      const device = ownership(db, request.body.deviceId);
      if (device.userId && device.userId !== user.id) fail('设备已绑定其他账号', 409, 'DEVICE_ALREADY_BOUND');
      if (user.deviceId && user.deviceId !== device.id) fail('该账号已经绑定杯垫', 409, 'USER_ALREADY_BOUND');
      if (db.prepare('SELECT id FROM provisioning_operations WHERE device_id = ? AND challenge = ?').get(device.id, request.body.challenge)) {
        fail('此配网挑战已使用，请在设备开启新的配网会话', 409, 'CHALLENGE_REUSED');
      }
      const operationId = randomUUID();
      const ticket = randomBytes(32).toString('hex');
      const timestamp = now().getTime();
      const expiresAt = timestamp + authorizationLifetimeMs;
      const authorization = signer.authorize({ deviceId: device.id, challenge: request.body.challenge, operationId, expiresAt, ticket });
      db.prepare(`INSERT INTO provisioning_operations (id, device_id, user_id, deployment_id, challenge, server_url, config_version,
        ticket_hash, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued')`)
        .run(operationId, device.id, user.id, config.deploymentId, request.body.challenge, config.serverUrl, config.configVersion, hash(ticket), timestamp, expiresAt);
      return { operationId, serverUrl: config.serverUrl, expiresAt, authorization };
    });
  });
  app.get<{ Params: { id: string } }>('/api/provisioning/operations/:id', { schema: { params: idParams } }, async (request) => {
    const row = operation(request.params.id);
    if (row.userId !== auth.identity(request).id) fail('配网操作不存在', 404, 'OPERATION_NOT_FOUND');
    return userStatus(refresh(row));
  });
  app.get<{ Params: { id: string } }>('/api/device/provisioning/operations/:id', { schema: { params: idParams } }, async (request) => {
    const row = operation(request.params.id);
    if (row.deviceId !== auth.deviceId(request)) fail('配网操作不存在', 404, 'OPERATION_NOT_FOUND');
    return receipt(refresh(row));
  });
  app.post<{ Body: { operationId: string; ticket: string } }>('/api/device/provisioning/claim', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['operationId', 'ticket'], properties: { operationId: uuidSchema, ticket: hexSchema },
  } } }, async (request) => {
    const deviceId = auth.deviceId(request);
    auth.limit(`claim:${deviceId}`, 60);
    // Expiry is durably recorded before the claim transaction. A rejected claim
    // must not roll the terminal state back to 'issued'.
    const found = operation(request.body.operationId);
    if (found.deviceId !== deviceId) fail('配网操作不存在', 404, 'OPERATION_NOT_FOUND');
    if (!timingSafeEqual(Buffer.from(hash(request.body.ticket)), Buffer.from(found.ticketHash))) fail('配网票据无效', 403, 'INVALID_TICKET');
    refresh(found);
    const result = transaction(db, () => {
      const row = operation(found.id);
      requireActive(row);
      if (row.status === 'claimed' || row.status === 'completed') return { row };
      const device = ownership(db, deviceId);
      let conflict: string | undefined;
      if (device.userId && device.userId !== row.userId) conflict = 'DEVICE_ALREADY_BOUND';
      if (db.prepare('SELECT id FROM devices WHERE user_id = ? AND id <> ?').get(row.userId, deviceId)) conflict = 'USER_ALREADY_BOUND';
      if (conflict) {
        db.prepare("UPDATE provisioning_operations SET status = 'failed', code = ?, message = '账号或设备归属已变更' WHERE id = ?").run(conflict, row.id);
        return { row: operation(row.id), conflict };
      }
      const bindingId = bindOwnership(db, deviceId, row.userId, now().getTime(), true);
      db.prepare('UPDATE devices SET provisioning_version = 1 WHERE id = ?').run(deviceId);
      db.prepare("UPDATE provisioning_operations SET status = 'claimed', binding_id = ? WHERE id = ?").run(bindingId, row.id);
      // Competing users cannot keep live tickets after a successful ownership
      // transaction. Same-owner retry/reconfiguration operations remain valid.
      db.prepare(`UPDATE provisioning_operations SET status = 'cancelled', code = 'DEVICE_ALREADY_BOUND', message = '设备已被其他账号绑定'
        WHERE device_id = ? AND user_id <> ? AND status = 'issued'`).run(deviceId, row.userId);
      return { row: operation(row.id) };
    });
    if (result.conflict) fail(result.row.message!, 409, result.conflict);
    return receipt(result.row);
  });
  app.post<{ Body: { operationId: string; bindingId: string } }>('/api/device/provisioning/complete', { schema: { body: {
    type: 'object', additionalProperties: false, required: ['operationId', 'bindingId'], properties: { operationId: uuidSchema, bindingId: uuidSchema },
  } } }, async (request) => {
    const row = operation(request.body.operationId);
    if (row.deviceId !== auth.deviceId(request)) fail('配网操作不存在', 404, 'OPERATION_NOT_FOUND');
    refresh(row);
    return transaction(db, () => {
      const current = operation(row.id);
      requireActive(current);
      if (current.status === 'issued') fail('配网尚未认领', 409, 'OPERATION_NOT_CLAIMED');
      if (current.bindingId !== request.body.bindingId.toLowerCase()) fail('绑定批次不匹配', 409, 'BINDING_MISMATCH');
      db.prepare("UPDATE provisioning_operations SET status = 'completed' WHERE id = ?").run(current.id);
      return { ok: true, status: 'completed' };
    });
  });
  app.post('/api/devices/unbind', { schema: emptyBody }, async (request) => {
    const user = auth.identity(request);
    if (!user.deviceId) fail('没有当前绑定', 409, 'NO_BINDING');
    transaction(db, () => endOwnership(db, user.deviceId!, user.id, now().getTime()));
    return { ok: true };
  });
}
