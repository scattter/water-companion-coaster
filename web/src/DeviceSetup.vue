<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ApiError, errorMessage, request } from './api';
import { operationStorage, platform } from './platform';
import { useNotice } from './notices';
import { commandStorageKey, type Session } from './session';

const props = defineProps<{
  online: boolean;
  deviceId: string;
  userId: string;
  bindingId: string | null;
  calibrated?: boolean;
  emptyCupGrams?: number | null;
  weightGrams?: number | null;
  active: boolean;
}>();
const emit = defineEmits<{ updated: []; accessError: [cause: ApiError, userId: string, deviceId: string] }>();
interface Command {
  id: string;
  status: 'pending' | 'succeeded' | 'failed' | 'expired';
  message: string | null;
  expiresAt: number;
  bindingId: string | null;
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
  command.value = value;
  uncertain.value = false;
  error.value = '';
  if (value.status === 'pending') {
    try { operationStorage.setItem(storageKey, JSON.stringify(value)); }
    catch { error.value = '浏览器无法保存操作状态，请保持本页打开，直到确认结果。'; }
    return;
  }
  try { operationStorage.removeItem(storageKey); } catch { /* 已确认结果，不影响当前页面展示。 */ }
  if (value.status === 'succeeded') {
    feedback.value = '空杯设置成功，可以加水使用了。';
    emit('updated');
  } else {
    error.value = value.message || (value.status === 'expired' ? '设备未在有效期内确认操作。请确认联网后重新设置。' : '空杯设置失败，请保持空杯静置后重试。');
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
    const result = await request<{ command: Command }>('/api/control/cup', { id });
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
  if (!canSetCup.value) return;
  errorNotice.reset();
  try {
    rememberCommand({ id: crypto.randomUUID(), bindingId: props.bindingId, status: 'pending', message: null, expiresAt: Date.now() + 120000 });
  } catch {
    error.value = '浏览器无法保存操作状态。请允许此网站使用会话存储后重试，当前未发送设置请求。';
    errorNotice.show();
    return;
  }
  await submitCommand();
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
  <section class="panel setup-panel" aria-labelledby="setup-title">
    <div class="section-heading">
      <h2 id="setup-title">我的杯垫</h2>
      <span class="connection-badge" :class="{ online }" role="status"><i></i>{{ online ? '云端在线' : '离线或未同步' }}</span>
    </div>
    <p class="setup-tip">设备 {{ deviceId }}。杯垫联网后自动同步，无需与手机连接同一 Wi-Fi。</p>
    <p v-if="!online" class="setup-tip">请保持杯垫供电并连接 Wi-Fi，待云端显示在线后设置空杯。</p>
    <section class="cup-setup" aria-labelledby="cup-title">
      <h3 id="cup-title">日常空杯设置</h3>
      <p class="setup-tip">放上日常使用的空杯，静置至少 3 秒后点击“记住这个杯子”。无需输入重量；以后换杯时重复这一步。</p>
      <div class="device-reading">
        <span>当前总重 <strong>{{ online && weightGrams != null ? `${weightGrams.toFixed(1)} g` : '—' }}</strong></span>
        <span>已记住的空杯 <strong>{{ emptyCupGrams != null ? `${emptyCupGrams.toFixed(1)} g` : '尚未设置' }}</strong></span>
      </div>
      <p v-if="calibrated === false" class="notice error" role="alert">杯垫尚未完成出厂标定，请联系售后。你无需准备砝码或自行校准。</p>
      <p v-else-if="calibrated === undefined" class="setup-tip">正在读取杯垫状态…</p>
      <button class="primary" :disabled="!canSetCup" @click="setCup">{{ pending ? '正在等待设置结果…' : '记住这个杯子' }}</button>
      <p v-if="pending" class="setup-tip" role="status">等待杯垫确认，请保持空杯静置。关闭设置后可回来继续查询。</p>
      <div v-if="pending" class="command-actions">
        <button :disabled="busy" @click="queryCommand">{{ busy ? '正在确认…' : '查询设置结果' }}</button>
        <button v-if="uncertain" :disabled="busy || !online" @click="submitCommand">重试同一次请求</button>
      </div>
      <div v-if="!platform.mobile && error" class="notice error" role="alert">{{ error }}</div>
      <div v-if="!platform.mobile && feedback" class="notice success" role="status">{{ feedback }}</div>
    </section>
    <details class="network-settings">
      <summary><strong>兼容方式：通过热点更换 Wi-Fi</strong></summary>
      <ol class="setup-tip">
        <li>杯垫启动后，长按 BOOT 配网键 3 秒，热点开放 10 分钟。</li>
        <li>用手机连接屏幕显示的热点，密码也在屏幕上。</li>
        <li>打开下方配网页，选择新的 2.4 GHz Wi-Fi 并输入密码。</li>
        <li>等待杯垫屏幕显示 Wi-Fi 与云服务均已连接，再切回手机正常网络。</li>
      </ol>
      <a class="hotspot-link" href="http://192.168.4.1" target="_blank" rel="noopener noreferrer">连接杯垫热点后，打开配网页 ↗</a>
      <p class="setup-tip">热点页不能填写服务器地址或修改设备信任根。服务器尚未配置的旧固件需联系管理员通过 USB 设置。若浏览器拦截本地 HTTP 链接，请连接杯垫热点后在地址栏手动输入 192.168.4.1。</p>
      <p class="setup-tip">只更新 Wi-Fi，账号绑定、饮水记录和空杯设置都会保留，不需要重新绑定。新网络连接失败时，杯垫会尝试恢复原 Wi-Fi，你也可以重新进入配网。</p>
    </details>
  </section>
</template>

<style scoped>
.setup-panel { margin:0; padding:22px 26px; border:0; border-radius:0; }
.setup-panel > .section-heading h2 { font-size:17px; }
.setup-panel > .section-heading .connection-badge { font-size:12px; padding:5px 9px; }
.setup-tip { color:#5d7568; font-size:13px; line-height:1.8; margin:12px 0; overflow-wrap:anywhere; }
.setup-tip li { margin:8px 0; }
h3 { margin:0; font-size:15px; }
.cup-setup,.network-settings { border-top:1px solid #e5eadf; margin-top:20px; padding-top:20px; }
.device-reading { display:flex; flex-wrap:wrap; gap:10px 22px; padding:10px 0 18px; font-size:13px; }
button { padding:10px 15px; min-height:40px; background:#edf3e9; border:1px solid #d8e1d5; border-radius:8px; color:#263d35; font-size:13px; }
button.primary { background:#43745d; color:#fff; border-color:#43745d; }
.command-actions { display:flex; flex-wrap:wrap; gap:10px; }
.notice { margin:14px 0 0; }
summary { cursor:pointer; line-height:1.7; }
summary:focus-visible { outline:2px solid #43745d; outline-offset:3px; }
.hotspot-link { display:inline-flex; align-items:center; min-height:40px; color:#43745d; font-size:13px; text-decoration:underline; text-underline-offset:3px; }
@media(max-width:760px) { .setup-panel { padding:18px; } }
</style>
