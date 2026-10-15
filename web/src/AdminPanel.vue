<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { ApiError, errorMessage, request } from './api';
import { httpsOrigin } from './admin';

const emit = defineEmits<{ accessError: [cause: ApiError] }>();
interface Device { id: string; createdAt: number; bound: boolean; username: string | null }
interface Settings { serverUrl: string; configVersion: number; allowLocalHttp?: boolean }
const devices = ref<Device[]>([]);
const settings = ref<Settings | null>(null);
const origin = ref('');
const busy = ref(false);
const loading = ref(false);
const error = ref('');
const feedback = ref('');
let disposed = false;
let loadVersion = 0;
function failure(cause: unknown) {
  if (disposed) return;
  if (cause instanceof ApiError && cause.status === 401) emit('accessError', cause);
  else if (cause instanceof ApiError && cause.status === 403) error.value = '当前账号没有管理员权限，登录状态已保留。';
  else error.value = errorMessage(cause);
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
async function saveSettings() {
  if (busy.value || loading.value) return;
  error.value = '';
  feedback.value = '';
  let serverUrl: string;
  try { serverUrl = httpsOrigin(origin.value, settings.value?.allowLocalHttp); } catch (cause) { failure(cause); return; }
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
onBeforeUnmount(() => { disposed = true; ++loadVersion; });
</script>

<template>
  <main class="admin-main">
    <div class="page-heading"><div><p class="eyebrow">管理员</p><h1>设备与部署管理</h1><p class="page-description">维护配网地址、查看设备归属。新杯垫在首次绑定时自动登记。</p></div><button class="settings-button" :disabled="busy || loading" @click="load">{{ loading ? '读取中…' : '刷新状态' }}</button></div>
    <div v-if="error" class="notice error" role="alert">{{ error }}</div>
    <div v-if="feedback" class="notice success" role="status">{{ feedback }}</div>
    <div class="admin-grid">
      <section class="panel admin-wide"><h2>配网服务器设置</h2><p class="setup-description">新固件在首次绑定时自动注册，无需逐台登记或写入信任公钥。此地址用于杯垫联网后访问当前服务。</p>
        <form class="account-form" @submit.prevent="saveSettings"><label for="server-origin">{{ settings?.allowLocalHttp ? '服务器地址（支持局域网 HTTP）' : 'HTTPS 服务器地址' }}<input id="server-origin" v-model="origin" type="url" required :placeholder="settings?.allowLocalHttp ? 'http://192.168.1.10:3001' : 'https://water.example.com'" :disabled="busy || loading || !settings" /></label><button class="setup-action" :disabled="busy || loading || !settings">保存服务器地址</button></form>
        <p v-if="settings?.allowLocalHttp" class="setup-description">本地开发会自动选择唯一的局域网 IPv4 地址；多网卡时可在这里设置电脑与杯垫互通的地址。</p>
      </section>
      <section class="panel admin-wide"><div class="section-heading"><h2>已登记杯垫</h2><span class="record-count">{{ devices.length }} 台</span></div>
        <div class="table-scroll"><table><thead><tr><th>设备编号</th><th>登记时间</th><th>绑定状态</th><th>当前账号</th></tr></thead><tbody><tr v-for="device in devices" :key="device.id"><td>{{ device.id }}</td><td>{{ date(device.createdAt) }}</td><td>{{ device.bound ? '已绑定' : '未绑定' }}</td><td>{{ device.username ?? '—' }}</td></tr></tbody></table></div><p v-if="!devices.length" class="setup-description">{{ loading ? '正在读取设备…' : '暂无已登记设备。' }}</p>
      </section>
    </div>
  </main>
</template>

<style scoped>
.admin-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:24px; }
h2 { font-size:17px; }
.admin-wide { grid-column:1/-1; }
.table-scroll { overflow:auto; margin-top:18px; }
table { width:100%; border-collapse:collapse; font-size:13px; text-align:left; }
th,td { padding:12px 14px; border-bottom:1px solid #e5eadf; white-space:nowrap; }
th { color:#5d7568; font-weight:500; }
@media(max-width:760px) { .admin-grid { grid-template-columns:1fr; gap:18px; } }
</style>
