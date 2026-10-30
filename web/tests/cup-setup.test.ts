import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import ts from 'typescript';
import { ref, computed } from 'vue';
import { ApiError, errorMessage } from '../src/api';
import { commandStorageKey } from '../src/session';
import { validCupName, currentCup } from '../../shared/cups';

const script = readFileSync(new URL('../src/DeviceSetup.vue', import.meta.url), 'utf8')
  .split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import[\s\S]*?;\n/gm, '');
const source = ts.transpileModule(script + '\nglobalThis.api = { runCup, queryCommand, submitCommand, command };', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function page(storage = new Map<string, string>()) {
  const props = { online: true, calibrated: true, active: true, userId: 'user-1', deviceId: 'device-1', bindingId: 'binding-1' };
  const sent: Record<string, unknown>[] = [];
  let mounted = () => {};
  let fail = false;
  let receipt: Record<string, unknown> | undefined;
  const context: any = { ref, computed, ApiError, errorMessage, commandStorageKey, validCupName, currentCup,
    crypto: webcrypto, console, setInterval: () => 0, clearInterval: () => {},
    defineProps: () => props, defineEmits: () => () => {}, platform: { mobile: false },
    onMounted: (fn: () => void) => { mounted = fn; }, onBeforeUnmount: () => {}, watch: () => {},
    useNotice: () => ({ reset() {}, show() {} }),
    operationStorage: { getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    request: async (path: string, body?: Record<string, unknown>) => {
      if (path === '/api/auth/session') return { user: { id: props.userId }, deviceId: props.deviceId, bindingId: props.bindingId };
      if (body) {
        sent.push(JSON.parse(JSON.stringify(body)));
        receipt = { id: body.id, bindingId: props.bindingId, status: 'pending', message: null, expiresAt: Date.now() + 120000 };
        if (fail) throw new ApiError('response lost', 500);
      }
      if (!receipt) throw new ApiError('not found', 404);
      return { command: receipt };
    },
  };
  runInNewContext(source, context);
  return { api: context.api, sent, storage, mounted: () => mounted(),
    fail: (value: boolean) => { fail = value; }, receipt: (value: Record<string, unknown>) => { receipt = value; } };
}

test('杯子命令轮询后重试仍使用原始 UUID、目标和名称，成功前不清理状态', async () => {
  const p = page();
  await p.api.runCup({ action: 'rename', cupId: 2, name: '办公杯' });
  await p.api.queryCommand();
  assert.equal(p.storage.size, 1);
  await p.api.submitCommand();
  assert.deepEqual(p.sent[1], p.sent[0]);
  assert.equal(p.sent[0].action, 'rename');
  p.receipt({ ...p.api.command.value, status: 'succeeded', message: '杯名已保存' });
  await p.api.queryCommand();
  assert.equal(p.storage.size, 0);
});

test('请求结果丢失并重新打开设置后，保存请求仍关联原准备编号', async () => {
  const first = page(); first.fail(true);
  await first.api.runCup({ action: 'save', setupId: 'prepare-1' });
  const reopened = page(first.storage); reopened.mounted();
  for (let i = 0; i < 3; ++i) await tick();
  await reopened.api.submitCommand();
  assert.deepEqual(reopened.sent[0], first.sent[0]);
  assert.equal(reopened.sent[0].setupId, 'prepare-1');
});
