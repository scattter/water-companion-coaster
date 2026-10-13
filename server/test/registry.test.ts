import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createApp } from '../src/app.js';
import { hash, openDatabase, projectRoot, provisionDevice } from '../src/db.js';
import { isProvisionDeviceId, validateProvisionRegistry } from '../src/provision-registry.js';
import { cookieOf, event, heartbeat } from './cloud.js';

function temporaryDirectory(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'coaster-registry-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function cli(dbPath: string, args: string[], input?: string, cwd = join(projectRoot, 'server')) {
  return spawnSync(process.execPath, ['--import', 'tsx', join(projectRoot, 'server/src/provision.ts'), ...args], {
    cwd, env: { ...process.env, DB_PATH: relative(projectRoot, dbPath) }, encoding: 'utf8', input,
  });
}

function snapshot(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Object.fromEntries(['devices', 'users', 'sessions', 'device_events', 'device_status', 'binding_codes', 'device_commands']
      .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

async function bindDevice(app: ReturnType<typeof createApp>, id: string, token: string, username: string) {
  const headers = { authorization: `Bearer ${token}`, 'x-device-id': id };
  assert.equal((await app.inject({ method: 'POST', url: '/api/device/heartbeat', headers, payload: heartbeat })).statusCode, 200);
  const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'registry-test-password' } });
  assert.equal(registered.statusCode, 200);
  const cookie = cookieOf(registered);
  const issued = await app.inject({ method: 'POST', url: '/api/device/binding', headers, payload: {} });
  assert.equal(issued.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/devices/bind', headers: { cookie }, payload: { code: issued.json().code } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/device/events', headers, payload: { events: [event()] } })).statusCode, 200);
  return { cookie, headers };
}

const record = (id = 'coaster-000001', token = 'registry-test-token-one') => ({ id, tokenHash: hash(token), createdAt: 1_780_000_000_000 });
const registry = (devices = [record()]) => ({ version: 1, devices });

test('CLI清单往返和stdin重导入保留原凭证、目标归属、登记时间及所有业务表', async (t) => {
  const directory = temporaryDirectory(t);
  const sourcePath = join(directory, 'source.sqlite');
  const targetPath = join(directory, 'target.sqlite');
  const exportedPath = join(directory, 'nested', 'devices.json');
  const first = cli(sourcePath, ['--id', 'coaster-000001']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim().split('\n').length, 1);
  const config = JSON.parse(first.stdout);
  assert.deepEqual(Object.keys(config).sort(), ['cmd', 'id', 'token']);
  assert.equal(config.cmd, 'server');
  assert.match(config.token, /^[a-f0-9]{64}$/);
  assert.match(first.stderr, /本次仅写入设备身份/);
  const second = cli(sourcePath, ['--id', 'coaster-999999', '--url', 'https://coaster.example'], undefined, projectRoot);
  assert.equal(second.status, 0, second.stderr);
  const other = JSON.parse(second.stdout);
  assert.notEqual(config.token, other.token);
  const sourceDb = openDatabase(sourcePath);
  provisionDevice(sourceDb, 'coaster-01', 'registry-legacy-source-token');
  sourceDb.close();
  const sourceApp = createApp({ dbPath: sourcePath });
  try { await bindDevice(sourceApp, config.id, config.token, 'source_owner'); }
  finally { await sourceApp.close(); }
  const sourceBefore = snapshot(sourcePath);

  const exported = cli(sourcePath, ['--export', relative(projectRoot, exportedPath)]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(exported.stdout, '');
  if (process.platform !== 'win32') assert.equal(statSync(exportedPath).mode & 0o777, 0o600);
  const text = readFileSync(exportedPath, 'utf8');
  const manifest = JSON.parse(text);
  assert.deepEqual(Object.keys(manifest).sort(), ['devices', 'version']);
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.devices.map((device: { id: string }) => device.id), ['coaster-000001', 'coaster-999999']);
  for (const device of manifest.devices) {
    assert.deepEqual(Object.keys(device).sort(), ['createdAt', 'id', 'tokenHash']);
    assert.equal(device.tokenHash, hash(device.id === config.id ? config.token : other.token));
  }
  assert.equal(text.includes(config.token), false);
  assert.equal(text.includes(other.token), false);
  assert.equal(text.includes('source_owner'), false);
  assert.deepEqual(snapshot(sourcePath), sourceBefore);
  const selectedPath = join(directory, 'selected.json');
  const selected = cli(sourcePath, ['--export', selectedPath, '--id', other.id]);
  assert.equal(selected.status, 0, selected.stderr);
  assert.deepEqual(JSON.parse(readFileSync(selectedPath, 'utf8')).devices, [manifest.devices[1]]);

  const targetDb = openDatabase(targetPath);
  provisionDevice(targetDb, 'coaster-01', 'registry-legacy-target-token');
  targetDb.close();
  const targetBefore = snapshot(targetPath);
  const imported = cli(targetPath, ['--import', relative(projectRoot, exportedPath)]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.match(imported.stderr, /新增 2 台，跳过 0 台/);
  const afterImport = snapshot(targetPath);
  for (const table of Object.keys(targetBefore).filter((table) => table !== 'devices')) assert.deepEqual(afterImport[table], targetBefore[table]);
  assert.deepEqual(afterImport.devices[0], targetBefore.devices[0]);
  assert.equal(afterImport.devices[1].user_id, null);
  assert.equal(afterImport.devices[2].user_id, null);

  const app = createApp({ dbPath: targetPath });
  try {
    const { cookie, headers } = await bindDevice(app, config.id, config.token, 'target_owner');
    assert.equal((await app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: { ...headers, authorization: 'Bearer incorrect-test-token' }, payload: heartbeat })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/control/cup', headers: { cookie }, payload: { id: randomUUID() } })).statusCode, 200);
    const otherHeaders = { authorization: `Bearer ${other.token}`, 'x-device-id': other.id };
    assert.equal((await app.inject({ method: 'POST', url: '/api/device/heartbeat', headers: otherHeaders, payload: heartbeat })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/device/binding', headers: otherHeaders, payload: {} })).statusCode, 200);
    const db = openDatabase(targetPath);
    db.prepare('UPDATE devices SET created_at = ? WHERE id = ?').run(123, config.id);
    db.close();
    const boundBefore = snapshot(targetPath);
    for (const table of ['users', 'sessions', 'device_events', 'device_status', 'binding_codes', 'device_commands']) assert.ok(boundBefore[table].length > 0);
    const repeated = cli(targetPath, ['--import', '-'], text);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.equal(repeated.stdout, '');
    assert.match(repeated.stderr, /新增 0 台，跳过 2 台/);
    assert.deepEqual(snapshot(targetPath), boundBefore);
    assert.equal((await app.inject({ url: '/api/auth/session', headers: { cookie } })).json().deviceId, config.id);
  } finally { await app.close(); }
});

test('两类凭证冲突均回滚整批导入，包括冲突前可插入的新设备', (t) => {
  const directory = temporaryDirectory(t);
  for (const kind of ['id', 'hash']) {
    const dbPath = join(directory, `${kind}.sqlite`);
    const db = openDatabase(dbPath);
    const existing = provisionDevice(db, 'coaster-000001', 'existing-conflict-test-token', 100);
    db.close();
    const before = snapshot(dbPath);
    const conflict = kind === 'id' ? record(existing.id, 'different-conflict-test-token') : record('coaster-000003', existing.token);
    const manifest = registry([record('coaster-000002', 'new-conflict-test-token'), conflict]);
    const result = cli(dbPath, ['--import', '-'], JSON.stringify(manifest));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, kind === 'id' ? /冲突/ : /其他设备使用/);
    for (const device of manifest.devices) assert.equal(result.stderr.includes(device.tokenHash), false);
    assert.deepEqual(snapshot(dbPath), before);
  }
});

test('清单严格拒绝额外字段、旧编号、错误类型和重复编号或哈希', () => {
  const valid = record();
  const invalid = [
    null, [], {}, { devices: [valid] }, { version: 2, devices: [valid] }, { ...registry(), extra: true }, registry([]),
    { version: 1, devices: {} }, { version: 1, devices: [null] }, { version: 1, devices: [42] },
    registry([{ ...valid, token: 'must-not-be-exported' } as typeof valid]),
    registry([{ ...valid, user_id: 'owner' } as typeof valid]),
    registry([{ id: valid.id, tokenHash: valid.tokenHash } as typeof valid]),
    registry([{ ...valid, id: 'coaster-01' }]), registry([{ ...valid, id: 'coaster-000000' }]),
    registry([{ ...valid, tokenHash: valid.tokenHash.toUpperCase() }]),
    registry([{ ...valid, tokenHash: `${valid.tokenHash}\n` }]), registry([{ ...valid, tokenHash: 'f'.repeat(63) }]),
    registry([{ ...valid, tokenHash: 123 as unknown as string }]),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity].map((createdAt) => registry([{ ...valid, createdAt }])),
    registry([{ ...valid, createdAt: '123' as unknown as number }]),
    registry([valid, valid]), registry([valid, { ...valid, id: 'coaster-000002' }]),
  ];
  for (const value of invalid) assert.throws(() => validateProvisionRegistry(value));
  assert.deepEqual(validateProvisionRegistry(registry()), registry());
});

test('非法清单文件或stdin先完整校验，既不创建数据库也不泄露原文', (t) => {
  const directory = temporaryDirectory(t);
  const dbPath = join(directory, 'untouched.sqlite');
  const inputs = ['', 'not-json-secret-marker', '{"secret":"syntax-secret-marker",', JSON.stringify(registry([record(), { ...record('coaster-000002', 'second-token'), createdAt: -1 }]))];
  for (const input of inputs) {
    const result = cli(dbPath, ['--import', '-'], input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('secret-marker'), false);
    assert.equal(existsSync(dbPath), false);
  }
  const invalidFile = join(directory, 'invalid.json');
  writeFileSync(invalidFile, JSON.stringify({ ...registry(), token: 'not-allowed-secret-marker' }));
  const result = cli(dbPath, ['--import', invalidFile]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.includes('secret-marker'), false);
  assert.equal(existsSync(dbPath), false);
});

test('新编号严格限定六位非零数字；非法参数和帮助都不打开数据库', (t) => {
  const directory = temporaryDirectory(t);
  const dbPath = join(directory, 'untouched.sqlite');
  const output = join(directory, 'untouched', 'export.json');
  const invalidIds = ['coaster-000000', 'coaster-01', 'coaster-00001', 'coaster-1000000', 'COASTER-000001', 'coaster-０００００１', ' coaster-000001', 'coaster-000001 ', 'coaster-000001\n'];
  for (const id of invalidIds) {
    assert.equal(isProvisionDeviceId(id), false);
    const result = cli(dbPath, ['--id', id, '--url', 'https://coaster.example']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /coaster-000001/);
    assert.equal(existsSync(dbPath), false);
  }
  assert.equal(isProvisionDeviceId('coaster-000001'), true);
  assert.equal(isProvisionDeviceId('coaster-999999'), true);
  const invalidArgs = [
    [], ['--url', 'https://coaster.example'], ['--unknown'], ['unexpected'],
    ['--export'], ['--export', ''], ['--import', ''], ['--export', output, '--import', '-'],
    ['--export', output, '--url', 'https://coaster.example'], ['--export', output, '--id', 'coaster-01'],
    ['--import', '-', '--url', 'https://coaster.example'], ['--import', '-', '--id', 'coaster-000001'],
    ['--help', '--export', output],
  ];
  for (const args of invalidArgs) {
    const result = cli(dbPath, args, JSON.stringify(registry()));
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(join(directory, 'untouched')), false);
  }
  const help = cli(dbPath, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--import -/);
  assert.equal(existsSync(dbPath), false);
});

test('只读导出不创建或迁移数据库；无结果、既有文件及符号链接不会覆盖或清理父目录', (t) => {
  const directory = temporaryDirectory(t);
  const missingDb = join(directory, 'missing.sqlite');
  const output = join(directory, 'not-created', 'devices.json');
  assert.equal(cli(missingDb, ['--export', output]).status, 1);
  assert.equal(existsSync(missingDb), false);
  assert.equal(existsSync(join(directory, 'not-created')), false);
  const emptyPath = join(directory, 'empty.sqlite');
  const empty = openDatabase(emptyPath);
  provisionDevice(empty, 'coaster-01', 'legacy-empty-export-token');
  empty.close();
  assert.equal(cli(emptyPath, ['--export', output]).status, 1);
  assert.equal(cli(emptyPath, ['--export', output, '--id', 'coaster-000001']).status, 1);
  assert.equal(existsSync(join(directory, 'not-created')), false);

  const dbPath = join(directory, 'minimal.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE devices (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)');
  const value = record();
  db.prepare('INSERT INTO devices VALUES (?, ?, ?)').run(value.id, value.tokenHash, value.createdAt);
  db.close();
  const databaseBefore = readFileSync(dbPath);
  const exported = cli(dbPath, ['--export', output]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(readFileSync(dbPath), databaseBefore);
  assert.equal(existsSync(`${dbPath}-wal`), false);
  const original = readFileSync(output);
  const sibling = join(directory, 'not-created', 'keep.txt');
  writeFileSync(sibling, 'keep-existing-content');
  assert.equal(cli(dbPath, ['--export', output]).status, 1);
  assert.deepEqual(readFileSync(output), original);
  assert.equal(readFileSync(sibling, 'utf8'), 'keep-existing-content');
  if (process.platform !== 'win32') {
    const linkedOutput = join(directory, 'linked.json');
    symlinkSync(sibling, linkedOutput);
    assert.equal(cli(dbPath, ['--export', linkedOutput]).status, 1);
    assert.equal(readFileSync(sibling, 'utf8'), 'keep-existing-content');
  }
});
