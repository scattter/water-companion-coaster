import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { databasePath, openDatabase, projectRoot, transaction } from './db.js';

function main() {
  const { values } = parseArgs({ options: { username: { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  const usage = '用法：npm run admin -- --username <已注册账号>（DB_PATH 指定数据库；仅提升明确指定的已有账号）';
  if (values.help && Object.keys(values).length === 1) { console.log(usage); return; }
  if (values.help || !values.username || !/^[A-Za-z0-9_\u4e00-\u9fff]{3,32}$/.test(values.username)) throw new Error(usage);
  const envPath = resolve(projectRoot, '.env');
  if (process.env.DB_PATH === undefined && existsSync(envPath)) process.loadEnvFile(envPath);
  if (!existsSync(databasePath(process.env.DB_PATH))) throw new Error('数据库不存在，请先启动服务并注册账号');
  const db = openDatabase(process.env.DB_PATH);
  try {
    transaction(db, () => {
      const user = db.prepare('SELECT id FROM users WHERE username = ?').get(values.username!.toLowerCase());
      if (!user) throw new Error('指定账号尚未注册；不会自动选择或创建管理员');
      db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    });
    console.log('已将指定账号设为管理员。');
  } finally { db.close(); }
}
try { main(); }
catch (error) { console.error(error instanceof Error ? error.message : '管理员初始化失败'); process.exitCode = 1; }
