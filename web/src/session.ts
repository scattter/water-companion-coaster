export interface Session {
  user: { id: string; username: string; role: 'user' | 'admin' } | null;
  deviceId: string | null;
  bindingId: string | null;
}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sameBinding(left: Session, right: Session) {
  return left.user?.id === right.user?.id && left.deviceId === right.deviceId && left.bindingId === right.bindingId;
}

export function commandStorageKey(userId: string, deviceId: string, bindingId: string | null) {
  // Legacy keys without a batch are deliberately not read after upgrading.
  return `water-cup-command:v2:${encodeURIComponent(userId)}:${encodeURIComponent(deviceId)}:${encodeURIComponent(bindingId ?? 'legacy')}`;
}
