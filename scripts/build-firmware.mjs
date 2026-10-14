import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildPath = join(root, 'data', 'build', 'esp32s3');
await mkdir(buildPath, { recursive: true });
const options = [
  'USBMode=hwcdc', 'CDCOnBoot=cdc', 'UploadMode=default', 'CPUFreq=240',
  'FlashMode=qio', 'FlashSize=16M', 'PSRAM=opi', 'PartitionScheme=app3M_fat9M_16MB',
  'EraseFlash=none', 'DebugLevel=none',
];
const child = spawn(process.env.ARDUINO_CLI || 'arduino-cli', [
  'compile', '--fqbn', `esp32:esp32:esp32s3:${options.join(',')}`,
  '--build-path', buildPath, '--warnings', 'default',
  join(root, 'firmware', 'water_companion'),
], { cwd: root, stdio: 'inherit' });
child.on('error', (error) => {
  console.error(`无法运行 Arduino CLI：${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code) => { process.exitCode = code ?? 1; });
