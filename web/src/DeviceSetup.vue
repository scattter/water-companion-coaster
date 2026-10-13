<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { errorMessage, request } from './api';

const props = defineProps<{ online: boolean; deviceId?: string; initializing?: boolean; active: boolean }>();
const emit = defineEmits<{ calibrated: [] }>();
interface SetupOptions {
  ports: { path: string; manufacturer?: string }[];
  serverUrls: string[];
  deviceId: string;
}
interface UsbState {
  connected: boolean;
  path: string | null;
  device: {
    firmwareVersion: string;
    raw: number | null;
    weightGrams: number | null;
    stable: boolean;
    calibrated: boolean;
    emptyCupGrams: number;
    wifiConnected: boolean;
    serverConnected: boolean;
    ip: string;
    restartRequired: boolean;
    error: string | null;
  } | null;
}
const options = ref<SetupOptions>({ ports: [], serverUrls: [], deviceId: '' });
const usb = ref<UsbState>({ connected: false, path: null, device: null });
const wifiDevice = ref<UsbState['device']>(null);
const connectionError = ref('');
const path = ref('');
const serverUrl = ref('');
const ssid = ref('');
const password = ref('');
const grams = ref(500);
const busy = ref('');
const error = ref('');
const feedback = ref('');
const usbExpanded = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
let polling: Promise<void> | undefined;
let disposed = false;
const device = computed(() => usb.value.connected ? usb.value.device : wifiDevice.value);
const canOperate = computed(() => !busy.value && (usb.value.connected || (props.online && !!wifiDevice.value && !connectionError.value)));
const canConfigure = computed(() => usb.value.connected && !busy.value);
const weight = computed(() => device.value?.weightGrams == null ? '—' : `${device.value.weightGrams.toFixed(1)} g`);

async function loadOptions() {
  options.value = await request<SetupOptions>('/api/setup/options');
  if (!options.value.ports.some((port) => port.path === path.value)) {
    path.value = options.value.ports.length === 1 ? options.value.ports[0]!.path : '';
  }
  if (!options.value.serverUrls.includes(serverUrl.value)) {
    serverUrl.value = options.value.serverUrls.length === 1 ? options.value.serverUrls[0]! : '';
  }
}

async function poll() {
  if (!props.active || busy.value || polling || disposed) return;
  polling = (async () => {
    if (usbExpanded.value || usb.value.connected) {
      try {
        const state = await request<UsbState>('/api/setup/status');
        if (!disposed) {
          usb.value = state;
          if (state.path) path.value = state.path;
        }
      } catch (cause) {
        usb.value = { connected: false, path: null, device: null };
        error.value = errorMessage(cause);
      }
    }
    if (usb.value.connected) return;
    if (!props.online) { wifiDevice.value = null; connectionError.value = ''; return; }
    try {
      const state = await request<{ device: UsbState['device'] }>('/api/control/status');
      if (!disposed) {
        wifiDevice.value = state.device;
        connectionError.value = '';
      }
    } catch (cause) {
      if (!disposed) {
        wifiDevice.value = null;
        connectionError.value = errorMessage(cause);
      }
    }
  })();
  try { await polling; } finally { polling = undefined; }
}

async function act(label: string, action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = label;
  try {
    // 等待正在进行的状态读取结束，再发送无请求编号的固件命令。
    await polling;
    error.value = '';
    feedback.value = '';
    await action();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally { busy.value = ''; }
}

function connect() {
  return act('正在连接 USB…', async () => {
    usb.value = await request<UsbState>('/api/setup/connect', { path: path.value }, 25000);
    feedback.value = 'USB 已连接，可以配置 Wi-Fi 或进行校准。';
  });
}

function disconnect() {
  return act('正在断开 USB…', async () => {
    await request('/api/setup/disconnect', {});
    usb.value = { connected: false, path: null, device: null };
    feedback.value = 'USB 已断开，杯垫仍可通过 Wi-Fi 上报。';
  });
}

function configure() {
  return act('正在保存联网配置…', async () => {
    const result = await request<{ message: string }>('/api/setup/wifi', {
      ssid: ssid.value, password: password.value, serverUrl: serverUrl.value,
    }, 25000);
    password.value = '';
    usb.value = { connected: false, path: null, device: null };
    feedback.value = result.message;
  });
}

function calibrate(cmd: 'tare' | 'calibrate' | 'cup') {
  return act('正在等待校准确认…', async () => {
    const viaUsb = usb.value.connected;
    const result = await request<UsbState & { message: string }>(viaUsb ? '/api/setup/calibrate' : '/api/control/calibrate',
      cmd === 'calibrate' ? { cmd, grams: grams.value } : { cmd }, 15000);
    if (viaUsb) usb.value = result;
    else wifiDevice.value = result.device;
    feedback.value = result.message;
    emit('calibrated');
  });
}

function toggleUsb(event: Event) {
  usbExpanded.value = (event.currentTarget as HTMLDetailsElement).open;
  if (usbExpanded.value) void act('正在读取端口…', loadOptions).then(poll);
}

onMounted(() => {
  timer = setInterval(() => void poll(), 2000);
});
watch(() => [props.active, props.online], () => { void poll(); }, { immediate: true });
onBeforeUnmount(() => { disposed = true; clearInterval(timer); });
</script>

<template>
  <section class="panel setup-panel" aria-labelledby="setup-title">
    <div class="section-heading">
      <h2 id="setup-title">杯垫连接</h2>
      <span class="connection-badge" :class="{ online }" role="status"><i></i>{{ usb.connected ? 'USB 已连接' : online ? 'Wi-Fi 已连接' : '等待设备连接' }}</span>
    </div>
    <p v-if="online" class="setup-tip">设备 <strong>{{ deviceId }}</strong> 已连接，重量与饮水记录会自动同步，无需连接 USB。</p>
    <p v-else class="setup-tip">请保持杯垫供电，并让杯垫与电脑处于同一可互通的网络。设备连通电脑服务后，页面会自动显示。</p>

    <p v-if="online && !device && !connectionError" class="setup-tip">正在连接杯垫的无线校准…</p>
    <div v-if="connectionError && !usb.connected" class="notice error" role="alert">{{ connectionError }}<button class="refresh-status" :disabled="!!busy" @click="poll">刷新状态</button></div>
    <p v-if="busy" class="setup-progress" role="status">{{ busy }}</p>
    <div v-if="error" class="notice error" role="alert">{{ error }}</div>
    <div v-if="feedback" class="notice success" role="status">{{ feedback }}</div>

    <section class="calibration" aria-labelledby="calibration-title">
      <h3 id="calibration-title">称重与空杯设置</h3>
      <div v-if="device" class="usb-reading" aria-live="polite">
        <span>当前重量 <strong>{{ weight }}</strong></span>
        <span>原始读数 {{ device.raw ?? '未就绪' }}</span>
        <span>{{ device.calibrated ? '重量已校准' : '尚未完成首次校准' }}</span>
        <span>空杯 {{ device.emptyCupGrams >= 5 ? `${device.emptyCupGrams} g` : '未登记' }}</span>
        <span>Wi-Fi {{ device.wifiConnected ? `已连接 ${device.ip}` : '未连接' }}</span>
        <span>服务器 {{ device.serverConnected ? '已连接' : '未连接' }}</span>
      </div>
      <p v-if="device?.error" class="setup-tip">设备提示：{{ device.error }}</p>
      <p v-if="device?.restartRequired" class="setup-tip">联网设置尚未重启生效，请完成“保存并重启杯垫”。</p>
      <details class="first-setup" :open="initializing || device?.calibrated === false">
        <summary>首次设置 · 重量校准</summary>
        <p class="setup-tip">首次使用或更换传感器后做一次，校准值自动保存。已知重量可用另一台秤称准的空杯，不必专门准备砝码。每步静置至少 3 秒；重新归零会清除旧校准和空杯重量。</p>
        <div class="calibration-steps">
          <div><h4>1. 空载归零</h4><p>保留承重上盘，移走杯子及其他物品。</p><button :disabled="!canOperate" @click="calibrate('tare')">空载归零</button></div>
          <div><h4>2. 重量校准</h4><p>放上已知重量的物品，输入实际克数。</p><label for="calibration-grams">已知重量（g）<input id="calibration-grams" v-model.number="grams" type="number" min="50" max="2000" step="0.1" :disabled="!canOperate" /></label><button :disabled="!canOperate || !Number.isFinite(grams) || grams < 50 || grams > 2000" @click="calibrate('calibrate')">保存重量校准</button></div>
        </div>
      </details>
      <div class="cup-setup">
        <h4>{{ initializing ? '3. 登记空杯' : '空杯重量' }}</h4>
        <p class="setup-tip">放上日常空杯，静置至少 3 秒后更新，即可加水使用。以后换杯只需重复这一步。</p>
        <button class="primary" :disabled="!canOperate || !device?.calibrated" @click="calibrate('cup')">更新空杯重量</button>
      </div>
    </section>

    <details class="network-settings">
      <summary><strong>Wi-Fi 配网</strong></summary>
      <p class="setup-tip">更换网络时，用手机或这台电脑连接杯垫屏幕上的 Water- 热点（密码 12345678），再打开配网页。</p>
      <a class="hotspot-link" href="http://192.168.4.1" target="_blank" rel="noopener noreferrer">打开配网页 ↗</a>
    </details>

    <details class="usb-setup" @toggle="toggleUsb">
      <summary><strong>USB 备用设置</strong><span>{{ usb.connected ? 'USB 已连接' : '配网、后端配置与校准' }}</span></summary>
      <p class="setup-tip">首次配置电脑上报地址，或需要通过数据线校准时使用。插入 USB 数据线，并关闭 Arduino 串口监视器。</p>
      <div class="usb-controls">
        <label for="usb-port">开发板串口<select id="usb-port" v-model="path" :disabled="!!busy || usb.connected"><option value="" disabled>请选择开发板端口</option><option v-for="port in options.ports" :key="port.path" :value="port.path">{{ port.path }}{{ port.manufacturer ? ` · ${port.manufacturer}` : '' }}</option></select></label>
        <button :disabled="!!busy || usb.connected" @click="act('正在刷新端口…', loadOptions)">刷新端口</button>
        <button v-if="!usb.connected" class="primary" :disabled="!!busy || !path" @click="connect">连接 USB</button>
        <button v-else :disabled="!!busy" @click="disconnect">断开 USB</button>
      </div>
      <p v-if="!options.ports.length" class="setup-tip">未发现串口时，请检查数据线、开发板端口，再点击“刷新端口”。</p>

      <form class="wifi-form" @submit.prevent="configure">
        <h3>Wi-Fi 与后端配置</h3>
        <p class="setup-tip">使用 2.4 GHz 网络，与电脑处于同一可互通的局域网。设备编号 {{ options.deviceId || '—' }} 的凭证由后端自动写入。</p>
        <div class="wifi-fields">
          <label for="wifi-name">Wi-Fi 名称<input id="wifi-name" v-model="ssid" required maxlength="32" autocomplete="off" :disabled="!canConfigure" /></label>
          <label for="wifi-password">Wi-Fi 密码<input id="wifi-password" v-model="password" type="password" maxlength="63" autocomplete="off" placeholder="开放网络留空" :disabled="!canConfigure" /></label>
          <label for="server-address">电脑局域网地址<select id="server-address" v-model="serverUrl" required :disabled="!canConfigure"><option value="" disabled>选择与杯垫同网络的地址</option><option v-for="url in options.serverUrls" :key="url" :value="url">{{ url }}</option></select></label>
        </div>
        <p v-if="!options.serverUrls.length" class="setup-tip">未发现局域网地址，请先让电脑连接 Wi-Fi 或有线网络，再刷新端口。</p>
        <button class="primary" :disabled="!canConfigure || !ssid || !serverUrl">保存并重启杯垫</button>
      </form>

    </details>
  </section>
</template>

<style scoped>
.setup-panel { margin: 0; padding: 22px 26px; border: 0; border-radius: 0; }
.setup-panel > .section-heading h2 { font-size: 17px; }
.setup-panel > .section-heading .connection-badge { font-size: 12px; padding: 5px 9px; }
.hotspot-link { display: inline-flex; align-items: center; min-height: 40px; color: #43745d; font-size: 13px; text-decoration: underline; text-underline-offset: 3px; }
.refresh-status { display: block; margin-top: 10px; }
.usb-setup, .network-settings { border-top: 1px solid #e5eadf; margin-top: 18px; padding-top: 16px; }
summary { cursor: pointer; line-height: 1.7; }
summary strong { font-size: 14px; }
summary > span { margin-left: 18px; color: #5d7568; font-size: 13px; }
.setup-tip, .calibration-steps p { color: #5d7568; font-size: 13px; line-height: 1.7; margin: 12px 0; }
.usb-controls { display: flex; gap: 10px; align-items: end; flex-wrap: wrap; }
.usb-controls label { flex: 1; min-width: 200px; }
label { display: flex; flex-direction: column; gap: 7px; font-size: 13px; color: #4d6356; }
input, select { box-sizing: border-box; width: 100%; min-width: 0; height: 40px; border: 1px solid #d8e1d5; border-radius: 8px; padding: 8px 10px; background: #fff; color: #263d35; font: inherit; }
select:focus-visible, summary:focus-visible { outline: 2px solid #43745d; outline-offset: 3px; }
button { padding: 10px 15px; min-height: 40px; background: #edf3e9; border: 1px solid #d8e1d5; border-radius: 8px; font-size: 13px; white-space: nowrap; }
button.primary { background: #43745d; color: white; border-color: #43745d; }
.wifi-form, .calibration { border-top: 1px solid #e5eadf; margin-top: 22px; padding-top: 20px; }
h3, h4 { margin: 0; font-size: 15px; }
.wifi-fields, .calibration-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
.calibration-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.first-setup { margin-top: 18px; }
.cup-setup { margin-top: 20px; }
.wifi-form > button { margin-top: 14px; }
.calibration-steps > div { background: #f6f8f2; border-radius: 10px; padding: 16px; }
.calibration-steps label { margin-bottom: 12px; }
.usb-reading { display: flex; flex-wrap: wrap; gap: 10px 22px; padding: 12px 0; font-size: 13px; }
.setup-progress { color: #43745d; font-size: 13px; margin-top: 12px; }
.notice { margin-top: 14px; }
@media (max-width: 760px) {
  .setup-panel { padding: 18px; }
  summary > span { display: block; margin: 6px 0 0; }
  .wifi-fields, .calibration-steps { grid-template-columns: 1fr; }
  .usb-controls label { flex-basis: 100%; }
}
</style>
