import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';
import ts from 'typescript';
import { ref, computed, reactive } from 'vue';
import { ApiError, errorMessage } from '../src/api';
import { commandStorageKey } from '../src/session';
import { validCupName, validCupWeight, supportsManualCupWeight, currentCup } from '../../shared/cups';

const script = readFileSync(new URL('../src/DeviceSetup.vue', import.meta.url), 'utf8')
  .split('<script setup lang="ts">')[1].split('</script>')[0].replace(/^import[\s\S]*?;\n/gm, '');
const source = ts.transpileModule(script + '\nglobalThis.api = { runCup, queryCommand, submitCommand, command, addCup, saveManualCup, editCupWeight, editWeight, editingWeight, newName, newMethod, newWeight, error, toggleAdd, manageCup, adding, managing, pendingText };', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function page(storage = new Map<string, string>(), overrides: Record<string, unknown> = {}) {
  const props = reactive({ online: true, calibrated: true, active: true, userId: 'user-1', deviceId: 'device-1', bindingId: 'binding-1',
    cups: [{ id: 1, name: '水杯', emptyCupGrams: 120 }], firmwareVersion: '0.8.1', cupPresent: false, ...overrides });
  const sent: Record<string, unknown>[] = [];
  let mounted = () => {};
  let fail = false;
  let receipt: Record<string, unknown> | undefined;
  const context: any = { ref, computed, ApiError, errorMessage, commandStorageKey, validCupName, validCupWeight, supportsManualCupWeight, currentCup,
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
  return { api: context.api, props, sent, storage, mounted: () => mounted(),
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

test('新增杯子默认称量，手动填写使用空位并规范化重量，收到成功回执才清理输入', async () => {
  const measured = page();
  assert.equal(measured.api.newMethod.value, 'weigh');
  assert.equal(measured.api.newWeight.value, '');
  measured.api.newName.value = '水瓶';
  await measured.api.addCup();
  assert.equal(measured.sent[0].action, 'prepare');
  assert.equal(measured.sent[0].cupId, 2);

  const manual = page();
  manual.api.newMethod.value = 'manual';
  manual.api.newName.value = ' 水瓶 ';
  manual.api.newWeight.value = 25.06;
  await manual.api.addCup();
  assert.deepEqual(manual.sent[0], { id: manual.api.command.value.id, action: 'manual', cupId: 2, name: '水瓶', emptyCupGrams: 25.1 });
  assert.equal(manual.api.newWeight.value, 25.06);
  assert.equal(manual.storage.size, 1);
  await manual.api.addCup();
  assert.equal(manual.sent.length, 1);
  manual.receipt({ ...manual.api.command.value, status: 'succeeded', message: '已保存' });
  await manual.api.queryCommand();
  assert.equal(manual.api.newName.value, '');
  assert.equal(manual.api.newWeight.value, '');
  assert.equal(manual.storage.size, 0);
});

test('修改杯子预填原重量，保存失败保留输入并提示拿开杯子', async () => {
  const p = page(new Map(), { cups: [{ id: 1, name: '水杯', emptyCupGrams: Math.fround(120.1) }] });
  const cup = p.props.cups[0];
  p.api.editCupWeight(cup);
  assert.equal(p.api.editWeight.value, 120.1);
  p.api.editWeight.value = 25;
  await p.api.saveManualCup(cup.id, cup.name, p.api.editWeight.value);
  assert.deepEqual(p.sent[0], { id: p.api.command.value.id, action: 'manual', cupId: 1, name: '水杯', emptyCupGrams: 25 });
  p.receipt({ id: p.api.command.value.id, bindingId: p.props.bindingId, status: 'failed', message: '', expiresAt: p.api.command.value.expiresAt });
  await p.api.queryCommand();
  assert.equal(p.api.editWeight.value, 25);
  assert.equal(p.api.editingWeight.value, 1);
  assert.equal(p.api.error.value, '空杯设置失败，请拿开杯子后重试。');
  assert.equal(p.props.cups[0].emptyCupGrams, Math.fround(120.1));
});

test('非法重量、旧固件、有杯、离线、未标定和设置中均不能手动提交', async () => {
  const p = page();
  for (const grams of ['', '25', null, undefined, NaN, Infinity, -1, 4.9, 1995.1]) {
    await p.api.saveManualCup(2, '水瓶', grams);
  }
  await p.api.saveManualCup(2, '杯 子', 25);
  assert.equal(p.sent.length, 0);
  assert.equal(p.storage.size, 0);
  for (const overrides of [{ firmwareVersion: '0.8.0' }, { firmwareVersion: null }, { cups: undefined },
    { cupPresent: true }, { online: false }, { calibrated: false },
    { cupSetup: { id: 'prepare-1', cupId: 2, name: '水瓶', expiresAt: Date.now() + 300000 } }]) {
    const blocked = page(new Map(), overrides);
    await blocked.api.saveManualCup(2, '水瓶', 25);
    assert.equal(blocked.sent.length, 0, JSON.stringify(overrides));
  }
});

test('手动重量请求丢失并重开后，重试不采用后来编辑的重量', async () => {
  const first = page(); first.fail(true);
  await first.api.saveManualCup(2, '水瓶', 25.06);
  const reopened = page(first.storage); reopened.mounted();
  for (let i = 0; i < 3; ++i) await tick();
  reopened.api.newWeight.value = 50;
  await reopened.api.submitCommand();
  assert.deepEqual(reopened.sent[0], first.sent[0]);
  assert.equal(reopened.sent[0].emptyCupGrams, 25.1);
  assert.equal(reopened.storage.size, 1);
});

test('添加表单与杯子管理互斥展开，等待确认期间不收起或丢失输入', async () => {
  const p = page();
  assert.equal(p.api.adding.value, false);
  p.api.toggleAdd();
  p.api.newName.value = '水瓶';
  p.api.manageCup(1);
  assert.equal(p.api.adding.value, false);
  assert.equal(p.api.managing.value, 1);
  p.api.editCupWeight(p.props.cups[0]);
  p.api.toggleAdd();
  assert.equal(p.api.managing.value, null);
  assert.equal(p.api.editingWeight.value, null);
  assert.equal(p.api.newName.value, '水瓶');
  p.api.newMethod.value = 'manual'; p.api.newWeight.value = 25;
  await p.api.addCup();
  assert.equal(p.api.pendingText.value, '正在保存杯子…');
  p.api.toggleAdd(); p.api.manageCup(1);
  assert.equal(p.api.adding.value, true);
  assert.equal(p.api.managing.value, null);
  p.receipt({ ...p.api.command.value, status: 'succeeded', message: '已保存' });
  await p.api.queryCommand();
  assert.equal(p.api.adding.value, false);
  assert.equal(p.api.newName.value, '');
});

test('新增失败保留表单和输入，结果未知时展示待确认状态', async () => {
  const p = page(); p.api.toggleAdd(); p.fail(true);
  p.api.newName.value = '水瓶'; p.api.newMethod.value = 'manual'; p.api.newWeight.value = 25;
  await p.api.addCup();
  assert.equal(p.api.adding.value, true);
  assert.equal(p.api.pendingText.value, '设置结果待确认');
  p.receipt({ ...p.api.command.value, status: 'failed', message: '请先拿开杯子' });
  await p.api.queryCommand();
  assert.equal(p.api.adding.value, true);
  assert.equal(p.api.newName.value, '水瓶');
  assert.equal(p.api.newWeight.value, 25);
});
