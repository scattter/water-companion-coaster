import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!['android', 'windows'].includes(target)) throw new Error('请指定 android 或 windows。');
const env = { ...process.env };
const output = join(root, 'output/client');
mkdirSync(output, { recursive: true });
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 失败（${result.status}）`);
}
function files(directory, extension) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(join(directory, item.name), extension) : item.name.endsWith(extension) ? [join(directory, item.name)] : []);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
if (target === 'windows') {
  const args = ['run', 'tauri', '--workspace', '@coaster/client', '--', 'build', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis', '--ci'];
  if (process.platform !== 'win32') {
    args.push('--runner', 'cargo-xwin');
    const ndk = env.NDK_HOME || join(homedir(), 'Library/Android/sdk/ndk/27.2.12479018');
    const llvm = env.LLVM_BIN || join(ndk, `toolchains/llvm/prebuilt/${process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64'}/bin`);
    if (existsSync(llvm)) env.PATH = `${llvm}${delimiter}${env.PATH}`;
    env.XWIN_ARCH = 'x86_64';
  }
  args.push('--', '--locked');
  run(npm, args);
  const candidates = files(join(root, 'client/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis'), '.exe');
  if (candidates.length !== 1) throw new Error('安装包数量不符合预期，请检查 NSIS 输出。');
  copyFileSync(candidates[0], join(output, 'water-companion-windows-x64-setup.exe'));
} else {
  env.ANDROID_HOME ||= join(homedir(), 'Library/Android/sdk');
  env.NDK_HOME ||= join(env.ANDROID_HOME, 'ndk/27.2.12479018');
  if (!env.JAVA_HOME && existsSync('/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home')) env.JAVA_HOME = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';
  run(npm, ['run', 'tauri', '--workspace', '@coaster/client', '--', 'android', 'build', '--target', 'aarch64', '--apk', '--ci', '--', '--locked']);
  const candidates = files(join(root, 'client/src-tauri/gen/android/app/build/outputs/apk'), '.apk').filter(path => path.includes('/release/'));
  if (candidates.length !== 1) throw new Error('APK 数量不符合预期，请检查 release 输出。');
  const keys = join(root, 'data/client-signing');
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  const store = join(keys, 'android-local.p12');
  const passwordFile = join(keys, 'android-local.password');
  const keytool = env.JAVA_HOME ? join(env.JAVA_HOME, 'bin/keytool') : 'keytool';
  if (!existsSync(store)) {
    if (!existsSync(passwordFile)) writeFileSync(passwordFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    run(keytool, ['-genkeypair', '-keystore', store, '-storetype', 'PKCS12', '-storepass:file', passwordFile, '-keypass:file', passwordFile, '-alias', 'water-companion', '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=Water Companion Local']);
  }
  chmodSync(store, 0o600);
  const apk = join(output, 'water-companion-android-arm64.apk');
  copyFileSync(candidates[0], apk);
  const signer = join(env.ANDROID_HOME, 'build-tools/36.0.0/apksigner');
  run(signer, ['sign', '--ks', store, '--ks-key-alias', 'water-companion', '--ks-pass', `file:${passwordFile}`, apk]);
  run(signer, ['verify', '--verbose', apk]);
}
const artifacts = readdirSync(output).filter(name => /\.(apk|exe)$/.test(name)).sort();
writeFileSync(join(output, 'SHA256SUMS.txt'), artifacts.map(name => `${createHash('sha256').update(readFileSync(join(output, name))).digest('hex')}  ${name}`).join('\n') + '\n');
console.log(`安装包和校验值已保存到 ${output}`);
