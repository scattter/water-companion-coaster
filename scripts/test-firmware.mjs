import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(root, 'data', 'test-output');
await mkdir(testRoot, { recursive: true });
const directory = await mkdtemp(join(testRoot, 'firmware-'));
try {
  const executable = join(directory, 'weighing-test');
  const compile = spawnSync(process.env.CC || 'cc', [
    '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic',
    '-Ifirmware/water_companion', 'firmware/water_companion/weighing.c', 'firmware/test/weighing_test.c',
    '-lm', '-o', executable,
  ], { cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: directory } });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) process.exitCode = compile.status || 1;
  else {
    const run = spawnSync(executable, [], { stdio: 'inherit' });
    if (run.error) throw run.error;
    process.exitCode = run.status ?? 1;
    if (process.exitCode === 0) {
      const cloudExecutable = join(directory, 'cloud-command-test');
      const cloudCompile = spawnSync(process.env.CC || 'cc', [
        '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic', '-Ifirmware/water_companion',
        'firmware/water_companion/cloud_command.c', 'firmware/test/cloud_command_test.c', '-o', cloudExecutable,
      ], { cwd: root, stdio: 'inherit', env: { ...process.env, TMPDIR: directory } });
      if (cloudCompile.error) throw cloudCompile.error;
      if (cloudCompile.status !== 0) process.exitCode = cloudCompile.status || 1;
      else {
        const cloudRun = spawnSync(cloudExecutable, [], { stdio: 'inherit' });
        if (cloudRun.error) throw cloudRun.error;
        process.exitCode = cloudRun.status ?? 1;
      }
    }
    if (process.exitCode === 0) {
      const testFiles = (await readdir(join(root, 'firmware', 'test')))
        .filter((name) => name.endsWith('.test.mjs')).sort()
        .map((name) => join('firmware', 'test', name));
      const page = spawnSync(process.execPath, ['--test', ...testFiles], { cwd: root, stdio: 'inherit' });
      if (page.error) throw page.error;
      process.exitCode = page.status ?? 1;
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
