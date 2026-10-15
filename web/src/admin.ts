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
