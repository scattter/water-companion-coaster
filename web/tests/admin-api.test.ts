import assert from 'node:assert/strict';
import { test } from 'node:test';
import { httpsOrigin, parseRegistry } from '../src/admin.ts';
import { ApiError, request } from '../src/api.ts';

const registry = { version: 1, devices: [{ id: 'coaster-000001', tokenHash: 'a'.repeat(64), createdAt: 1720000000000 }] };

test('admin import validates exported registries and refuses raw tokens, duplicate identities and malformed hashes', () => {
  assert.deepEqual(parseRegistry(JSON.stringify(registry)), registry);
  assert.throws(() => parseRegistry('{bad'), /JSON/);
  assert.throws(() => parseRegistry(JSON.stringify({ ...registry, token: 'raw-secret' })), /清单/);
  assert.throws(() => parseRegistry(JSON.stringify({ ...registry, devices: [{ ...registry.devices[0], token: 'raw-secret' }] })), /只能包含/);
  assert.throws(() => parseRegistry(JSON.stringify({ ...registry, devices: [registry.devices[0], registry.devices[0]] })), /重复/);
  assert.throws(() => parseRegistry(JSON.stringify({ ...registry, devices: [{ ...registry.devices[0], tokenHash: 'A'.repeat(64) }] })), /哈希/);
});

test('admin origin validation permits HTTPS origins and prevents URLs that change the request destination', () => {
  assert.equal(httpsOrigin(' https://water.example:8443/ '), 'https://water.example:8443');
  for (const bad of ['http://water.example', 'https://water.example/path', 'https://user:pass@water.example', 'https://water.example/?x=1',
    'https://water.example/#fragment', 'https://water.example/?', 'https://water.example/#', 'https://water.example.',
    'https://water_example.com', 'https://[::1]', 'https://water.example:0', 'https://water.example:abc',
    'https://water.example/.', 'https://@water.example', 'https://water.example:/', 'https://' + 'a'.repeat(190) + '.example']) {
    assert.throws(() => httpsOrigin(bad));
  }
});

test('API uses same-origin cookies, forbids redirects and external URLs, and preserves permission error code', async t => {
  const calls: { path: unknown; options: RequestInit | undefined }[] = [];
  t.mock.method(globalThis, 'fetch', async (path: unknown, options?: RequestInit) => {
    calls.push({ path, options });
    return new Response(JSON.stringify({ error: 'permission denied', code: 'DEVICE_ALREADY_BOUND' }), { status: 403 });
  });
  await assert.rejects(request('/api/provisioning/operations', { deviceId: 'coaster-000001' }), error => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'DEVICE_ALREADY_BOUND');
    return true;
  });
  assert.equal(calls[0].options?.credentials, 'same-origin');
  assert.equal(calls[0].options?.redirect, 'error');
  assert.equal(calls[0].options?.cache, 'no-store');
  await assert.rejects(request('https://other.example/api/provisioning/operations'));
  await assert.rejects(request('//other.example/api/provisioning/operations'));
  assert.equal(calls.length, 1);
});
