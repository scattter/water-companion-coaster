export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, body?: unknown, timeoutMs = 8000): Promise<T> {
  if (!path.startsWith('/api/') || path.includes('\\')) throw new Error('仅允许同源 API 请求。');
  const response = await fetch(path, {
    redirect: 'error',
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof data?.message === 'string' ? data.message
      : typeof data?.error === 'string' ? data.error : `请求失败（${response.status}）`;
    throw new ApiError(detail, response.status, typeof data?.code === 'string' ? data.code : undefined);
  }
  return data as T;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试';
}
