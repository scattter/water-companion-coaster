import { createApp, parseTrustedProxies } from './app.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口');
const production = process.env.NODE_ENV === 'production';
const configuredOrigin = process.env.APP_ORIGIN;
if (production && !configuredOrigin) throw new Error('生产环境必须设置 APP_ORIGIN');
const origin = configuredOrigin ? new URL(configuredOrigin) : null;
if (origin && (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)) {
  throw new Error('APP_ORIGIN 必须是网站源地址，例如 https://coaster.example.com');
}
if (production && origin?.protocol !== 'https:') throw new Error('生产环境 APP_ORIGIN 必须使用 HTTPS');
// 容器部署时反代不在本机，需要额外写明内网网段，否则限流会把所有用户算成同一个地址。
const trustedProxies = parseTrustedProxies(process.env.TRUST_PROXY);
const app = createApp({
  deviceId: process.env.DEVICE_ID,
  deviceToken: process.env.DEVICE_TOKEN || undefined,
  dbPath: process.env.DB_PATH,
  timeZone: process.env.APP_TIMEZONE,
  appOrigin: origin?.origin,
  allowedOrigins: production ? [origin!.origin] : [...new Set([
    ...(origin ? [origin.origin] : []),
    ...['localhost', '127.0.0.1', '[::1]'].flatMap((host) => [port, 5173].map((value) => `http://${host}:${value}`)),
  ])],
  trustProxy: production ? (trustedProxies.length > 0 ? trustedProxies : ['127.0.0.1', '::1']) : false,
  logger: { level: 'warn', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'] },
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => { await app.close(); process.exit(0); });
}
try { await app.listen({ host: process.env.HOST ?? '0.0.0.0', port }); }
catch (error) { app.log.error(error); await app.close(); process.exitCode = 1; }
