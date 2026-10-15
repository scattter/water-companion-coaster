export interface Registry {
  version: 1;
  devices: { id: string; tokenHash: string; createdAt: number }[];
}
export function parseRegistry(text: string): Registry {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('清单不是有效的 JSON 文件。'); }
  const exact = (object: unknown, keys: string[]): object is Record<string, unknown> => object !== null
    && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).length === keys.length
    && keys.every(key => Object.hasOwn(object, key));
  if (!exact(value, ['version', 'devices']) || value.version !== 1 || !Array.isArray(value.devices) || !value.devices.length) {
    throw new Error('清单必须包含 version: 1 与非空 devices 数组。');
  }
  const ids = new Set<string>();
  const hashes = new Set<string>();
  const devices = value.devices.map((record: unknown) => {
    if (!exact(record, ['id', 'tokenHash', 'createdAt']) || typeof record.id !== 'string' || !/^coaster-(?!000000)[0-9]{6}$/.test(record.id)
      || typeof record.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.tokenHash)
      || typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
      throw new Error('每项只能包含六位设备编号 id、64 位小写凭证哈希 tokenHash 和毫秒时间戳 createdAt。请使用导出的清单。');
    }
    if (ids.has(record.id) || hashes.has(record.tokenHash)) throw new Error('清单含重复设备编号或凭证哈希。');
    ids.add(record.id);
    hashes.add(record.tokenHash);
    return { id: record.id, tokenHash: record.tokenHash, createdAt: record.createdAt };
  });
  return { version: 1, devices };
}

export function httpsOrigin(input: string, allowLocalHttp = false): string {
  const value = input.trim();
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入有效的 HTTPS 源地址。'); }
  const authority = /^https?:\/\/([^/?#@]+)\/?$/.exec(value)?.[1];
  const dnsHost = (host: string) => host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  const rawHost = authority?.split(':')[0] ?? '';
  const rawPort = authority?.includes(':') ? authority.slice(authority.indexOf(':') + 1) : undefined;
  const parts = rawHost.split('.');
  const local = allowLocalHttp && parts.length === 4 && parts.every(part => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
    && (parts[0] === '10' || (parts[0] === '192' && parts[1] === '168') || (parts[0] === '172' && Number(parts[1]) >= 16 && Number(parts[1]) <= 31));
  if (!authority || !dnsHost(rawHost) || !dnsHost(url.hostname)
    || (rawPort !== undefined && !/^[0-9]{1,5}$/.test(rawPort)) || (url.port !== '' && Number(url.port) < 1)
    || /[\s\\\x00-\x1f\x7f]/.test(value) || new TextEncoder().encode(value).length > 191
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || new TextEncoder().encode(url.origin).length > 191) {
    throw new Error(allowLocalHttp ? '地址需为 HTTPS 或局域网 IPv4 HTTP，不带路径，最长 191 字节。' : '地址必须是 HTTPS 源地址，不能包含路径、账号、查询参数或片段，最长 191 字节。');
  }
  return url.origin;
}
