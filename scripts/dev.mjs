import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('请使用 Node.js 24（可执行 nvm use）。');
  process.exit(1);
}
if (existsSync('.env')) process.loadEnvFile('.env');
if (!process.env.DEVICE_TOKEN?.trim()) {
  console.error('请先复制 .env.example 为 .env 并设置固定 DEVICE_TOKEN，与串口写入杯垫的凭证保持一致。');
  process.exit(1);
}

const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const force = setTimeout(() => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  }, 3000);
  force.unref();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

const env = {
  ...process.env,
  DEVICE_TOKEN: process.env.DEVICE_TOKEN,
  DEVICE_ID: process.env.DEVICE_ID || 'coaster-01',
  HOST: process.env.HOST || '0.0.0.0',
  DB_PATH: resolve(process.env.DB_PATH || 'data/coaster-hardware.sqlite'),
  APP_TIMEZONE: process.env.APP_TIMEZONE || 'Asia/Shanghai',
  PORT: '3001',
};

async function assertPortFree(port) {
  await new Promise((accept, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`端口 ${port} 已被占用或当前环境不允许监听，请停止占用进程后重试。`)));
    probe.listen(port, '127.0.0.1', () => probe.close(accept));
  });
}
function start(name, args, cwd = root, childEnv = env) {
  if (stopping) throw new Error('启动已停止');
  const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: 'inherit' });
  children.push(child);
  child.on('error', (error) => {
    console.error(`${name} 启动失败：${error.message}`);
    stop(1);
  });
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${name} 已退出（${code ?? '信号终止'}），停止其余服务。`);
      stop(code || 1);
    }
  });
}
async function waitReady(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok && !stopping) return;
    } catch {}
    await delay(200);
  }
  throw new Error(`服务未就绪：${url}`);
}

try {
  for (const port of [3001, 5173]) await assertPortFree(port);
  start('后端', ['--import', 'tsx', 'server/src/index.ts']);
  await waitReady('http://127.0.0.1:3001/api/health');
  const { DEVICE_TOKEN, ...webEnv } = env;
  start('网页', [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], resolve('web'), webEnv);
  await waitReady('http://127.0.0.1:5173');
  console.log('\n饮水陪伴杯垫已启动：http://127.0.0.1:5173\n模式：ESP32-S3 / HX711 真实称重 · Ctrl+C 停止全部服务\n');
} catch (error) {
  console.error(error.message);
  stop(1);
}
