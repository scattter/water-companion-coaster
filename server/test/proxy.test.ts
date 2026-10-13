import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, parseTrustedProxies } from '../src/app.js';

const attempt = (app: ReturnType<typeof createApp>, username: string, forwarded: string | null, remoteAddress: string) => app.inject({
  method: 'POST',
  url: '/api/auth/register',
  remoteAddress,
  headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
  payload: { username, password: 'password-123' },
});

test('可信反代链只接受合法地址和前缀长度', () => {
  assert.deepEqual(parseTrustedProxies(undefined), []);
  assert.deepEqual(parseTrustedProxies('   '), []);
  assert.deepEqual(parseTrustedProxies('127.0.0.1, ::1'), ['127.0.0.1', '::1']);
  assert.deepEqual(parseTrustedProxies('172.28.0.0/16,fd00::/8'), ['172.28.0.0/16', 'fd00::/8']);
  for (const invalid of ['coaster.example', '172.28.0.0/33', '::1/129', '172.28.0.0/abc', '172.28.0.0/0', '10.0.0.1/8/8']) {
    assert.throws(() => parseTrustedProxies(invalid), /TRUST_PROXY/, invalid);
  }
});

test('容器内网反代按真实客户端限流，未信任对端忽略转发头', async (t) => {
  const docker = createApp({ dbPath: ':memory:', trustProxy: ['127.0.0.1', '::1', '172.28.0.0/16'] });
  t.after(() => docker.close());
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await attempt(docker, `proxy_user_${index}`, '203.0.113.5', '172.28.0.2')).statusCode, 200);
  }
  assert.equal((await attempt(docker, 'proxy_user_10', '203.0.113.5', '172.28.0.2')).statusCode, 429);
  // 同一容器转发不同真实客户端时，必须各自计数，否则第 11 个注册用户就会被全局拒绝。
  assert.equal((await attempt(docker, 'proxy_user_11', '198.51.100.7', '172.28.0.2')).statusCode, 200);

  const bare = createApp({ dbPath: ':memory:' });
  t.after(() => bare.close());
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await attempt(bare, `bare_user_${index}`, `198.51.100.${index}`, '172.28.0.2')).statusCode, 200);
  }
  // 未信任该网段时反向头不再采信，所有请求共用对端地址的计数。
  assert.equal((await attempt(bare, 'bare_user_10', '203.0.113.9', '172.28.0.2')).statusCode, 429);
});
