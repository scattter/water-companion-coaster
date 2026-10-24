export function nativeError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  const value = cause && typeof cause === 'object' ? cause as { message?: unknown; code?: unknown } : null;
  const message = typeof cause === 'string' ? cause : typeof value?.message === 'string' ? value.message : '操作失败，请重试。';
  return value?.code === 'BLE_PERMISSION_DENIED' ? new DOMException(message, 'NotAllowedError') : new Error(message);
}
