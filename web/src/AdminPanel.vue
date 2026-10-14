<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiError, errorMessage, request } from './api';
import { httpsOrigin, parseRegistry, type Registry } from './admin';

const emit = defineEmits<{ accessError: [cause: ApiError] }>();
interface Device { id: string; createdAt: number; bound: boolean; username: string | null }
interface Settings { serverUrl: string; configVersion: number; deploymentId: string | null; publicKey: string | null; signingReady: boolean }
const devices = ref<Device[]>([]);
const settings = ref<Settings | null>(null);
const origin = ref('');
const deviceId = ref('');
const token = ref('');
const registry = ref<Registry | null>(null);
const fileName = ref('');
const registryText = ref('');
const busy = ref(false);
const loading = ref(false);
const error = ref('');
const feedback = ref('');
let disposed = false;
let loadVersion = 0;
let fileVersion = 0;
function failure(cause: unknown, secret = false) {
  if (disposed) return;
  if (cause instanceof ApiError && cause.status === 401) emit('accessError', cause);
  else if (cause instanceof ApiError && cause.status === 403) error.value = '当前账号没有管理员权限，登录状态已保留。';
  else error.value = secret ? '登记未确认，请检查编号和凭证；冲突不会覆盖已有设备。可刷新列表或重新输入同一凭证重试。' : errorMessage(cause);
}
async function load() {
  if (loading.value || busy.value) return;
  const version = ++loadVersion;
  loading.value = true;
  error.value = '';
  const results = await Promise.allSettled([
    request<{ devices: Device[] }>('/api/admin/devices'), request<Settings>('/api/admin/settings'),
  ]);
  if (disposed || version !== loadVersion) return;
  const [registered, config] = results;
  if (registered.status === 'fulfilled') devices.value = registered.value.devices;
  else failure(registered.reason);
  if (config.status === 'fulfilled') { settings.value = config.value; origin.value = config.value.serverUrl; }
  else failure(config.reason);
  loading.value = false;
}
async function register() {
  if (busy.value || loading.value) return;
  busy.value = true;
  error.value = '';
  feedback.value = '';
  const secret = token.value;
  token.value = '';
  try {
    const result = await request<{ inserted: number; skipped: number }>('/api/admin/devices', { id: deviceId.value.trim(), token: secret });
    if (!disposed) feedback.value = `登记完成：新增 ${result.inserted} 台，已有相同凭证 ${result.skipped} 台。`;
  } catch (cause) { failure(cause, true); }
  finally { busy.value = false; }
  if (!disposed && !error.value) await load();
}
async function selectFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  registry.value = null;
  fileName.value = '';
  const version = ++fileVersion;
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('清单文件不能超过 2 MB，请分批导入。');
    const parsed = parseRegistry(await file.text());
    if (disposed || version !== fileVersion) return;
    registry.value = parsed;
    fileName.value = file.name;
    error.value = '';
  } catch (cause) { if (version === fileVersion) failure(cause); }
}
function validateText() {
  ++fileVersion;
  registry.value = null;
  try {
    if (new TextEncoder().encode(registryText.value).length > 2 * 1024 * 1024) throw new Error('清单不能超过 2 MB，请分批导入。');
    registry.value = parseRegistry(registryText.value);
    fileName.value = '粘贴的 JSON 清单';
    registryText.value = '';
    error.value = '';
  } catch (cause) { failure(cause); }
}
async function importDevices() {
  if (!registry.value || busy.value || loading.value) return;
  busy.value = true;
  error.value = '';
  feedback.value = '';
  try {
    const result = await request<{ inserted: number; skipped: number }>('/api/admin/devices/import', registry.value, 20000);
    if (!disposed) {
      feedback.value = `清单导入完成：新增 ${result.inserted} 台，跳过 ${result.skipped} 台。`;
      registry.value = null;
      fileName.value = '';
    }
  } catch (cause) { failure(cause); }
  finally { busy.value = false; }
  if (!disposed && !error.value) await load();
}
async function saveSettings() {
  if (busy.value || loading.value) return;
  error.value = '';
  feedback.value = '';
  let serverUrl: string;
  try { serverUrl = httpsOrigin(origin.value); } catch (cause) { failure(cause); return; }
  busy.value = true;
  try {
    const result = await request<Settings>('/api/admin/settings', { serverUrl });
    if (!disposed) {
      settings.value = result;
      origin.value = result.serverUrl;
      feedback.value = '服务器地址已保存，之后签发的配网授权将使用此地址。';
    }
  } catch (cause) { failure(cause); }
  finally { busy.value = false; }
}
function date(value: number) {
  return Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
}
onMounted(() => void load());
onBeforeUnmount(() => { disposed = true; ++loadVersion; ++fileVersion; token.value = ''; registry.value = null; });
</script>

<template>
  <main class="admin-main">
    <div class="page-heading"><div><p class="eyebrow">管理员</p><h1>设备与部署管理</h1><p class="page-description">登记设备身份、维护配网地址，无需先绑定杯垫。</p></div><button class="settings-button" :disabled="busy || loading" @click="load">{{ loading ? '读取中…' : '刷新状态' }}</button></div>
    <div v-if="error" class="notice error" role="alert">{{ error }}</div>
    <div v-if="feedback" class="notice success" role="status">{{ feedback }}</div>
    <div class="admin-grid">
      <section class="panel"><h2>登记单台杯垫</h2><p class="setup-description">输入已通过 USB 写入设备的编号和原始凭证。凭证只提交一次，云端不会返回明文。</p>
        <form class="account-form" autocomplete="off" @submit.prevent="register">
          <label for="register-device">设备编号<input id="register-device" v-model="deviceId" required pattern="coaster-(?!000000)[0-9]{6}" placeholder="coaster-000001" :disabled="busy || loading" /></label>
          <label for="device-token">设备原始凭证<input id="device-token" v-model="token" type="password" required maxlength="256" autocomplete="new-password" :disabled="busy || loading" /></label>
          <button class="setup-action" :disabled="busy || loading">登记设备</button>
        </form>
      </section>
      <section class="panel"><h2>导入登记清单</h2><p class="setup-description">使用导出的 version 1 JSON 清单，只接受设备编号、凭证哈希和登记时间。相同登记可重复导入，凭证冲突会整批拒绝。</p>
        <details class="paste-registry"><summary>或粘贴 JSON 清单</summary><label for="registry-text">登记清单 JSON</label><textarea id="registry-text" v-model="registryText" rows="6" spellcheck="false" :disabled="busy || loading" placeholder='{"version":1,"devices":[…]}'></textarea><button class="settings-button" :disabled="busy || loading || !registryText" @click="validateText">校验粘贴内容</button></details>
        <div class="account-form"><label for="registry-file">选择 JSON 文件<input id="registry-file" type="file" accept=".json,application/json" :disabled="busy || loading" @change="selectFile" /></label><p v-if="registry" class="setup-description">{{ fileName }} · 已校验 {{ registry.devices.length }} 台设备</p><button class="setup-action" :disabled="!registry || busy || loading" @click="importDevices">确认导入</button></div>
      </section>
      <section class="panel admin-wide"><h2>配网服务器设置</h2><p class="setup-description">地址仅管理员可见。目标须属于同一部署的数据与信任范围；修改地址不会迁移数据，也不会修改设备信任根。</p>
        <form class="account-form" @submit.prevent="saveSettings"><label for="server-origin">HTTPS 服务器源地址<input id="server-origin" v-model="origin" type="url" required placeholder="https://water.example.com" :disabled="busy || loading || !settings" /></label><button class="setup-action" :disabled="busy || loading || !settings">保存服务器地址</button></form>
        <dl v-if="settings" class="device-details admin-status"><div><dt>签名状态</dt><dd>{{ settings.signingReady ? '签名服务就绪' : '未就绪，请检查服务端密钥配置' }}</dd></div><div><dt>配置版本</dt><dd>{{ settings.configVersion }}</dd></div><div><dt>部署编号</dt><dd>{{ settings.deploymentId ?? '尚未配置' }}</dd></div><div><dt>设备信任公钥</dt><dd>{{ settings.publicKey || '尚未配置' }}</dd></div></dl>
        <p class="setup-description">签名私钥不通过网页配置。设备信任根需由管理员通过 USB 写入。</p>
      </section>
      <section class="panel admin-wide"><div class="section-heading"><h2>已登记杯垫</h2><span class="record-count">{{ devices.length }} 台</span></div>
        <div class="table-scroll"><table><thead><tr><th>设备编号</th><th>登记时间</th><th>绑定状态</th><th>当前账号</th></tr></thead><tbody><tr v-for="device in devices" :key="device.id"><td>{{ device.id }}</td><td>{{ date(device.createdAt) }}</td><td>{{ device.bound ? '已绑定' : '未绑定' }}</td><td>{{ device.username ?? '—' }}</td></tr></tbody></table></div><p v-if="!devices.length" class="setup-description">{{ loading ? '正在读取设备…' : '暂无已登记设备。' }}</p>
      </section>
    </div>
  </main>
</template>

<style scoped>
.paste-registry { margin:0 0 20px; color:#5d7568; }
.paste-registry summary { cursor:pointer; margin-bottom:12px; }
.paste-registry label { display:block; font-size:13px; }
.paste-registry textarea { width:100%; margin:8px 0 12px; border:1px solid #d8e1d5; border-radius:8px; padding:12px; resize:vertical; color:#263d35; font:13px monospace; }
.admin-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px; }
h2 { font-size:17px; }
.admin-wide { grid-column:1/-1; }
.admin-status { font-size:13px; }
.admin-status dd { max-width:75%; }
.table-scroll { overflow:auto; margin-top:18px; }
table { width:100%; border-collapse:collapse; font-size:13px; text-align:left; }
th,td { padding:12px 14px; border-bottom:1px solid #e5eadf; white-space:nowrap; }
th { color:#5d7568; font-weight:500; }
@media(max-width:760px) { .admin-grid { grid-template-columns:1fr; gap:18px; } .admin-status div { display:block; } .admin-status dd { max-width:100%; text-align:left; margin-top:6px; } }
</style>
