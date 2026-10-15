<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { ApiError, request } from './api';
import { BleTransport, bluetoothCompatibility, type BluetoothAccess } from './ble';
import { ProvisionFlow, type ProvisionState } from './provisioning';
import type { Session } from './session';

const props = defineProps<{ session: Session; active?: boolean }>();
const emit = defineEmits<{ completed: [session: Session]; accessError: [cause: ApiError]; busy: [value: boolean] }>();
const bluetooth = (navigator as Navigator & { bluetooth?: BluetoothAccess }).bluetooth;
const compatibility = bluetoothCompatibility(window.isSecureContext, bluetooth);
const ssid = ref('');
const password = ref('');
const manualWifi = ref(false);
const state = shallowRef<ProvisionState>();
const selectedNetwork = computed(() => manualWifi.value ? undefined : state.value?.wifiNetworks.find(network => network.ssid === ssid.value));
let flow: ProvisionFlow;
const transport = new BleTransport(bluetooth, {
  status: status => flow.receiveStatus(status),
  disconnected: () => flow.disconnected(),
  error: () => flow.transportError(),
});
flow = new ProvisionFlow({
  userId: props.session.user!.id,
  currentSession: () => props.session,
  transport,
  request,
  // Resolve sessionStorage lazily: browsers may throw even when accessing it.
  storage: {
    getItem: key => sessionStorage.getItem(key),
    setItem: (key, value) => sessionStorage.setItem(key, value),
    removeItem: key => sessionStorage.removeItem(key),
  },
  changed: value => { state.value = value; emit('busy', value.busy); },
  completed: session => emit('completed', session),
  unauthorized: cause => emit('accessError', cause),
});
state.value = { ...flow.state };
let timer: ReturnType<typeof setInterval> | undefined;
let selected = false;
function connect() {
  if (compatibility) return;
  selected = true;
  void flow.connect();
}
async function submit(resend = false) {
  if (state.value?.busy || (!manualWifi.value && !selectedNetwork.value)) return;
  const secret = password.value;
  password.value = '';
  if (resend) await flow.resend(ssid.value, secret);
  else await flow.start(ssid.value, secret);
}
function stop() { password.value = ''; flow.pause(); }
onMounted(() => {
  if (props.active !== false) void flow.poll(true);
  timer = setInterval(() => { if (props.active !== false) void flow.poll(); }, 2000);
});
watch(() => props.active, active => {
  if (active === false) stop();
  else void flow.poll(true);
});
watch(() => state.value?.info, info => {
  ssid.value = password.value = '';
  manualWifi.value = Boolean(info && !info.wifiScan);
});
watch(manualWifi, () => { ssid.value = password.value = ''; });
watch(ssid, () => { password.value = ''; });
watch(() => state.value?.wifiNetworks, networks => {
  if (!manualWifi.value && !networks?.some(network => network.ssid === ssid.value)) ssid.value = '';
});
onBeforeUnmount(() => { clearInterval(timer); password.value = ''; flow.dispose(); emit('busy', false); });
</script>

<template>
  <section v-if="state" class="onboarding" aria-labelledby="onboarding-title">
    <h2 id="onboarding-title">{{ session.deviceId ? '为我的杯垫更换 Wi-Fi' : '用蓝牙连接你的杯垫' }}</h2>
    <p class="setup-description">接通杯垫电源，长按 BOOT 配网键 3 秒，配网窗口开放 10 分钟。保持手机或电脑能够访问当前网站。</p>
    <p class="setup-tip">选择杯垫后，按系统提示确认配对，或输入杯垫屏幕上的配对码。系统蓝牙配对码与旧版的 8 位账号绑定码不同。</p>
    <div v-if="compatibility" class="notice error" role="status">{{ compatibility }}</div>
    <div class="command-actions">
      <button class="setup-action" :disabled="Boolean(compatibility) || state.busy" @click="connect">{{ state.connected ? '重新选择杯垫' : '选择杯垫' }}</button>
      <button v-if="selected && (!state.connected || flow.needsFreshConnection)" class="settings-button" :disabled="state.busy || Boolean(compatibility)" @click="flow.connect(true)">重连同一台杯垫</button>
    </div>
    <p v-if="state.info" class="setup-tip">已连接杯垫。{{ session.deviceId ? '本次更换 Wi-Fi，账号和历史记录保留。' : '首次绑定会自动注册设备，无需填写编号。' }}</p>
    <form v-if="state.connected && !state.complete" class="account-form wifi-form" autocomplete="off" @submit.prevent="submit()">
      <label v-if="!manualWifi" for="wifi-list">选择 2.4 GHz Wi-Fi
        <select id="wifi-list" v-model="ssid" required :disabled="state.busy || !state.wifiNetworks.length">
          <option disabled value="">{{ state.scanning ? '正在扫描附近的 Wi-Fi…' : '请选择 Wi-Fi' }}</option>
          <option v-for="network in state.wifiNetworks" :key="network.ssid" :value="network.ssid">
            {{ network.ssid }} · 信号{{ network.rssi >= -60 ? '强' : network.rssi >= -75 ? '中' : '弱' }}{{ network.secure ? '' : ' · 无需密码' }}
          </option>
        </select>
      </label>
      <label v-else for="wifi-ssid">2.4 GHz Wi-Fi 名称<input id="wifi-ssid" v-model="ssid" required maxlength="32" autocomplete="off" :disabled="state.busy" placeholder="输入 Wi-Fi 名称" /></label>
      <div class="wifi-actions">
        <button v-if="state.info?.wifiScan" type="button" class="settings-button" :disabled="state.busy || !flow.canScanWifi" @click="flow.scanWifi()">{{ state.scanning ? '正在扫描…' : '重新扫描' }}</button>
        <button v-if="state.info?.wifiScan" type="button" class="text-button" :disabled="state.busy" @click="manualWifi = !manualWifi">{{ manualWifi ? '返回 Wi-Fi 列表' : '隐藏网络？手动输入' }}</button>
      </div>
      <p v-if="state.scanning" class="field-help" role="status">杯垫正在扫描附近的 2.4 GHz Wi-Fi，请稍候。</p>
      <p v-else-if="state.scanError" class="notice error" role="alert">{{ state.scanError }}</p>
      <p v-else-if="!state.info?.wifiScan" class="field-help">当前杯垫固件暂不支持扫描。升级固件后可直接选择 Wi-Fi，目前可手动输入。</p>
      <p v-else-if="!manualWifi && !state.wifiNetworks.length" class="field-help">未发现可用网络，请确认路由器已开启 2.4 GHz Wi-Fi，再重新扫描。</p>
      <label for="wifi-password">Wi-Fi 密码<input id="wifi-password" v-model="password" type="password" maxlength="63" autocomplete="new-password" :required="selectedNetwork?.secure" :disabled="state.busy || selectedNetwork?.secure === false" :placeholder="selectedNetwork?.secure === false ? '此网络无需密码' : '开放网络留空'" /></label>
      <p class="field-help">密码只用于这次发送，不会保存到浏览器。请勿使用需要网页认证的网络。</p>
      <button v-if="flow.canStart" class="setup-action" :disabled="state.busy || !ssid">{{ state.scanning ? '正在扫描…' : state.busy ? '正在发送…' : session.deviceId ? '保存新的 Wi-Fi' : '配网并绑定杯垫' }}</button>
      <button v-else-if="flow.canResend" type="button" class="settings-button" :disabled="state.busy || !ssid" @click="submit(true)">重新输入密码后，重发同一次配置</button>
      <p v-else class="setup-tip">本次配网尚未确认，请先查询结果。重连或刷新页面不会自动发送配置。</p>
    </form>
    <div class="provision-status" aria-live="polite">
      <p v-if="state.message">{{ state.message }}</p>
    </div>
    <div v-if="state.error" class="notice error" role="alert">{{ state.error }}</div>
    <div v-if="state.complete" class="notice success" role="status">杯垫已联网并完成绑定。</div>
    <div class="command-actions">
      <button v-if="state.operation && !state.complete" class="settings-button" :disabled="state.busy" @click="flow.poll(true)">继续查询配网结果</button>
      <button v-if="state.busy || state.connected || (state.operation && !state.paused && !state.complete)" class="text-button" @click="stop">{{ state.operation ? '停止等待' : '取消连接' }}</button>
    </div>
    <p v-if="state.operation && !state.complete" class="setup-tip">停止等待或关闭页面不会撤销已发送的配置。蓝牙断开、等待超时或显示“已认领”均不代表配网完成；请以最终确认结果为准。</p>
  </section>
</template>

<style scoped>
.onboarding h2 { font-size:18px; }
.setup-tip { color:#5d7568; font-size:13px; line-height:1.8; margin:12px 0; }
.wifi-form { margin-top:20px; }
.wifi-form select { width:100%; min-width:0; min-height:44px; border:1px solid #d8e1d5; border-radius:8px; padding:10px 12px; background:#fff; color:#263d35; font:inherit; }
.wifi-actions { display:flex; flex-wrap:wrap; gap:12px; align-items:center; }
.command-actions { display:flex; flex-wrap:wrap; gap:12px; align-items:center; margin:14px 0; }
.provision-status { font-size:13px; color:#5d7568; line-height:1.8; margin:18px 0; overflow-wrap:anywhere; }
.device-details { font-size:12px; }
.notice { margin:16px 0; }
</style>
