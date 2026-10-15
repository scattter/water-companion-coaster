import { createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { projectRoot, transaction } from './db.js';
import { fail } from './auth.js';
import { uuidPattern, validateServerOrigin } from './validation.js';

export const authorizationLifetimeMs = 5 * 60_000;
export function publicKeyHex(privateKey: KeyObject): string {
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('配网签名私钥必须是 P-256 PEM 私钥');
  }
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  return `04${Buffer.from(jwk.x!, 'base64url').toString('hex')}${Buffer.from(jwk.y!, 'base64url').toString('hex')}`;
}
interface Deployment { deploymentId: string; publicKey: string | null }
interface Settings { serverUrl: string; configVersion: number }
export function provisioningSigner(db: DatabaseSync, options: { signingKeyPath?: string; deploymentId?: string; serverUrl?: string; appOrigin?: string; allowLocalHttp?: boolean }) {
  let privateKey: KeyObject | undefined;
  let publicKey: string | undefined;
  if (options.deploymentId !== undefined && (options.deploymentId.length !== 36 || !new RegExp(uuidPattern).test(options.deploymentId))) {
    throw new Error('PROVISION_DEPLOYMENT_ID 必须是 UUID');
  }
  if (options.signingKeyPath) {
    let pem: string | undefined;
    try { pem = readFileSync(resolve(projectRoot, options.signingKeyPath), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取配网签名私钥文件'); }
    if (pem !== undefined) {
      try { privateKey = createPrivateKey(pem); publicKey = publicKeyHex(privateKey); }
      catch { throw new Error('配网签名私钥必须是有效的 P-256 PEM 私钥'); }
    }
  }
  transaction(db, () => {
    const stored = db.prepare('SELECT deployment_id AS deploymentId, public_key AS publicKey FROM deployment WHERE singleton = 1').get() as unknown as Deployment | undefined;
    const configuredId = options.deploymentId?.toLowerCase();
    if (stored && configuredId && stored.deploymentId !== configuredId) throw new Error('PROVISION_DEPLOYMENT_ID 与数据库固定部署不一致；请恢复对应部署配置');
    if (stored?.publicKey && publicKey && stored.publicKey !== publicKey) throw new Error('签名公钥与数据库固定公钥不一致；请恢复对应私钥，禁止自动替换');
    if (!stored && privateKey && !configuredId) throw new Error('首次启用签名必须配置 PROVISION_DEPLOYMENT_ID；禁止自动生成或替换部署身份');
    if (!stored && configuredId) db.prepare('INSERT INTO deployment (singleton, deployment_id, public_key) VALUES (1, ?, ?)').run(configuredId, publicKey ?? null);
    if (stored && !stored.publicKey && publicKey) db.prepare('UPDATE deployment SET public_key = ? WHERE singleton = 1').run(publicKey);
    if (!db.prepare('SELECT singleton FROM settings WHERE singleton = 1').get()) {
      const initial = options.serverUrl ?? (options.appOrigin?.startsWith('https://') ? options.appOrigin : undefined);
      db.prepare('INSERT INTO settings (singleton, server_url) VALUES (1, ?)').run(initial === undefined ? '' : validateServerOrigin(initial, options.allowLocalHttp));
    }
  });
  const deployment = db.prepare('SELECT deployment_id AS deploymentId, public_key AS publicKey FROM deployment WHERE singleton = 1').get() as unknown as Deployment | undefined;
  const settings = () => {
    const value = db.prepare('SELECT server_url AS serverUrl, config_version AS configVersion FROM settings WHERE singleton = 1').get() as unknown as Settings;
    return { ...value, deploymentId: deployment?.deploymentId ?? null, publicKey: deployment?.publicKey ?? null, signingReady: !!privateKey && !!deployment?.publicKey };
  };
  return {
    settings,
    authorize(input: { deviceId: string; challenge: string; operationId: string; expiresAt: number; ticket: string }) {
      const config = settings();
      if (!privateKey || !config.deploymentId || !config.signingReady) fail('配网签名尚未配置，请联系管理员', 503, 'SIGNING_NOT_READY');
      if (!config.serverUrl) fail('尚未设置配网服务器地址', 503, 'SERVER_URL_NOT_CONFIGURED');
      const payload = ['coaster-provision-v1', config.deploymentId, input.deviceId, input.challenge, input.operationId,
        config.serverUrl, String(config.configVersion), String(input.expiresAt), input.ticket].join('\n');
      return { payload, signature: sign('sha256', Buffer.from(payload), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('hex') };
    },
  };
}
export type ProvisioningSigner = ReturnType<typeof provisioningSigner>;
