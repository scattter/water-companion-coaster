import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hash } from './db.js';

const deriveKey = promisify(scrypt);
const sessionMs = 30 * 86_400_000;
const cookieName = 'coaster_session';
export interface Identity { id: string; username: string; role: 'user' | 'admin'; deviceId: string | null; bindingId: string | null }
interface Account extends Identity { passwordHash: string; passwordSalt: string }
export function fail(message: string, statusCode: number, code?: string): never {
  const defaults: Record<number, string> = { 400: 'INVALID_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED', 503: 'UNAVAILABLE' };
  throw Object.assign(new Error(message), { statusCode, code: code ?? defaults[statusCode] ?? 'REQUEST_FAILED' });
}

export function authRoutes(app: FastifyInstance, db: DatabaseSync, options: {
  now: () => Date; allowedOrigins: string[]; secureCookie: boolean;
}) {
  const users = new WeakMap<FastifyRequest, Identity>();
  const devices = new WeakMap<FastifyRequest, string>();
  const attempts = new Map<string, { count: number; until: number }>();
  const allowedOrigins = new Set(options.allowedOrigins);
  const allowedHosts = new Set(options.allowedOrigins.flatMap((origin) => {
    const url = new URL(origin);
    return [url.host, `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`];
  }));
  const currentMs = () => options.now().getTime();
  function limit(key: string, max: number, windowMs = 15 * 60_000) {
    const now = currentMs();
    let value = attempts.get(key);
    if (!value || value.until <= now) {
      if (attempts.size >= 10_000) {
        for (const [name, entry] of attempts) if (entry.until <= now) attempts.delete(name);
        if (attempts.size >= 10_000) fail('请求过于频繁，请稍后重试', 429);
      }
      value = { count: 0, until: now + windowMs };
      attempts.set(key, value);
    }
    if (++value.count > max) fail('请求过于频繁，请稍后重试', 429);
  }
  const cookieToken = (request: FastifyRequest) => {
    const matches = (request.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName}=`));
    return matches.length === 1 ? matches[0].slice(cookieName.length + 1) : '';
  };
  const cookie = (token: string, age: number) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${options.secureCookie ? '; Secure' : ''}`;
  const findIdentity = db.prepare(`SELECT u.id, u.username, u.role, d.id AS deviceId, d.binding_id AS bindingId FROM sessions s
    JOIN users u ON u.id = s.user_id LEFT JOIN devices d ON d.user_id = u.id
    WHERE s.token_hash = ? AND s.expires_at > ?`);
  const response = (user?: Identity) => ({ user: user ? { id: user.id, username: user.username, role: user.role } : null, deviceId: user?.deviceId ?? null, bindingId: user?.bindingId ?? null });
  const identity = (request: FastifyRequest) => users.get(request)!;
  const deviceId = (request: FastifyRequest) => devices.get(request) ?? identity(request)?.deviceId!;

  app.addHook('onRequest', async (request, reply) => {
    const path = request.routeOptions.url ?? request.url.split('?')[0];
    if (path === '/api/enrollment/claim' || path === '/api/enrollment/query') {
      if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) fail('此接口仅供杯垫连接', 403);
      return; // These two routes authenticate the short-lived operation ticket themselves.
    }
    if (path.startsWith('/api/device/')) {
      if (request.headers.origin !== undefined || request.headers['sec-fetch-site'] === 'cross-site') fail('设备接口不接受浏览器跨域请求', 403);
      const id = request.headers['x-device-id'];
      const bearer = request.headers.authorization;
      if (typeof id !== 'string' || !bearer?.startsWith('Bearer ') || bearer.length > 256) fail('设备编号或凭证无效', 401);
      const row = db.prepare('SELECT token_hash AS tokenHash FROM devices WHERE id = ?').get(id) as { tokenHash: string } | undefined;
      if (!row || !timingSafeEqual(Buffer.from(hash(bearer.slice(7))), Buffer.from(row.tokenHash))) fail('设备编号或凭证无效', 401);
      devices.set(request, id);
      return;
    }
    if (!allowedHosts.has(request.headers.host ?? '')
      || (request.headers.origin !== undefined && !allowedOrigins.has(request.headers.origin))
      || ['cross-site', 'same-site'].includes(String(request.headers['sec-fetch-site'] ?? ''))) fail('请从正式网站访问', 403);
    const token = cookieToken(request);
    if (/^[a-f0-9]{64}$/.test(token)) {
      const user = findIdentity.get(hash(token), currentMs()) as Identity | undefined;
      if (user) users.set(request, user);
    }
    if (path === '/api/health' || path.startsWith('/api/auth/')) return;
    if (!users.has(request)) fail('请先登录账号', 401, 'LOGIN_REQUIRED');
    if (path.startsWith('/api/admin/') && identity(request).role !== 'admin') fail('需要管理员权限', 403, 'ADMIN_REQUIRED');
    if (path.startsWith('/api/control/') && !identity(request).deviceId) fail('请先绑定杯垫', 404, 'NO_BINDING');
  });

  const credentialsSchema = { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: {
    username: { type: 'string', pattern: '^[A-Za-z0-9_\\u4e00-\\u9fff]{3,32}$' },
    password: { type: 'string', minLength: 8, maxLength: 128 },
  } } };
  async function session(request: FastifyRequest, reply: FastifyReply, user: Identity) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ? OR expires_at <= ?').run(hash(cookieToken(request)), currentMs());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hash(token), user.id, currentMs() + sessionMs);
    reply.header('set-cookie', cookie(token, sessionMs / 1000));
    return response(user);
  }
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });
  app.get('/api/auth/session', async (request) => response(users.get(request)));
  app.post<{ Body: { username: string; password: string } }>('/api/auth/register', { schema: credentialsSchema }, async (request, reply) => {
    limit(`register:${request.ip}`, 10);
    const username = request.body.username.toLowerCase();
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await deriveKey(request.body.password, salt, 32) as Buffer).toString('hex');
    const user: Identity = { id: randomUUID(), username, role: 'user', deviceId: null, bindingId: null };
    try {
      db.prepare('INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, username, passwordHash, salt, currentMs());
    } catch (error) {
      if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) fail('该用户名已被使用', 409);
      throw error;
    }
    return session(request, reply, user);
  });
  app.post<{ Body: { username: string; password: string } }>('/api/auth/login', { schema: credentialsSchema }, async (request, reply) => {
    const username = request.body.username.toLowerCase();
    limit(`login-ip:${request.ip}`, 60);
    limit(`login-name:${hash(username)}`, 15);
    const user = db.prepare(`SELECT u.id, u.username, u.role, u.password_hash AS passwordHash, u.password_salt AS passwordSalt,
      d.id AS deviceId, d.binding_id AS bindingId FROM users u LEFT JOIN devices d ON d.user_id = u.id WHERE u.username = ?`).get(username) as Account | undefined;
    const key = await deriveKey(request.body.password, user?.passwordSalt ?? 'unknown-account-salt', 32) as Buffer;
    if (!user || !timingSafeEqual(key, Buffer.from(user.passwordHash, 'hex'))) fail('用户名或密码错误', 401);
    return session(request, reply, user);
  });
  app.post('/api/auth/logout', { schema: { body: { type: 'object', additionalProperties: false } } }, async (request, reply) => {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(cookieToken(request)));
    reply.header('set-cookie', cookie('', 0));
    return { ok: true };
  });
  return { identity, deviceId, limit };
}
