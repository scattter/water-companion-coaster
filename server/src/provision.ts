import { isIPv4 } from 'node:net';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase, projectRoot, provisionDevice } from './db.js';
import { exportProvisionRegistry, importProvisionRegistry, requireProvisionDeviceId } from './provision-registry.js';

const usage = `用法：
  npm run provision -- --id coaster-000001 [--url https://网站域名]
  npm run provision -- --export FILE [--id coaster-000001]
  npm run provision -- --import FILE
  npm run provision -- --import - < FILE
  npm run provision -- --help

新设备编号为 coaster-000001 至 coaster-999999。
--url 可省略：只生成身份配置，服务器地址经 USB 单独设置（需要支持分步配置的新版固件）。
地址支持 HTTPS 源地址，局域网联调可用 http://192.168.1.10:3001 等私网 IPv4 地址。
导出和导入只包含六位编号设备的编号、凭证哈希和登记时间，不包含明文凭证或账号归属。
相对数据库和清单路径均基于项目根目录；DB_PATH 可显式指定数据库。
--import - 从标准输入读取清单，适用于容器导入。
导出不会覆盖已有文件；导入遇到凭证冲突会整批回滚。`;

function main() {
  const { values } = parseArgs({ options: {
    id: { type: 'string' }, url: { type: 'string' },
    export: { type: 'string' }, import: { type: 'string' }, help: { type: 'boolean' },
  }, strict: true });
  if (values.help) {
    if (Object.keys(values).length !== 1) throw new Error('--help 不能与其他参数同时使用');
    console.log(usage);
    return;
  }
  if (values.export !== undefined && values.import !== undefined) throw new Error('--export 和 --import 不能同时使用');
  let serverUrl: string | undefined;
  if (values.export !== undefined) {
    if (!values.export.trim() || values.url !== undefined) throw new Error('导出用法：--export FILE [--id coaster-000001]，不能同时指定 --url');
    if (values.id !== undefined) requireProvisionDeviceId(values.id);
  } else if (values.import !== undefined) {
    if (!values.import.trim() || values.id !== undefined || values.url !== undefined) throw new Error('导入用法：--import FILE，不能同时指定 --id 或 --url');
  } else {
    if (!values.id) throw new Error(usage);
    requireProvisionDeviceId(values.id);
    if (values.url !== undefined) {
      const url = new URL(values.url);
      const local = isIPv4(url.hostname) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('服务器地址必须是 HTTPS 源地址；仅本地开发允许局域网 HTTP');
      }
      serverUrl = url.origin;
    }
  }

  // 显式数据库路径优先于本机 .env。
  const envPath = resolve(projectRoot, '.env');
  if (process.env.DB_PATH === undefined && existsSync(envPath)) process.loadEnvFile(envPath);
  if (values.export !== undefined) {
    const count = exportProvisionRegistry(process.env.DB_PATH, values.export, values.id);
    console.error(`已导出 ${count} 台设备的登记清单（仅凭证哈希，不含明文凭证）。`);
    return;
  }
  if (values.import !== undefined) {
    const { inserted, skipped } = importProvisionRegistry(process.env.DB_PATH, values.import);
    console.error(`登记清单导入完成：新增 ${inserted} 台，跳过 ${skipped} 台；已有凭证和归属保持不变。`);
    return;
  }
  const db = openDatabase(process.env.DB_PATH);
  try {
    const device = provisionDevice(db, values.id!);
    console.log(JSON.stringify({ cmd: 'server', url: serverUrl, id: device.id, token: device.token }));
    console.error('设备已登记。请将上方一次性配置通过 USB 写入对应杯垫，妥善保管；数据库只保存凭证哈希，无法再次导出明文凭证。');
    if (serverUrl === undefined) console.error('本次仅写入设备身份，不更改杯垫已有服务器地址；新版固件可另发 {"cmd":"server","url":"服务器源地址"} 配置地址，保存后重启。');
  } finally { db.close(); }
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.message : '设备登记操作失败'); process.exitCode = 1; }
