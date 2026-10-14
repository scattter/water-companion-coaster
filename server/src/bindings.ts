import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { fail } from './auth.js';

export interface DeviceOwnership { id: string; userId: string | null; bindingId: string | null; legacyBindingId: string | null; provisioningVersion: number }
export function ownership(db: DatabaseSync, deviceId: string): DeviceOwnership {
  const device = db.prepare(`SELECT id, user_id AS userId, binding_id AS bindingId,
    legacy_binding_id AS legacyBindingId, provisioning_version AS provisioningVersion FROM devices WHERE id = ?`).get(deviceId) as unknown as DeviceOwnership | undefined;
  if (!device) fail('设备尚未登记', 404, 'DEVICE_NOT_REGISTERED');
  return device;
}

// Caller holds BEGIN IMMEDIATE. Both the legacy code and signed claim paths use
// this same ownership transition; no path may update devices.user_id directly.
export function bindOwnership(db: DatabaseSync, deviceId: string, userId: string, timestamp: number, batchCapable: boolean): string {
  const device = ownership(db, deviceId);
  if (device.userId && device.userId !== userId) fail('设备已绑定其他账号', 409, 'DEVICE_ALREADY_BOUND');
  if (db.prepare('SELECT id FROM devices WHERE user_id = ? AND id <> ?').get(userId, deviceId)) fail('该账号已经绑定杯垫', 409, 'USER_ALREADY_BOUND');
  if (device.userId === userId && device.bindingId) return device.bindingId;
  const previous = db.prepare('SELECT id FROM device_bindings WHERE device_id = ? LIMIT 1').get(deviceId);
  if (previous && !batchCapable) fail('转绑前请升级支持绑定批次的固件', 409, 'BINDING_VERSION_REQUIRED');
  const bindingId = randomUUID();
  const legacy = !previous && !batchCapable;
  db.prepare('INSERT INTO device_bindings (id, device_id, user_id, started_at, legacy) VALUES (?, ?, ?, ?, ?)')
    .run(bindingId, deviceId, userId, timestamp, legacy ? 1 : 0);
  db.prepare('UPDATE devices SET user_id = ?, binding_id = ?, legacy_binding_id = COALESCE(legacy_binding_id, ?) WHERE id = ?')
    .run(userId, bindingId, legacy ? bindingId : null, deviceId);
  // Only the initial legacy connection can carry its current live status forward.
  // Historical events remain untouched. Later owners need a batch-aware heartbeat.
  if (legacy) db.prepare('UPDATE device_status SET binding_id = ? WHERE id = ?').run(bindingId, deviceId);
  else db.prepare('DELETE FROM device_status WHERE id = ?').run(deviceId);
  db.prepare("UPDATE device_commands SET status = 'expired', message = '绑定已变更' WHERE device_id = ? AND status = 'pending'")
    .run(deviceId);
  db.prepare('DELETE FROM binding_codes WHERE device_id = ?').run(deviceId);
  return bindingId;
}

export function endOwnership(db: DatabaseSync, deviceId: string, userId: string, timestamp: number) {
  const device = ownership(db, deviceId);
  if (device.userId !== userId || !device.bindingId) fail('没有当前绑定', 409, 'NO_BINDING');
  db.prepare('UPDATE device_bindings SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(timestamp, device.bindingId);
  db.prepare('UPDATE devices SET user_id = NULL, binding_id = NULL, last_seen_at = NULL WHERE id = ?').run(deviceId);
  db.prepare(`UPDATE provisioning_operations SET status = 'cancelled', code = 'BINDING_ENDED', message = '绑定已结束，授权已作废'
    WHERE device_id = ? AND status IN ('issued', 'claimed', 'completed')`).run(deviceId);
  db.prepare("UPDATE device_commands SET status = 'expired', message = '绑定已结束' WHERE device_id = ? AND status = 'pending'").run(deviceId);
  db.prepare('DELETE FROM binding_codes WHERE device_id = ?').run(deviceId);
  db.prepare('DELETE FROM device_status WHERE id = ?').run(deviceId);
}

export function eventBinding(db: DatabaseSync, device: DeviceOwnership, supplied: string | null | undefined, occurredAt: string): string | null {
  // Explicit NULL means generated while unbound (including upgraded V1 queues).
  if (supplied === null) return null;
  if (supplied === undefined) {
    if (!device.legacyBindingId) return null;
    const legacy = db.prepare('SELECT started_at AS startedAt, ended_at AS endedAt FROM device_bindings WHERE id = ?')
      .get(device.legacyBindingId) as { startedAt: number; endedAt: number | null };
    const instant = Date.parse(occurredAt);
    return instant >= legacy.startedAt && (legacy.endedAt === null || instant < legacy.endedAt) ? device.legacyBindingId : null;
  }
  const id = supplied.toLowerCase();
  if (!db.prepare('SELECT id FROM device_bindings WHERE id = ? AND device_id = ?').get(id, device.id)) {
    fail('事件绑定批次不属于此设备', 409, 'BINDING_MISMATCH');
  }
  return id;
}

export function heartbeatBinding(device: DeviceOwnership, supplied: string | null | undefined): string | null {
  if (supplied === undefined) return device.legacyBindingId === device.bindingId ? device.bindingId : null;
  return supplied?.toLowerCase() ?? null;
}
