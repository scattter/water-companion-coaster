import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { projectRoot } from './db.js';
import { publicKeyHex } from './signing.js';
import { uuidPattern } from './validation.js';

function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'deployment-id': { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  const usage = '用法：npm run provisioning-key -- --out <private.pem> [--deployment-id <uuid>]；仅生成新文件，不覆盖已有私钥。';
  if (values.help && Object.keys(values).length === 1) { console.log(usage); return; }
  const deploymentId = values['deployment-id'] ?? randomUUID();
  if (values.help || !values.out?.trim() || deploymentId.length !== 36 || !new RegExp(uuidPattern).test(deploymentId)) throw new Error(usage);
  const path = resolve(projectRoot, values.out);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = publicKeyHex(privateKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ deploymentId: deploymentId.toLowerCase(), publicKey }));
  console.error('私钥已写入指定文件（权限0600）。设置 PROVISION_SIGNING_KEY_FILE 与 PROVISION_DEPLOYMENT_ID；请将私钥、部署ID和数据库一起备份。USB trust 命令仅使用上方公开字段。');
}
try { main(); }
catch { console.error('签名密钥生成失败，请检查 --out / --deployment-id；已有文件不会覆盖。使用 --help 查看用法。'); process.exitCode = 1; }
