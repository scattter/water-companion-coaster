import { createApp } from './app.js';
import { SerialPort } from 'serialport';
import { DeviceSetup, localServerUrls } from './setup.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口');
const deviceId = process.env.DEVICE_ID ?? 'coaster-01';
const deviceToken = process.env.DEVICE_TOKEN ?? '';

const app = createApp({
  deviceId,
  deviceToken,
  setup: new DeviceSetup({
    deviceId, deviceToken, listPorts: () => SerialPort.list(),
    createPort: (path) => new SerialPort({ path, baudRate: 115200, autoOpen: false }),
    serverUrls: () => localServerUrls(port),
  }),
  dbPath: process.env.DB_PATH,
  timeZone: process.env.APP_TIMEZONE,
  allowedOrigins: ['localhost', '127.0.0.1', '[::1]']
    .flatMap((host) => [port, 5173].map((allowedPort) => `http://${host}:${allowedPort}`)),
  logger: { level: 'warn' },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
