<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiError, errorMessage, request } from './api';
import { operationStorage, platform } from './platform';
import { useNotice } from './notices';
import { commandStorageKey, type Session } from './session';
import { currentCup, supportsManualCupWeight, validCupName, validCupWeight, type Cup, type CupSetup, type CupCommand } from '../../shared/cups';

const props = defineProps<{
  online: boolean;
  deviceId: string;
  userId: string;
  bindingId: string | null;
  calibrated?: boolean;
  emptyCupGrams?: number | null;
  weightGrams?: number | null;
  cups?: Cup[];
  activeCupId?: number | null;
  cupSetup?: CupSetup | null;
  cupPresent?: boolean;
  firmwareVersion?: string | null;
  active: boolean;
}>();
const emit = defineEmits<{ updated: []; accessError: [cause: ApiError, userId: string, deviceId: string] }>();
interface Command {
  id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'expired';
  message: string | null;
  expiresAt: number;
  bindingId: string | null;
  request?: CupCommand;
}
const command = ref<Command | null>(null);
const busy = ref(false);
const error = ref('');
const feedback = ref('');
const uncertain = ref(false);
const checkingStopped = ref(false);
const storageKey = commandStorageKey(props.userId, props.deviceId, props.bindingId);
let timer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
const pending = computed(() => command.value?.status === 'pending');
const canSetCup = computed(() => props.online && props.calibrated && !busy.value && !pending.value);
const multiCup = computed(() => props.cups !== undefined);
const manualCup = computed(() => multiCup.value && supportsManualCupWeight(props.firmwareVersion));
const canManage = computed(() => canSetCup.value && !props.cupSetup);
const cupLabel = computed(() => currentCup({ cups: props.cups, activeCupId: props.activeCupId, emptyCupGrams: props.emptyCupGrams ?? null }));
const nextCupId = computed(() => [1, 2, 3].find(id => !props.cups?.some(cup => cup.id === id)));
const newName = ref('');
const newMethod = ref<'weigh' | 'manual'>('weigh');
const newWeight = ref<number | string>('');
const editName = ref('');
const editWeight = ref<number | string>('');
const editing = ref<number | null>(null);
const editingWeight = ref<number | null>(null);
const deleting = ref<number | null>(null);
const adding = ref(false);
const managing = ref<number | null>(null);
const newNameInput = ref<HTMLInputElement | null>(null);
const pendingText = computed(() => {
  if (uncertain.value || checkingStopped.value) return '设置结果待确认';
  const action = command.value?.request?.action;
  if (action === 'prepare') return '正在等待杯垫开始设置…';
  if (action === 'manual' || action === 'save') return '正在保存杯子…';
  if (action === 'rename') return '正在保存杯名…';
  if (action === 'select') return '正在切换杯子…';
  if (action === 'delete') return '正在删除杯子…';
  return '正在等待杯垫确认…';
});
const errorNotice = useNotice('web:cup:error', () => error.value, {
  enabled: () => props.active && !busy.value,
  action: () => pending.value ? { label: '查询设置结果', run: queryCommand } : undefined,
});
useNotice('web:cup:feedback', () => feedback.value, { enabled: () => props.active && !busy.value });

function rememberCommand(value: Command) {
  // 先保存请求编号，响应丢失或刷新页面后仍能查询同一操作，避免重复写入。
  operationStorage.setItem(storageKey, JSON.stringify(value));
  command.value = value;
}

function applyCommand(value: Command) {
  if (value.id !== command.value?.id || (value.bindingId ?? null) !== props.bindingId) {
    checkingStopped.value = true;
    error.value = '命令不属于当前设备绑定，请刷新账号状态后再操作。';
    return;
  }
  command.value = { ...value, request: command.value.request };
  uncertain.value = false;
  error.value = '';
  if (value.status === 'pending') {
    try { operationStorage.setItem(storageKey, JSON.stringify(command.value)); }
    catch { error.value = '浏览器无法保存操作状态，请保持本页打开，直到确认结果。'; }
    return;
  }
  try { operationStorage.removeItem(storageKey); } catch { /* 已确认结果，不影响当前页面展示。 */ }
  if (value.status === 'succeeded') {
    feedback.value = value.message || '杯子操作已完成。';
    editing.value = editingWeight.value = deleting.value = managing.value = null;
    adding.value = false;
    if (command.value.request?.action === 'prepare' || command.value.request?.action === 'manual') {
      newName.value = '';
      newWeight.value = '';
    }
    emit('updated');
  } else {
    error.value = value.message || (value.status === 'expired' ? '设备未在有效期内确认操作。请确认联网后重新设置。'
      : command.value.request?.action === 'manual' ? '空杯设置失败，请拿开杯子后重试。' : '空杯设置失败，请保持空杯静置后重试。');
  }
}

function accessError(cause: unknown) {
  if (!(cause instanceof ApiError) || cause.status !== 401) return false;
  emit('accessError', cause, props.userId, props.deviceId);
  return true;
}

async function checkCommand(manual = false) {
  if (!props.active || !pending.value || busy.value || disposed || (checkingStopped.value && !manual)) return;
  const current = command.value!;
  busy.value = true;
  try {
    const result = await request<{ command: Command }>(`/api/control/commands/${encodeURIComponent(current.id)}`);
    if (!disposed) applyCommand(result.command);
  } catch (cause) {
    if (disposed || accessError(cause)) return;
    uncertain.value = cause instanceof ApiError && cause.status === 404 ? true : uncertain.value;
    error.value = cause instanceof ApiError && cause.status === 404
      ? '云端尚未找到这次操作，结果未确认。你可以继续查询，或重试同一次请求。'
      : `暂时无法确认设置结果：${errorMessage(cause)}。请继续查询，不要重复设置空杯。`;
  } finally {
    busy.value = false;
    if (Date.now() > current.expiresAt + 15000 && pending.value) {
      checkingStopped.value = true;
      if (!error.value) error.value = '尚未确认设备执行结果，自动查询已暂停。请点击“查询设置结果”继续确认。';
    }
    if (!disposed) errorNotice.show();
  }
}

async function queryCommand() {
  if (!props.active || !pending.value || busy.value || disposed) return;
  errorNotice.reset();
  await checkCommand(true);
}

async function submitCommand() {
  if (!command.value || busy.value) return;
  errorNotice.reset();
  const id = command.value.id;
  busy.value = true;
  checkingStopped.value = false;
  feedback.value = '';
  error.value = '';
  try {
    const session = await request<Session>('/api/auth/session');
    if (disposed) return;
    if (session.user?.id !== props.userId || session.deviceId !== props.deviceId || session.bindingId !== props.bindingId) {
      throw new ApiError('账号或绑定批次已变化，请刷新账号状态。', 403);
    }
    const result = await request<{ command: Command }>('/api/control/cup', command.value!.request ?? { id });
    if (!disposed) applyCommand(result.command);
  } catch (cause) {
    if (disposed || accessError(cause)) return;
    if (cause instanceof ApiError && [400, 409, 422].includes(cause.status)) {
      command.value = null;
      try { operationStorage.removeItem(storageKey); } catch { /* 重试时仍使用服务器校验。 */ }
      uncertain.value = false;
      error.value = errorMessage(cause);
    } else {
      uncertain.value = true;
      error.value = `请求结果未确认：${errorMessage(cause)}。将查询同一次操作，不会自动重新发送。`;
    }
  } finally { busy.value = false; if (!disposed) errorNotice.show(); }
}

async function setCup() {
  await runCup({});
}

async function runCup(input: Omit<CupCommand, 'id'>) {
  if (input.action === 'cancel' ? !props.online || busy.value || pending.value : !canSetCup.value) return;
  errorNotice.reset();
  try {
    const id = crypto.randomUUID();
    rememberCommand({ id, bindingId: props.bindingId, status: 'pending', message: null,
      expiresAt: Date.now() + 120000, request: { id, ...input } });
  } catch {
    error.value = '浏览器无法保存操作状态。请允许此网站使用会话存储后重试，当前未发送设置请求。';
    errorNotice.show();
    return;
  }
  await submitCommand();
}

function prepareCup(cupId: number, name: string) {
  if (!canManage.value || !validCupName(name.trim())) return;
  return runCup({ action: 'prepare', cupId, name: name.trim() });
}

async function saveManualCup(cupId: number, name: string, grams: unknown) {
  if (!canManage.value || !manualCup.value || props.cupPresent !== false
    || !validCupName(name.trim()) || !validCupWeight(grams)) return;
  await runCup({ action: 'manual', cupId, name: name.trim(), emptyCupGrams: Math.round(grams * 10) / 10 });
}

function addCup() {
  if (!nextCupId.value) return;
  return newMethod.value === 'manual'
    ? saveManualCup(nextCupId.value, newName.value, newWeight.value)
    : prepareCup(nextCupId.value, newName.value);
}

function toggleAdd() {
  if (!canManage.value) return;
  adding.value = !adding.value;
  managing.value = editing.value = editingWeight.value = deleting.value = null;
}

function manageCup(id: number) {
  if (!canManage.value) return;
  managing.value = managing.value === id ? null : id;
  adding.value = false;
  editing.value = editingWeight.value = deleting.value = null;
}

function revealPanel(element: Element) {
  if (!props.active) return;
  // 新卡片和后续称量步骤可能出现在滚动区外，切换后让用户看到接下来的操作。
  (element as HTMLElement).focus({ preventScroll: true });
  element.scrollIntoView({ block: 'nearest' });
}

function editCupWeight(cup: Cup) {
  editingWeight.value = cup.id;
  editing.value = deleting.value = null;
  editWeight.value = Math.round(cup.emptyCupGrams * 10) / 10;
}

function renameCup(cup: Cup) {
  editing.value = cup.id;
  editingWeight.value = deleting.value = null;
  editName.value = cup.name;
}

onMounted(() => {
  try {
    const stored = operationStorage.getItem(storageKey);
    if (stored) {
      const value = JSON.parse(stored) as Command;
      if (typeof value.id === 'string' && /^[0-9a-f-]{36}$/i.test(value.id) && value.status === 'pending' && value.bindingId === props.bindingId && Number.isFinite(value.expiresAt)) {
        command.value = value;
        uncertain.value = true;
      }
    }
  } catch { error.value = '无法读取上次设置状态。若刚提交过空杯设置，请先检查杯垫和空杯重量。'; }
  timer = setInterval(() => void checkCommand(), 2000);
  void checkCommand();
});
watch(() => props.active, (active) => { if (active) void checkCommand(true); });
onBeforeUnmount(() => { disposed = true; clearInterval(timer); });
</script>

<template>
  <section class="setup-panel" aria-label="杯子与称重设置">
    <div class="device-summary">
      <div><span>设备</span><strong>{{ deviceId }}</strong></div>
      <span class="connection-badge" :class="{ online }" role="status"><i></i>{{ online ? '云端在线' : '离线或未同步' }}</span>
    </div>
    <p v-if="!online" class="setup-alert" role="status">杯垫暂未在线，以下为上次同步的杯子。请保持供电并连接 Wi-Fi 后再设置。</p>
    <section class="cup-setup" aria-labelledby="cup-title">
      <div class="cup-section-heading">
        <div>
          <div class="cup-title-row"><h3 id="cup-title">{{ multiCup ? '我的杯子' : '日常空杯设置' }}</h3><span v-if="multiCup" class="cup-count">{{ cups!.length }} / 3</span></div>
          <p v-if="!multiCup">记住空杯重量，让每次饮水都有记录。</p>
        </div>
        <button v-if="multiCup && nextCupId && !cupSetup" class="primary add-cup-button" :disabled="!canManage" :aria-expanded="adding" :aria-label="adding ? '收起添加' : '添加杯子'" aria-controls="new-cup-form" @click="toggleAdd"><svg v-if="!adding" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg><span class="add-label">{{ adding ? '收起添加' : '添加杯子' }}</span><span class="add-label-short" aria-hidden="true">{{ adding ? '收起' : '添加' }}</span></button>
      </div>
      <p v-if="calibrated === false" class="setup-alert error" role="alert">杯垫尚未完成出厂标定，请联系售后。你无需准备砝码或自行校准。</p>
      <p v-else-if="calibrated === undefined" class="setup-tip">正在读取杯垫状态…</p>
      <template v-if="multiCup">
        <p v-if="!manualCup" class="setup-tip">手动填写空杯／空瓶重量需固件 0.8.1 或更新版本。</p>
        <Transition name="setup-expand" @after-enter="revealPanel">
          <div v-if="cupSetup" class="setup-reveal cup-preparation-reveal" tabindex="-1" aria-label="称量空杯">
            <div class="setup-reveal-content">
              <div class="cup-preparation" role="status">
                <span class="section-eyebrow">正在设置杯子 · 记录已暂停</span>
                <h4>{{ cupSetup.name }}</h4>
                <ol class="setup-steps" aria-label="称量空杯步骤"><li class="done">拿开原杯</li><li class="current">放稳空杯</li><li>确认保存</li></ol>
                <p class="setup-tip">请放上这只空杯，静置至少 3 秒后保存。5 分钟未完成会自动结束设置。</p>
                <div class="command-actions">
                  <button class="primary" :disabled="!canSetCup" @click="runCup({ action: 'save', setupId: cupSetup.id })"><span v-if="pending && !uncertain && !checkingStopped" class="command-spinner button-spinner" aria-hidden="true"></span>{{ pending ? pendingText : '保存空杯重量' }}</button>
                  <button class="quiet" :disabled="!online || busy || pending" @click="runCup({ action: 'cancel', setupId: cupSetup.id })">取消设置</button>
                </div>
              </div>
            </div>
          </div>
        </Transition>
        <TransitionGroup name="cup-card" tag="ul" class="cup-list" @enter="revealPanel">
          <li v-for="cup in cups" :key="cup.id" class="cup-card" tabindex="-1" :aria-label="cup.name" :class="{ 'is-current': cup.id === activeCupId, 'is-managed': managing === cup.id }">
            <div class="cup-card-main">
              <span class="cup-icon" aria-hidden="true"><svg viewBox="0 0 140 135" fill="none" focusable="false"><path d="M32 10h77l-8 110a7 7 0 0 1-7 6H47a7 7 0 0 1-7-6L32 10Z" stroke="currentColor" stroke-width="7"/><path d="M37 63c15-12 26 11 41 0 11-8 17-5 27-1l-4 58a7 7 0 0 1-7 6H47a7 7 0 0 1-7-6l-3-57Z" fill="currentColor" opacity=".16"/><path d="M37 63c15-12 26 11 41 0 11-8 17-5 27-1" stroke="currentColor" stroke-width="6"/></svg></span>
              <div class="cup-card-info">
                <h4>{{ cup.name }}</h4>
                <p>空杯 <strong>{{ cup.emptyCupGrams.toFixed(1) }} <span>g</span></strong></p>
              </div>
              <div class="cup-card-actions">
                <span v-if="cup.id === activeCupId" class="current-badge">使用中</span>
                <button v-else class="cup-switch" :disabled="!canManage || cupPresent !== false" @click="runCup({ action: 'select', cupId: cup.id })">使用<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M3 8h9m-4-4 4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg></button>
                <button class="quiet cup-more" :disabled="!canManage" :aria-expanded="managing === cup.id" :aria-controls="'cup-manage-' + cup.id" :aria-label="(managing === cup.id ? '收起管理' : '管理') + cup.name" :title="managing === cup.id ? '收起管理' : '管理杯子'" @click="manageCup(cup.id)"><svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="4" cy="10" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="16" cy="10" r="1.5"/></svg></button>
              </div>
            </div>
            <Transition name="setup-expand">
              <div v-if="managing === cup.id" :id="'cup-manage-' + cup.id" class="setup-reveal">
                <div class="setup-reveal-content">
                  <div class="cup-management">
                    <div class="cup-tools" aria-label="杯子管理操作">
                      <button class="quiet" :class="{ selected: editing === cup.id }" :disabled="!canManage" @click="renameCup(cup)">修改名称</button>
                      <button class="quiet" :disabled="!canManage || cupPresent !== false" @click="prepareCup(cup.id, cup.name)">重新称量</button>
                      <button class="quiet" :class="{ selected: editingWeight === cup.id }" :disabled="!canManage || !manualCup" @click="editCupWeight(cup)">手动设置重量</button>
                      <button class="quiet danger" :disabled="!canManage" @click="deleting = cup.id; editing = editingWeight = null">删除杯子</button>
                    </div>
                    <Transition name="setup-form" mode="out-in">
                      <form v-if="editing === cup.id" key="name" class="cup-edit" @submit.prevent="runCup({ action: 'rename', cupId: cup.id, name: editName.trim() })">
                        <label :for="'cup-name-' + cup.id">杯子名称 <span>1–5 个汉字、字母或数字</span></label>
                        <input :id="'cup-name-' + cup.id" v-model="editName" maxlength="32" required :disabled="!canManage" />
                        <div class="command-actions"><button class="primary" :disabled="!canManage || !validCupName(editName.trim())">保存名称</button><button type="button" class="quiet" :disabled="busy || pending" @click="editing = null">取消</button></div>
                      </form>
                      <form v-else-if="editingWeight === cup.id" key="weight" class="cup-edit" @submit.prevent="saveManualCup(cup.id, cup.name, editWeight)">
                        <label :for="'cup-weight-' + cup.id">空杯／空瓶重量（g）</label>
                        <input :id="'cup-weight-' + cup.id" v-model.number="editWeight" type="number" inputmode="decimal" min="5" max="1995" step="0.1" required :disabled="!canManage || !manualCup" :aria-describedby="'cup-weight-tip-' + cup.id" />
                        <p :id="'cup-weight-tip-' + cup.id" class="field-help">填写不含水的容器重量，5–1995 g，保留一位小数。估计值会影响余水显示。</p>
                        <p class="form-guide">暂时拿开杯子或水瓶，保存成功后再放回，无需倒水。保存后自动使用此杯，首次放稳不记饮水或补水。</p>
                        <div class="command-actions"><button class="primary" :disabled="!canManage || !manualCup || cupPresent !== false || !validCupWeight(editWeight)">保存重量并使用</button><button type="button" class="quiet" :disabled="busy || pending" @click="editingWeight = null">取消</button></div>
                      </form>
                      <div v-else-if="deleting === cup.id" key="delete" class="cup-edit delete-confirm">
                        <strong>删除“{{ cup.name }}”？</strong>
                        <p class="setup-tip">饮水记录会保留。{{ cup.id === activeCupId ? '请先拿开杯子，删除后将使用下一只已保存的杯子。' : '' }}</p>
                        <div class="command-actions"><button class="danger" :disabled="!canManage || (cup.id === activeCupId && cupPresent !== false)" @click="runCup({ action: 'delete', cupId: cup.id })">确认删除</button><button class="quiet" :disabled="busy || pending" @click="deleting = null">保留杯子</button></div>
                      </div>
                    </Transition>
                  </div>
                </div>
              </div>
            </Transition>
          </li>
        </TransitionGroup>
        <div v-if="!cups!.length && !adding && !cupSetup" class="cup-empty"><strong>从你的第一只杯子开始</strong><p>空杯称量或手动填写重量，水杯、水瓶都可以。</p></div>
        <Transition name="setup-expand" @after-enter="newNameInput?.focus()">
          <div v-if="nextCupId && !cupSetup && adding" class="setup-reveal">
            <div class="setup-reveal-content">
              <form id="new-cup-form" class="new-cup-form" @submit.prevent="addCup">
                <div class="form-heading"><h4>添加新杯子</h4><span>保存后自动使用</span></div>
                <div class="cup-edit">
                  <label for="new-cup-name">杯子名称 <span>1–5 个汉字、字母或数字</span></label>
                  <input id="new-cup-name" ref="newNameInput" v-model="newName" maxlength="32" required placeholder="例如：保温杯、矿泉水" :disabled="!canManage" />
                  <fieldset class="cup-methods" :disabled="!canManage">
                    <legend>设置空杯重量</legend>
                    <div class="cup-method-options">
                      <label :class="{ selected: newMethod === 'weigh' }"><input v-model="newMethod" type="radio" name="cup-method" value="weigh" /><span>称量空杯</span></label>
                      <label :class="{ selected: newMethod === 'manual', unavailable: !manualCup }"><input v-model="newMethod" type="radio" name="cup-method" value="manual" :disabled="!manualCup" /><span>手动填写</span></label>
                    </div>
                  </fieldset>
                  <Transition name="setup-expand">
                    <div v-if="newMethod === 'manual'" class="setup-reveal">
                      <div class="setup-reveal-content">
                        <div class="weight-field"><label for="new-cup-weight">空杯／空瓶重量（g）</label><input id="new-cup-weight" v-model.number="newWeight" type="number" inputmode="decimal" min="5" max="1995" step="0.1" required :disabled="!canManage || !manualCup" placeholder="输入不含水的重量" aria-describedby="new-cup-weight-tip" /><p id="new-cup-weight-tip" class="field-help">5–1995 g，保留一位小数。估计值会影响余水显示。</p></div>
                      </div>
                    </div>
                  </Transition>
                  <p class="form-guide">{{ newMethod === 'manual' ? '暂时拿开瓶子，保存成功后再放回，无需倒水。首次放稳不记饮水或补水。' : '先拿开原来的杯子。点击开始设置，等待杯垫暂停记录后，再放上新空杯称量。' }}</p>
                  <div class="command-actions"><button class="primary" :disabled="!canManage || cupPresent !== false || !validCupName(newName.trim()) || (newMethod === 'manual' && (!manualCup || !validCupWeight(newWeight)))"><span v-if="pending && !uncertain && !checkingStopped" class="command-spinner button-spinner" aria-hidden="true"></span>{{ pending ? pendingText : newMethod === 'manual' ? '保存重量并使用' : '开始称量空杯' }}</button><button type="button" class="quiet" :disabled="busy || pending" @click="toggleAdd">取消添加</button></div>
                </div>
              </form>
            </div>
          </div>
        </Transition>
        <p v-if="!cupSetup" class="cup-switch-tip">{{ nextCupId ? '' : '杯子已满，可在“管理”中删除后添加。' }}切换前请先拿开杯子，也可双击 BOOT 切换。</p>
      </template>
      <template v-else>
        <p class="setup-tip">放上日常使用的空杯，静置至少 3 秒后保存。升级至 0.8.1 或更新固件，可管理 3 只杯子并手动填写空杯重量。</p>
        <button class="primary" :disabled="!canSetCup" @click="setCup">{{ pending ? '正在等待设置结果…' : '记住这个杯子' }}</button>
      </template>
      <Transition name="setup-form" mode="out-in">
        <div v-if="pending" key="pending" class="command-progress" role="status" aria-live="polite">
          <span class="command-spinner" :class="{ paused: uncertain || checkingStopped }" aria-hidden="true"></span>
          <div class="command-progress-copy"><strong>{{ pendingText }}</strong><p>{{ command?.request?.action === 'manual' ? '请保持杯垫空置，保存成功后再放回杯子。' : '请保持当前状态，关闭设置后仍可回来查询。' }}</p><div class="command-actions"><button class="quiet" :disabled="busy" @click="queryCommand">查询设置结果</button><button v-if="uncertain" class="quiet" :disabled="busy || !online" @click="submitCommand">重试同一次请求</button></div></div>
        </div>
        <div v-else-if="!platform.mobile && feedback" key="success" class="command-success" role="status"><strong>杯垫已确认</strong><p>{{ feedback }}</p></div>
      </Transition>
      <div v-if="!platform.mobile && error" class="notice error" role="alert">{{ error }}</div>
      <div class="device-reading" aria-label="称重状态">
        <div><span>当前总重</span><strong>{{ online && weightGrams != null ? weightGrams.toFixed(1) : '—' }} <small>g</small></strong></div>
        <div><span>当前空杯重量</span><strong>{{ emptyCupGrams != null ? emptyCupGrams.toFixed(1) : '—' }} <small>g</small></strong></div>
        <p v-if="!multiCup || !online">{{ cupLabel }}{{ !online ? ' · 上次同步' : '' }}</p>
      </div>
    </section>
  </section>
</template>

<style scoped>
.setup-panel { padding:0 var(--settings-inline-padding, 28px) 20px; }
.device-summary { display:flex; justify-content:space-between; align-items:center; gap:16px; padding-bottom:26px; }
.device-summary > div { display:flex; flex-wrap:wrap; gap:4px 8px; min-width:0; font-size:12px; color:#7c8780; }
.device-summary strong { color:#68766d; font-weight:400; overflow-wrap:anywhere; }
.connection-badge { flex-shrink:0; padding:0; background:none; color:#7c8780; font-size:11px; font-weight:400; }
.connection-badge.online { background:none; color:#4b7c61; }
.setup-alert { padding:12px 14px; margin-bottom:20px; background:#faf6ec; color:#79663e; border-radius:8px; font-size:13px; line-height:1.7; }
.setup-alert.error { background:#fff4f0; color:#984b36; }
.cup-setup { display:grid; gap:16px; }
.cup-section-heading { display:flex; justify-content:space-between; align-items:center; gap:16px; }
.cup-title-row { display:flex; align-items:center; gap:10px; }
h3 { margin:0; font-size:18px; font-weight:600; letter-spacing:0; color:#25372d; }
.cup-count { color:#8a948d; font-size:12px; font-variant-numeric:tabular-nums; }
.cup-section-heading p { margin:7px 0 0; color:#78847b; font-size:12px; }
button { display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:9px 16px; min-height:40px; background:#edf4ef; border:1px solid transparent; border-radius:999px; color:#426951; font-size:13px; font-weight:500; line-height:1.4; transition:background .16s ease,box-shadow .16s ease,color .16s ease,transform .16s ease; }
button:not(:disabled):hover { filter:none; }
button.primary { background:linear-gradient(180deg,#4b8065,#35634d); color:#fff; box-shadow:inset 0 1px 0 #ffffff29,0 2px 5px #244b3526; }
button.quiet { background:#f0f4f1; color:#6e7e72; }
button.quiet.selected { background:#e3eee6; color:#356349; }
button.danger { color:#a25e4e; background:#fbefea; }
button:focus-visible { outline:2px solid #6f9f82; outline-offset:3px; }
button:not(:disabled):active { transform:translateY(1px) scale(.98); box-shadow:none; }
.setup-panel button:disabled { opacity:1; color:#9aa99e; background:#f0f3f0; border-color:transparent; box-shadow:none; }
.add-cup-button { flex-shrink:0; padding-inline:16px 18px; }
.add-cup-button > svg { width:15px; height:15px; }
.add-label-short { display:none; }
.cup-list { position:relative; list-style:none; padding:0; margin:0; display:grid; }
.cup-card { min-width:0; background:#fff; }
.cup-card + .cup-card { border-top:1px solid #edf0ed; }
.cup-card,.cup-preparation-reveal { scroll-margin:84px 0 20px; }
.cup-card:focus-visible { outline:2px solid #6a9b7c; outline-offset:2px; border-radius:8px; }
.cup-card-main { display:flex; align-items:center; gap:14px; padding:16px 0; }
.cup-icon { display:grid; place-items:center; width:42px; height:46px; flex-shrink:0; border-radius:10px; background:#f3f5f3; color:#89998d; }
.cup-icon svg { width:29px; height:29px; }
.is-current .cup-icon { background:#edf4ee; color:#467958; }
.cup-card-info { flex:1; min-width:0; }
h4 { margin:0; font-size:15px; font-weight:600; color:#293c30; overflow-wrap:anywhere; }
.current-badge { display:inline-flex; align-items:center; gap:5px; color:#3d7653; font-size:11px; white-space:nowrap; padding:0 4px; }
.current-badge::before { content:''; width:5px; height:5px; border-radius:50%; background:currentColor; }
.cup-card-info p { margin:5px 0 0; color:#829087; font-size:12px; }
.cup-card-info p strong { padding-left:5px; color:#6c7b71; font-size:12px; font-weight:400; font-variant-numeric:tabular-nums; }
.cup-card-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex-shrink:0; }
.cup-switch { min-width:66px; padding:7px 12px; }
.cup-switch svg { width:13px; height:13px; }
.cup-more { width:40px; padding:0; border-radius:50%; }
.cup-more svg { width:18px; height:18px; fill:currentColor; }
.cup-more[aria-expanded=true] { background:#e3eee6; color:#356349; }
.cup-management { margin:0 0 12px; padding:10px 12px 14px; border-radius:10px; background:#f6f8f6; }
.cup-tools { display:flex; flex-wrap:wrap; gap:8px; }
.cup-tools button { padding:7px 13px; font-size:12px; background:#fff; }
.cup-tools button.selected { background:#e3eee6; }
.cup-tools button.danger { background:#fbefea; }
.cup-tools .danger { margin-left:auto; }
.cup-edit { display:grid; gap:10px; margin-top:16px; }
.cup-edit label,.cup-methods legend { color:#45584b; font-size:13px; font-weight:500; }
.cup-edit > label span { margin-left:5px; color:#839087; font-size:11px; font-weight:400; }
.cup-edit input:not([type=radio]) { width:100%; min-width:0; box-sizing:border-box; padding:11px 12px; border:1px solid #d6dfd8; border-radius:7px; font:inherit; font-size:14px; background:#fff; color:#263d35; }
.cup-edit input::placeholder { color:#9aa59d; }
.field-help { margin:0; font-size:12px; line-height:1.7; color:#7b887f; }
.form-guide { margin:4px 0; font-size:12px; line-height:1.8; color:#718176; }
.command-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.cup-edit .command-actions { margin-top:6px; }
.cup-preparation,.new-cup-form { padding:20px; border:1px solid #e2e8e2; border-radius:12px; background:#f8faf7; }
.form-heading { display:flex; align-items:center; justify-content:space-between; gap:10px; }
.form-heading span { color:#88958a; font-size:11px; }
.cup-methods { border:0; padding:0; margin:6px 0 0; min-width:0; }
.cup-methods legend { margin-bottom:8px; }
.cup-method-options { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; padding:4px; border-radius:8px; background:#eaf0e9; }
.cup-methods label { display:flex; align-items:center; justify-content:center; gap:7px; min-width:0; min-height:36px; border-radius:5px; cursor:pointer; color:#72806f; font-size:12px; }
.cup-methods label.selected { background:#fff; color:#345b3d; box-shadow:0 1px 3px #263d3512; }
.cup-methods label:focus-within { outline:2px solid #6a9b7c; outline-offset:1px; }
.cup-methods label.unavailable { opacity:.5; }
.cup-methods input { margin:0; accent-color:#43745d; flex-shrink:0; width:12px; height:12px; }
.weight-field { display:grid; gap:10px; padding-top:4px; }
.cup-switch-tip { margin:0; color:#8b968c; font-size:11px; line-height:1.8; }
.cup-empty { padding:26px 20px; border-radius:10px; background:#f7f9f6; text-align:center; color:#526d52; }
.cup-empty strong { font-size:14px; font-weight:500; }
.cup-empty p { margin:8px 0 0; font-size:12px; color:#7f8e7d; }
.section-eyebrow { font-size:11px; color:#788d71; }
.cup-preparation h4 { margin:8px 0 16px; font-size:18px; }
.setup-steps { list-style:none; display:flex; gap:8px; padding:0; margin:0 0 14px; counter-reset:step; }
.setup-steps li { flex:1; padding:8px 2px; border-bottom:2px solid #e1e8dc; color:#93a08b; font-size:11px; }
.setup-steps li::before { counter-increment:step; content:counter(step) ' · '; }
.setup-steps .done { color:#7a9071; border-color:#b4c8a9; }
.setup-steps .current { color:#3f6647; border-color:#628566; font-weight:600; }
.setup-tip { color:#788773; font-size:12px; line-height:1.8; margin:0; overflow-wrap:anywhere; }
.cup-preparation .setup-tip { margin-bottom:16px; }
.delete-confirm .setup-tip { color:#85685c; }
.command-progress { display:flex; align-items:flex-start; gap:12px; padding:14px; border-radius:9px; background:#f1f5ee; }
.command-spinner { width:18px; height:18px; flex-shrink:0; margin-top:1px; border:2px solid #cfddc8; border-top-color:#43745d; border-radius:50%; animation:cup-spin .9s linear infinite; }
.command-spinner.paused { animation:none; border-top-color:#a88545; }
.button-spinner { display:inline-block; width:12px; height:12px; margin:0 7px 0 0; vertical-align:text-bottom; border-color:#ffffff55; border-top-color:currentColor; }
.command-progress-copy { min-width:0; }
.command-progress strong,.command-success strong { font-size:13px; font-weight:500; }
.command-progress p,.command-success p { font-size:12px; line-height:1.8; margin:5px 0 8px; color:#72846b; }
.command-progress .command-actions button { min-height:32px; padding:5px 8px; font-size:12px; }
.command-success { padding:12px 14px; border-radius:9px; background:#f0f6ed; color:#4c714b; }
.command-success p { margin-bottom:0; }
.device-reading { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px 22px; padding-top:16px; border-top:1px solid #edf0eb; }
.device-reading > div { display:flex; justify-content:space-between; align-items:baseline; gap:8px; min-width:0; }
.device-reading span { color:#889584; font-size:11px; }
.device-reading strong { font-size:12px; font-weight:400; color:#65795e; font-variant-numeric:tabular-nums; white-space:nowrap; }
.device-reading small { color:#889584; font-size:11px; font-weight:400; }
.device-reading p { grid-column:1/-1; margin:0; color:#899585; font-size:11px; }
.notice { margin:0; }
.setup-reveal { display:grid; grid-template-rows:1fr; }
.setup-reveal-content { min-height:0; overflow:hidden; }
.setup-expand-enter-active,.setup-expand-leave-active { transition:grid-template-rows .26s ease,opacity .2s ease; }
.setup-expand-enter-from,.setup-expand-leave-to { grid-template-rows:0fr; opacity:0; }
.setup-form-enter-active,.setup-form-leave-active { transition:opacity .18s ease,transform .18s ease; }
.setup-form-enter-from,.setup-form-leave-to { opacity:0; transform:translateY(6px); }
.cup-card-enter-active { transition:opacity .35s ease,transform .35s cubic-bezier(.2,.75,.25,1); }
.cup-card-leave-active,.cup-card-move { transition:opacity .22s ease,transform .3s ease; }
.cup-card-enter-from { opacity:0; transform:translateY(14px) scale(.98); }
.cup-card-leave-to { opacity:0; transform:translateX(12px); }
.cup-card-leave-active { position:absolute; width:100%; box-sizing:border-box; }
@keyframes cup-spin { to { transform:rotate(360deg); } }
@media(hover:hover) {
  button:not(:disabled):hover { background:#e1ece4; }
  button.primary:not(:disabled):hover { background:linear-gradient(180deg,#558b6e,#3b7055); box-shadow:inset 0 1px 0 #ffffff29,0 3px 8px #244b3529; }
  button.quiet:not(:disabled):hover { background:#e6ede8; color:#426951; }
  button.danger:not(:disabled):hover { background:#f7e3da; color:#98523f; }
  button:not(:disabled):active { box-shadow:none; }
}
@media(max-width:560px) {
  .device-summary { gap:10px; padding-bottom:22px; }
  .cup-section-heading { gap:10px; }
  h3 { font-size:17px; }
  .cup-card-main { gap:10px; padding:12px 0; }
  .cup-icon { width:34px; height:38px; }
  .cup-icon svg { width:24px; height:24px; }
  .cup-card-actions { gap:8px; }
  .cup-setup button { position:relative; padding:7px 12px; font-size:12px; }
  .setup-panel .cup-setup button { min-height:36px; }
  /* 收紧可见按钮，向上下各扩展 4px，保留 44px 高的触控区域。 */
  .cup-setup button::after { content:''; position:absolute; inset:-5px -1px; }
  .cup-setup .add-cup-button { min-width:64px; gap:4px; box-shadow:inset 0 1px 0 #ffffff29,0 1px 3px #244b351a; }
  .add-cup-button > svg { width:13px; height:13px; }
  .add-label { display:none; }
  .add-label-short { display:inline; }
  .cup-setup .cup-switch { min-width:44px; padding:7px 10px; }
  .cup-switch svg { display:none; }
  .cup-setup .cup-more { width:36px; padding:0; background:transparent; }
  .cup-setup .cup-more::after { inset:-5px; }
  .cup-more svg { width:16px; height:16px; }
  .cup-setup .cup-more[aria-expanded=true] { background:#e3eee6; }
  .cup-setup .cup-more:disabled { background:transparent; }
  .cup-management { padding:10px 12px 14px; }
  .cup-tools { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
  .cup-tools .danger { margin-left:0; }
  .cup-preparation,.new-cup-form { padding:16px; }
  .cup-methods label { min-height:40px; }
  .form-heading { align-items:flex-start; }
  .cup-edit > label span { display:block; margin:5px 0 0; }
  .device-reading { gap:6px 16px; }
}
@media(prefers-reduced-motion:reduce) {
  button { transition:none; }
  button:not(:disabled):active { transform:none; }
  .setup-expand-enter-active,.setup-expand-leave-active,.setup-form-enter-active,.setup-form-leave-active,.cup-card-enter-active,.cup-card-leave-active,.cup-card-move { transition:none; }
  .command-spinner { animation:none; }
}
</style>
