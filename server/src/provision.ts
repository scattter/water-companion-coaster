import { isIPv4 } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase, projectRoot, provisionDevice } from './db.js';

const envPath = resolve(projectRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);
try {
  const { values } = parseArgs({ options: { id: { type: 'string' }, url: { type: 'string' } }, strict: true });
  if (!values.id || !values.url) throw new Error('用法：npm run provision -- --id coaster-编号 --url https://网站域名');
  const url = new URL(values.url);
  const local = isIPv4(url.hostname) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('服务器地址必须是 HTTPS 源地址；仅本地开发允许局域网 HTTP');
  }
  const db = openDatabase(process.env.DB_PATH);
  try {
    const device = provisionDevice(db, values.id);
    console.log(JSON.stringify({ cmd: 'server', url: url.origin, id: device.id, token: device.token }));
    console.error('设备已登记。请将上方一次性配置通过 USB 写入对应杯垫，妥善保管；数据库只保存凭证哈希，无法再次导出。');
  } finally { db.close(); }
} catch (error) { console.error(error instanceof Error ? error.message : '设备登记失败'); process.exitCode = 1; }
