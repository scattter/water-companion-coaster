import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';

export const uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
export const uuidSchema = { type: 'string', pattern: uuidPattern, minLength: 36, maxLength: 36 };
export const bindingSchema = { anyOf: [uuidSchema, { type: 'null' }] };
export const hexSchema = { type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 };
export const emptyBody = { body: { type: 'object', additionalProperties: false } };
export const idParams = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuidSchema } };

export function localServerOrigin(port: number): string | undefined {
  const addresses = new Set(Object.entries(networkInterfaces()).filter(([name]) => !/^(utun|tun|tap|docker|br-|veth|vmnet|bridge)/i.test(name))
    .flatMap(([, interfaces]) => (interfaces ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address)));
  const origins = [...addresses].flatMap((address) => {
    try { return [validateServerOrigin(`http://${address}:${port}`, true)]; } catch { return []; }
  });
  return origins.length === 1 ? origins[0] : undefined;
}

/** Shared by device registration and provisioning; private-LAN HTTP is opt-in for development. */
export function validateServerOrigin(value: string, allowLocalHttp = false): string {
  const invalid = () => new Error('服务器地址必须是 HTTPS 源地址（最多191字节，无路径、查询、凭据或片段）；仅本地开发允许局域网 HTTP');
  if (!value || value !== value.trim() || Buffer.byteLength(value) > 191 || /[\s\\\x00-\x1f\x7f]/.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const local = allowLocalHttp && isIPv4(url.hostname) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  // Validate the raw syntax as well: URL normalizes dot paths, empty query/fragment
  // delimiters, empty userinfo and malformed slashes which must not become trusted.
  const authority = /^https?:\/\/([^/?#@]+)\/?$/.exec(value)?.[1];
  const dnsHost = (host: string) => host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  const rawHost = authority?.split(':')[0] ?? '';
  const rawPort = authority?.includes(':') ? authority.slice(authority.indexOf(':') + 1) : undefined;
  if (!authority || !dnsHost(rawHost) || (rawPort !== undefined && !/^[0-9]{1,5}$/.test(rawPort))
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || !dnsHost(url.hostname) || (url.port !== '' && Number(url.port) < 1)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash || Buffer.byteLength(url.origin) > 191) throw invalid();
  return url.origin;
}
