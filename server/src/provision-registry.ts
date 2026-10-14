import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { databasePath, openDatabase, projectRoot, transaction } from './db.js';
import { fail } from './auth.js';

export interface ProvisionRecord { id: string; tokenHash: string; createdAt: number }
export interface ProvisionRegistry { version: 1; devices: ProvisionRecord[] }

export function isProvisionDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 14 && /^coaster-(?!000000)[0-9]{6}$/.test(value);
}

export function requireProvisionDeviceId(value: unknown): asserts value is string {
  if (!isProvisionDeviceId(value)) throw new Error('新设备编号必须为 coaster-000001 至 coaster-999999（coaster- 加六位数字，不能为 000000）');
}

function hasKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function validateProvisionRegistry(value: unknown): ProvisionRegistry {
  if (!hasKeys(value, ['version', 'devices']) || value.version !== 1 || !Array.isArray(value.devices) || value.devices.length === 0) {
    throw new Error('登记清单必须包含 version: 1 和非空 devices 数组，不能含其他字段');
  }
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const devices = value.devices.map((record: unknown, index: number): ProvisionRecord => {
    if (!hasKeys(record, ['id', 'tokenHash', 'createdAt'])) {
      throw new Error(`登记清单第 ${index + 1} 项只能包含 id、tokenHash、createdAt`);
    }
    requireProvisionDeviceId(record.id);
    if (typeof record.tokenHash !== 'string' || record.tokenHash.length !== 64 || !/^[a-f0-9]{64}$/.test(record.tokenHash)) {
      throw new Error(`登记清单第 ${index + 1} 项的凭证哈希必须为 64 位小写十六进制`);
    }
    if (typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
      throw new Error(`登记清单第 ${index + 1} 项的登记时间必须为非负安全整数毫秒时间戳`);
    }
    if (ids.has(record.id)) throw new Error('登记清单含重复设备编号');
    if (hashes.has(record.tokenHash)) throw new Error('登记清单含重复凭证哈希，每台设备必须使用独立凭证');
    ids.add(record.id);
    hashes.add(record.tokenHash);
    return { id: record.id, tokenHash: record.tokenHash, createdAt: record.createdAt };
  });
  return { version: 1, devices };
}

export function exportProvisionRegistry(dbPath: string | undefined, outputPath: string, id?: string): number {
  if (id !== undefined) requireProvisionDeviceId(id);
  const db = new DatabaseSync(databasePath(dbPath), { readOnly: true });
  let registry: ProvisionRegistry;
  try {
    const query = db.prepare(`SELECT id, token_hash AS tokenHash, created_at AS createdAt FROM devices${id === undefined ? '' : ' WHERE id = ?'} ORDER BY id`);
    const rows = id === undefined ? query.all() : query.all(id);
    const devices = rows.filter((row) => isProvisionDeviceId(row.id));
    if (devices.length === 0) throw new Error('没有可导出的六位编号设备');
    registry = validateProvisionRegistry({ version: 1, devices });
  } finally { db.close(); }
  const filename = resolve(projectRoot, outputPath);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, `${JSON.stringify(registry, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return registry.devices.length;
}

export function importProvisionRegistry(dbPath: string | undefined, inputPath: string): { inserted: number; skipped: number } {
  const source = readFileSync(inputPath === '-' ? 0 : resolve(projectRoot, inputPath), 'utf8');
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { throw new Error('登记清单不是有效 JSON'); }
  const registry = validateProvisionRegistry(value);
  const db = openDatabase(dbPath);
  try { return importRegistryRecords(db, registry); } finally { db.close(); }
}

/** Shared atomic import for the CLI, HTTP import and manual admin registration. */
export function importRegistryRecords(db: DatabaseSync, value: unknown): { inserted: number; skipped: number } {
  const registry = validateProvisionRegistry(value);
  return transaction(db, () => {
    const findId = db.prepare('SELECT token_hash AS tokenHash FROM devices WHERE id = ?');
    const findHash = db.prepare('SELECT id FROM devices WHERE token_hash = ?');
    const insert = db.prepare('INSERT INTO devices (id, token_hash, created_at) VALUES (?, ?, ?)');
    let inserted = 0;
    let skipped = 0;
    for (const device of registry.devices) {
      const existing = findId.get(device.id);
      if (existing) {
        if (existing.tokenHash !== device.tokenHash) fail(`设备 ${device.id} 的凭证与目标数据库冲突`, 409, 'DEVICE_CREDENTIAL_CONFLICT');
        skipped += 1;
        continue;
      }
      if (findHash.get(device.tokenHash)) fail(`设备 ${device.id} 的凭证已被其他设备使用`, 409, 'DEVICE_CREDENTIAL_CONFLICT');
      insert.run(device.id, device.tokenHash, device.createdAt);
      inserted += 1;
    }
    return { inserted, skipped };
  });
}
