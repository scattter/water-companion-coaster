<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { native, errorMessage, newerSnapshot } from './native';
import { amount, clockTime, dayLabel, deviceStatus, framePath, frameStyle, recentDrink, stateText } from './display';
import type { Page, Settings, Snapshot } from './types';
import HistoryView from './HistoryView.vue';
import CharacterPicker from './CharacterPicker.vue';
import { currentCup } from '../../shared/cups';

const snapshot = ref<Snapshot>({
  revision: 0,
  server: null,
  session: { user: null, deviceId: null, bindingId: null },
  dashboard: null,
  connection: 'unconfigured',
  error: null,
  lastSyncedAt: null,
  state: 'idle',
  drinkMl: null,
  frame: 0,
  settings: { autoRest: true, reminders: true, character: 'robot' },
});
const page = ref<Page>('dashboard');
const loading = ref(true);
const busy = ref(false);
const actionError = ref('');
const address = ref('');
const username = ref('');
const password = ref('');
const connectionFeedback = ref('');
const panel = ref<HTMLElement | null>(null);
const subscriptions: UnlistenFn[] = [];
let resizeObserver: ResizeObserver | undefined;
let panelHeight = 0;
let disposed = false;

const dashboard = computed(() => snapshot.value.dashboard);
const lastDrink = computed(() => recentDrink(dashboard.value));
const drinking = computed(() => snapshot.value.drinkMl != null);
const title = computed(() => drinking.value ? '本次饮水' : dayLabel(dashboard.value));
const intake = computed(() => drinking.value ? `+${amount(snapshot.value.drinkMl)}` : amount(dashboard.value?.totals.drinkMl));
const sprite = computed(() => framePath(snapshot.value.state, snapshot.value.frame, snapshot.value.settings.character));
const stateLabel = computed(() => stateText[snapshot.value.state]);
const signedIn = computed(() => Boolean(snapshot.value.session.user));
const stale = computed(() => snapshot.value.connection === 'offline' && dashboard.value !== null);
const status = computed(() => deviceStatus(snapshot.value));
const online = computed(() => snapshot.value.connection === 'online' && Boolean(dashboard.value?.device?.online));
const zone = computed(() => dashboard.value?.timeZone ?? 'Asia/Shanghai');
const shownError = computed(() => actionError.value || snapshot.value.error);

function applySnapshot(value: Snapshot) {
  if (disposed || newerSnapshot(snapshot.value, value) !== value) return;
  if (snapshot.value.server !== value.server || snapshot.value.session.user?.id !== value.session.user?.id) {
    password.value = '';
  }
  if (!address.value) address.value = value.server ?? '';
  snapshot.value = value;
}

function selectPage(value: Page) {
  page.value = value;
  actionError.value = '';
  connectionFeedback.value = '';
  if (value === 'settings') address.value = snapshot.value.server ?? '';
}

async function perform(operation: () => Promise<Snapshot | void>): Promise<boolean> {
  if (busy.value) return false;
  busy.value = true;
  actionError.value = '';
  try {
    const result = await operation();
    if (result) applySnapshot(result);
    return true;
  } catch (cause) {
    if (!disposed) actionError.value = errorMessage(cause);
    return false;
  } finally {
    if (!disposed) busy.value = false;
  }
}

async function connect() {
  const target = address.value.trim();
  if (!target) { actionError.value = '请填写服务器地址。'; return; }
  if (await perform(() => native.configure(target))) {
    address.value = snapshot.value.server ?? target;
    connectionFeedback.value = '连接成功，请登录你的账号。';
    page.value = 'dashboard';
  }
}

async function login() {
  const secret = password.value;
  if (!username.value.trim() || !secret) { actionError.value = '请填写用户名和密码。'; return; }
  try {
    if (await perform(() => native.login(username.value.trim(), secret))) connectionFeedback.value = '';
  } finally {
    password.value = '';
  }
}

async function logout() {
  if (await perform(native.logout)) {
    username.value = '';
    connectionFeedback.value = '';
    page.value = 'dashboard';
  }
}

async function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  await perform(() => native.settings({ ...snapshot.value.settings, [key]: value }));
}

function toggleSetting(key: 'autoRest' | 'reminders', event: Event) {
  const input = event.target as HTMLInputElement;
  const checked = input.checked;
  input.checked = snapshot.value.settings[key];
  void updateSetting(key, checked);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
  event.preventDefault();
  void native.hide().catch(cause => { actionError.value = errorMessage(cause); });
}

function resizePanel() {
  if (!panel.value || disposed) return;
  const height = Math.ceil(panel.value.getBoundingClientRect().height);
  if (height <= 0 || height === panelHeight) return;
  panelHeight = height;
  void native.resize(height).catch(cause => {
    panelHeight = 0;
    console.error('无法调整面板高度：', cause);
  });
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  resizeObserver = new ResizeObserver(resizePanel);
  if (panel.value) resizeObserver.observe(panel.value, { box: 'border-box' });
  try {
    const stopSnapshot = await native.onSnapshot(applySnapshot);
    if (disposed) { stopSnapshot(); return; }
    subscriptions.push(stopSnapshot);
    const stopPage = await native.onPage(selectPage);
    if (disposed) { stopPage(); return; }
    subscriptions.push(stopPage);
    applySnapshot(await native.snapshot());
  } catch (cause) {
    if (!disposed) actionError.value = `无法连接客户端：${errorMessage(cause)}`;
  } finally {
    if (!disposed) loading.value = false;
  }
});

onBeforeUnmount(() => {
  disposed = true;
  resizeObserver?.disconnect();
  window.removeEventListener('keydown', onKeydown);
  subscriptions.forEach(unsubscribe => unsubscribe());
  password.value = '';
});
</script>

<template>
  <main ref="panel" class="panel-shell" :aria-busy="busy || loading">
    <header class="panel-topbar">
      <div>
        <p class="brand">饮水陪伴</p>
        <p class="brand-caption">有水喝，有小伙伴</p>
      </div>
      <button v-if="page !== 'dashboard' && snapshot.server" class="quiet-button" :disabled="busy" @click="selectPage('dashboard')">返回</button>
      <button v-else-if="snapshot.server" class="quiet-button" :disabled="busy" @click="selectPage('settings')">设置</button>
    </header>

    <div v-if="loading" class="loading-state" role="status">正在连接你的饮水小伙伴…</div>

    <template v-else>
      <section v-if="!snapshot.server || page === 'settings'" class="settings-view">
        <h1>{{ snapshot.server ? '陪伴设置' : '先连接你的服务器' }}</h1>
        <p class="intro">{{ snapshot.server ? '让小伙伴按你的节奏陪伴。' : '填入已部署的饮水服务地址，登录后就能见到你的饮水记录。' }}</p>
        <form class="server-form" @submit.prevent="connect">
          <label for="server-address">服务器地址</label>
          <input id="server-address" v-model="address" type="text" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" placeholder="water.example.com 或 http://192.168.1.8:3001" :disabled="busy" required />
          <p class="field-hint">支持域名、IP 和端口。未填写协议时使用 HTTPS；无需添加 /api。</p>
          <p v-if="snapshot.server" class="field-hint">切换服务后需要重新登录。</p>
          <button class="primary-button" type="submit" :disabled="busy">{{ busy ? '正在处理…' : snapshot.server ? '连接并切换' : '连接服务器' }}</button>
        </form>

        <CharacterPicker :model-value="snapshot.settings.character" :disabled="busy" @update:model-value="updateSetting('character', $event)" />

        <fieldset v-if="snapshot.server" class="preferences" :disabled="busy">
          <legend>日常陪伴</legend>
          <label class="preference-row">
            <span><strong>自动工作与休息</strong><small>电脑空闲 5 分钟后打盹</small></span>
            <input type="checkbox" role="switch" :checked="snapshot.settings.autoRest" @change="toggleSetting('autoRest', $event)" />
          </label>
          <label class="preference-row">
            <span><strong>轻轻提醒喝水</strong><small>活跃 60 分钟未喝水时举瓶，不弹通知</small></span>
            <input type="checkbox" role="switch" :checked="snapshot.settings.reminders" @change="toggleSetting('reminders', $event)" />
          </label>
        </fieldset>
        <p v-if="snapshot.session.user" class="account-line">当前账号 <strong>{{ snapshot.session.user.username }}</strong><button class="text-button" :disabled="busy" @click="logout">退出登录</button></p>
      </section>

      <section v-else-if="!signedIn" class="login-view">
        <div class="welcome-scene"><img :src="sprite" :style="frameStyle(snapshot.settings.character)" alt="小伙伴在小桌前等你" draggable="false" /></div>
        <h1>见到你真好</h1>
        <p class="intro">登录已有账号，和小伙伴一起喝水。</p>
        <p v-if="connectionFeedback" class="feedback" role="status">{{ connectionFeedback }}</p>
        <form class="login-form" @submit.prevent="login">
          <label for="username">用户名</label>
          <input id="username" v-model="username" autocomplete="username" autocapitalize="none" spellcheck="false" :disabled="busy" required />
          <label for="password">密码</label>
          <input id="password" v-model="password" type="password" autocomplete="current-password" :disabled="busy" required />
          <button class="primary-button" type="submit" :disabled="busy">{{ busy ? '正在登录…' : '登录并开始陪伴' }}</button>
        </form>
        <button class="text-button registration-button" :disabled="busy" @click="perform(native.website)">还没有账号？前往网页注册</button>
        <p class="server-origin" :title="snapshot.server">{{ snapshot.server }}</p>
      </section>

      <HistoryView v-else-if="page === 'history'" :identity="`${snapshot.server}:${snapshot.session.user?.id}`" :time-zone="zone" />

      <section v-else class="dashboard-view">
        <div class="dashboard-summary">
          <div class="companion-summary">
            <div class="hero-scene"><img :src="sprite" :style="frameStyle(snapshot.settings.character)" alt="像素伙伴的陪伴小场景" draggable="false" /></div>
            <p class="state-label">{{ stateLabel }}</p>
          </div>
          <div class="intake-summary">
            <p class="eyebrow">{{ title }}</p>
            <div class="amount-window" aria-live="polite" aria-atomic="true">
              <Transition name="amount">
                <p :key="intake" class="hero-amount">{{ intake }}<span>ml</span></p>
              </Transition>
            </div>
            <p v-if="stale" class="stale-note">当前显示上次同步的数据</p>
          </div>
        </div>

        <dl class="drink-details">
          <div><dt>饮水次数</dt><dd>{{ dashboard ? dashboard.totals.drinkCount : '—' }}<span v-if="dashboard"> 次</span></dd></div>
          <div><dt>最近一次</dt><dd>{{ lastDrink ? `${clockTime(lastDrink.occurredAt, zone)} · ${amount(lastDrink.amountMl)} ml` : dashboard ? '当天暂无记录' : '正在同步' }}</dd></div>
          <div><dt>杯垫状态</dt><dd class="device-status"><span class="status-dot" :class="{ online }" aria-hidden="true"></span>{{ status }}</dd></div>
          <div><dt>当前杯子</dt><dd>{{ currentCup(dashboard?.device) }}{{ dashboard?.device && (!online || stale) ? '（上次同步）' : '' }}</dd></div>
        </dl>
        <div class="sync-row">
          <span>{{ snapshot.lastSyncedAt ? `同步于 ${clockTime(snapshot.lastSyncedAt, zone)}` : '等待首次同步' }}</span>
          <button class="text-button" :disabled="busy" @click="perform(native.refresh)">{{ busy ? '处理中…' : '刷新' }}</button>
        </div>
        <button class="secondary-button website-button" :disabled="busy || !dashboard" @click="selectPage('history')">饮水记录</button>
        <button class="text-button website-button" :disabled="busy" @click="perform(native.website)">{{ dashboard && !dashboard.device ? '前往网页绑定杯垫' : '打开网页与设备设置' }}</button>
      </section>

      <p v-if="shownError" class="error-message" role="alert">{{ shownError }}</p>
      <footer class="panel-footer">
        <span>慢慢喝，慢慢来</span>
        <button class="text-button" :disabled="busy" @click="perform(native.quit)">退出软件</button>
      </footer>
    </template>
  </main>
</template>
