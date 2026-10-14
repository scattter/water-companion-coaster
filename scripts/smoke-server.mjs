import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { createApp } from '../server/src/app.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'coaster-browser-smoke-'));
const keyPath = join(directory, 'signing.pem');
const dbPath = join(directory, 'smoke.sqlite');
const port = Number(process.env.SMOKE_PORT || 4137);
const origin = `http://127.0.0.1:${port}`;
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const app = createApp({
  dbPath, appOrigin: origin, signingKeyPath: keyPath,
  deploymentId: randomUUID(), serverUrl: 'https://coaster.example.com',
});
await app.ready();
const registration = await app.inject({
  method: 'POST', url: '/api/auth/register',
  headers: { host: new URL(origin).host, origin },
  payload: { username: 'smoke_admin', password: 'SmokeOnly24!Browser' },
});
if (registration.statusCode !== 200) throw new Error(`Smoke fixture registration failed: ${registration.body}`);
const db = new DatabaseSync(dbPath);
db.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run('smoke_admin');
db.close();
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const server = createServer(async (request, response) => {
  try {
    if ((request.url || '').startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const result = await app.inject({
        method: request.method, url: request.url, headers: request.headers,
        ...(chunks.length ? { payload: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(result.statusCode, result.headers);
      response.end(result.rawPayload);
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url || '/', origin).pathname);
    const base = join(root, 'web', 'dist');
    let target = resolve(base, `.${pathname}`);
    if (!target.startsWith(`${base}/`) && target !== base) { response.writeHead(400); response.end(); return; }
    if (!extname(target)) target = join(base, 'index.html');
    const body = await readFile(target);
    response.writeHead(200, { 'content-type': mime[extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error instanceof Error ? error.message : 'Smoke server failed');
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Smoke UI: ${origin}`);
  console.log('Isolated temporary data; login smoke_admin / SmokeOnly24!Browser');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  server.close();
  await app.close();
  process.exit(0);
});
