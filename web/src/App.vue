<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import DeviceSetup from './DeviceSetup.vue';
import DeviceOnboarding from './DeviceOnboarding.vue';
import AdminPanel from './AdminPanel.vue';
import { ApiError, errorMessage, request } from './api';
import { sameBinding, type Session } from './session';
import { platform } from './platform';
import { useNotice } from './notices';
import type { Dashboard, DrinkEvent } from '../../shared/dashboard';
import { dateInZone, dateWeekEnd, selectableDate, shiftDate, weekDates } from '../../shared/dates';
const props = withDefaults(defineProps<{ mobile?: boolean; active?: boolean; widgetBusy?: boolean }>(), { mobile: false, active: true, widgetBusy: false });
const emit = defineEmits<{ serviceSettings: []; addWidget: [] }>();
const session = ref<Session>({ user: null, deviceId: null, bindingId: null });
const page = ref<'dashboard' | 'add' | 'admin'>('dashboard');
const provisioningBusy = ref(false);
const unbindBusy = ref(false);
const unbindConfirm = ref(false);
const sessionLoading = ref(true);
const sessionError = ref('');
const authMode = ref<'login' | 'register'>('login');
const username = ref('');
const password = ref('');
const authBusy = ref(false);
const authError = ref('');
const bindingCode = ref('');
const bindingBusy = ref(false);
const bindingError = ref('');
const today = ref('');
const selectedDate = ref('');
const timeZone = ref('Asia/Shanghai');
const dashboard = ref<Dashboard | null>(null);
const dashboardError = ref('');
const actionError = ref('');
const feedback = ref('');
const revokePending = ref<string | null>(null);
const settingsDialog = ref<HTMLDialogElement | null>(null);
const settingsOpen = ref(false);
const menu = ref<'account' | 'settings' | null>(null);
const menuRoot = ref<HTMLElement | null>(null);
const accountButton = ref<HTMLButtonElement | null>(null);
const settingsButton = ref<HTMLButtonElement | null>(null);
const stripEnd = ref('');
const stripDates = computed(() => stripEnd.value ? weekDates(stripEnd.value) : []);
const menuBusy = computed(() => authBusy.value || bindingBusy.value || unbindBusy.value || provisioningBusy.value || Boolean(revokePending.value));
let dateSwipe: { id: number; x: number; y: number } | null = null;
let swipedUntil = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let pollingVersion: number | null = null;
let requestId = 0;
let sessionVersion = 0;
let disposed = false;

useNotice('web:session', () => sessionError.value, {
  enabled: () => props.mobile && props.active && !sessionLoading.value,
  action: () => ({ label: '重新连接', run: loadSession }),
});
useNotice('web:auth', () => authError.value, { enabled: () => props.mobile && props.active && !authBusy.value && !session.value.user });
useNotice('web:binding', () => bindingError.value === actionError.value ? '' : bindingError.value, {
  enabled: () => props.mobile && props.active && !bindingBusy.value && !authBusy.value,
});
useNotice('web:action', () => actionError.value, {
  enabled: () => props.mobile && props.active && !authBusy.value && !unbindBusy.value && !revokePending.value,
});
useNotice('web:feedback', () => feedback.value, { enabled: () => props.mobile && props.active });
useNotice('web:dashboard', () => dashboardError.value ? `${dashboardError.value}${dashboard.value ? ' · 下方保留上次成功同步的数据。' : ''}` : '', {
  enabled: () => props.mobile && props.active,
  action: () => ({ label: '刷新账号状态', run: loadSession }),
});

const isToday = computed(() => selectedDate.value === today.value);
const online = computed(() => Boolean(dashboard.value?.device?.online) && !dashboardError.value);
const needsFactoryService = computed(() => Boolean(dashboard.value?.device?.lastSeenAt) && dashboard.value?.device?.calibrated === false);
const needsCup = computed(() => dashboard.value?.device?.calibrated && dashboard.value.device?.emptyCupGrams === null);
const maximumMl = computed(() => Math.max(100, ...dashboard.value?.week.map(day => day.drinkMl) ?? []));
const estimateDescription = '清水按 1 g ≈ 1 ml 换算，倒水与喝水无法区分，喝完直接补水只记录净变化。';
const weightState = computed(() => {
  if (!session.value.deviceId) return '尚未绑定当前杯垫，历史记录仍可查看';
  if (!online.value) return '等待设备连接云端';
  if (dashboard.value?.device?.error) return dashboard.value.device?.error;
  if (!dashboard.value?.device?.calibrated) return '出厂标定未完成，请联系售后';
  if (dashboard.value.device?.emptyCupGrams === null) return '请设置日常使用的空杯';
  if (!dashboard.value.device?.cupPresent) return '杯子已取走';
  return dashboard.value.device?.stable ? '重量已稳定' : '等待重量稳定';
});

function resetDeviceState() {
  if (props.mobile) platform.notices?.clear('web:');
  // 账号变更使先前的读取失效，避免迟到的响应显示上一位用户的数据。
  ++sessionVersion;
  ++requestId;
  settingsDialog.value?.close();
  settingsOpen.value = false;
  unbindConfirm.value = false;
  provisioningBusy.value = false;
  dashboard.value = null;
  dashboardError.value = '';
  actionError.value = '';
  feedback.value = '';
  revokePending.value = null;
  today.value = '';
  selectedDate.value = '';
  stripEnd.value = '';
  closeMenu();
  timeZone.value = 'Asia/Shanghai';
  bindingCode.value = '';
  bindingError.value = '';
}

function invalidateSession(message = '登录已过期，请重新登录。') {
  resetDeviceState();
  session.value = { user: null, deviceId: null, bindingId: null };
  page.value = 'dashboard';
  authError.value = message;
  password.value = '';
}

function handleAccessError(cause: unknown) {
  if (!(cause instanceof ApiError) || cause.status !== 401) return false;
  invalidateSession();
  return true;
}

function handleSetupAccessError(cause: ApiError, userId: string, deviceId: string) {
  if (session.value.user?.id === userId && session.value.deviceId === deviceId) handleAccessError(cause);
}

async function loadSession() {
  sessionLoading.value = true;
  sessionError.value = '';
  const version = sessionVersion;
  try {
    const result = await request<Session>('/api/auth/session');
    if (disposed || version !== sessionVersion) return;
    resetDeviceState();
    session.value = result;
    page.value = !props.mobile && result.user?.role === 'admin' ? 'admin' : 'dashboard';
    if (result.user) void refresh();
  } catch (cause) {
    if (!disposed && version === sessionVersion) sessionError.value = `无法连接云端：${errorMessage(cause)}`;
  } finally {
    if (!disposed) sessionLoading.value = false;
  }
}

async function authenticate() {
  if (authBusy.value) return;
  authBusy.value = true;
  authError.value = '';
  const version = sessionVersion;
  try {
    const result = await request<Session>(`/api/auth/${authMode.value}`, { username: username.value.trim(), password: password.value });
    if (disposed || version !== sessionVersion) return;
    resetDeviceState();
    session.value = result;
    password.value = '';
    page.value = !props.mobile && result.user?.role === 'admin' ? 'admin' : 'dashboard';
    if (result.user) void refresh();
  } catch (cause) {
    if (!disposed && version === sessionVersion) authError.value = errorMessage(cause);
  } finally { authBusy.value = false; }
}

async function logout() {
  if (authBusy.value || bindingBusy.value || unbindBusy.value || provisioningBusy.value) return;
  authBusy.value = true;
  actionError.value = '';
  bindingError.value = '';
  const version = sessionVersion;
  try {
    const result = await request<{ message?: string }>('/api/auth/logout', {});
    if (disposed || version !== sessionVersion) return;
    invalidateSession('');
    if (props.mobile && result.message) platform.notices?.show({ source: 'web:logout', message: result.message });
  } catch (cause) {
    if (disposed || version !== sessionVersion) return;
    if (!handleAccessError(cause)) {
      const message = `退出失败：${errorMessage(cause)}`;
      actionError.value = message;
      bindingError.value = message;
    }
  } finally { authBusy.value = false; }
}

async function bindDevice() {
  if (bindingBusy.value || authBusy.value || provisioningBusy.value || !session.value.user || session.value.deviceId) return;
  bindingBusy.value = true;
  bindingError.value = '';
  const version = sessionVersion;
  const userId = session.value.user.id;
  try {
    const bound = await request<{ deviceId: string }>('/api/devices/bind', { code: bindingCode.value.trim() });
    const result = await request<Session>('/api/auth/session');
    if (disposed || version !== sessionVersion || session.value.user?.id !== userId) return;
    if (result.user?.id !== userId || result.deviceId !== bound.deviceId) throw new Error('绑定结果与当前账号不一致，请刷新确认。');
    resetDeviceState();
    session.value = result;
    page.value = 'dashboard';
    feedback.value = '杯垫已绑定。放上日常空杯并完成空杯设置，即可开始使用。';
    void refresh();
  } catch (cause) {
    if (disposed || version !== sessionVersion || session.value.user?.id !== userId) return;
    if (handleAccessError(cause)) return;
    bindingError.value = errorMessage(cause);
    // 绑定可能已提交但响应丢失，查询账号归属恢复页面，不重复消费绑定码。
    try {
      const result = await request<Session>('/api/auth/session');
      if (disposed || version !== sessionVersion || session.value.user?.id !== userId) return;
      if (!result.user) { invalidateSession(); return; }
      if (result.user.id !== userId) { invalidateSession('账号已在其他页面变更，请重新登录。'); return; }
      if (result.deviceId) {
        resetDeviceState();
        session.value = result;
        page.value = 'dashboard';
        feedback.value = '已确认杯垫绑定成功。放上日常空杯并完成空杯设置，即可开始使用。';
        void refresh();
      }
    } catch (recoveryError) {
      if (disposed || version !== sessionVersion || session.value.user?.id !== userId) return;
      if (!handleAccessError(recoveryError)) bindingError.value = '暂时无法确认绑定结果，请恢复网络后刷新页面查看。';
    }
  } finally { bindingBusy.value = false; }
}

function provisioningCompleted(result: Session) {
  if (!session.value.user || result.user?.id !== session.value.user.id) return;
  resetDeviceState();
  session.value = result;
  page.value = 'dashboard';
  feedback.value = '杯垫已持久保存配置，配网完成。';
  void refresh();
}

async function unbind() {
  if (!unbindConfirm.value || unbindBusy.value || !session.value.deviceId || !session.value.user) return;
  const target = { ...session.value };
  const version = sessionVersion;
  unbindBusy.value = true;
  actionError.value = '';
  let posted = false;
  try {
    const before = await request<Session>('/api/auth/session');
    if (disposed || version !== sessionVersion) return;
    if (!sameBinding(before, target)) throw new Error('账号或绑定批次已变化，请刷新页面后重新确认。');
    posted = true;
    await request('/api/devices/unbind', {});
    const result = await request<Session>('/api/auth/session');
    if (disposed || version !== sessionVersion) return;
    if (result.user?.id !== target.user?.id || result.deviceId !== null) throw new Error('当前绑定状态已变化，请刷新确认。');
    resetDeviceState();
    session.value = result;
    page.value = 'dashboard';
    feedback.value = '杯垫已解绑。账号仍保持登录，你自己的历史记录会保留。';
    void refresh();
  } catch (cause) {
    if (disposed || version !== sessionVersion || handleAccessError(cause)) return;
    actionError.value = `解绑${posted ? '结果尚未确认' : '失败'}：${errorMessage(cause)}`;
    if (posted) {
      try {
        const result = await request<Session>('/api/auth/session');
        if (disposed || version !== sessionVersion) return;
        if (result.user?.id === target.user?.id && result.deviceId === null) {
          resetDeviceState();
          session.value = result;
          page.value = 'dashboard';
          feedback.value = '已确认解绑成功，登录和历史记录已保留。';
          void refresh();
        }
      } catch (recovery) { if (version === sessionVersion) handleAccessError(recovery); }
    }
  } finally { unbindBusy.value = false; }
}

function number(value: number | undefined | null) {
  return value == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
}

async function openSettings() {
  if (menuBusy.value) return;
  closeMenu();
  settingsOpen.value = true;
  await nextTick();
  settingsDialog.value?.showModal();
  settingsDialog.value?.scrollTo(0, 0);
}

function time(value: string | null | undefined, withDate = false) {
  if (!value) return '尚未同步';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: dashboard.value?.timeZone ?? 'Asia/Shanghai',
    ...(withDate ? { year: 'numeric', month: '2-digit', day: '2-digit' } as const : {}),
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}

function shortDate(value: string) {
  const [, month, day] = value.split('-');
  return month && day ? `${Number(month)}/${Number(day)}` : '当日';
}

function weekday(value: string) {
  return ['日', '一', '二', '三', '四', '五', '六'][new Date(`${value}T00:00:00Z`).getUTCDay()];
}

function showEstimate() {
  platform.notices?.show({ source: 'web:estimate', message: `饮水量根据真实称重差值估算。${estimateDescription}` });
}

function selectDate(event: Event) {
  const input = event.target as HTMLInputElement;
  if (selectableDate(input.value, today.value)) changeDate(input.value);
  else input.value = selectedDate.value;
}

function changeDate(date: string) {
  if (!selectableDate(date, today.value)) return;
  stripEnd.value = dateWeekEnd(date, today.value);
  if (selectedDate.value === date) return;
  selectedDate.value = date;
  dashboard.value = null;
  dashboardError.value = '';
  void refreshDashboard();
}

function browseDates(direction: number) {
  if (!stripEnd.value) return;
  const end = shiftDate(stripEnd.value, direction * 7);
  if (end <= today.value) stripEnd.value = end;
}

function startDateSwipe(event: PointerEvent) {
  if (event.isPrimary) dateSwipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
}

function endDateSwipe(event: PointerEvent) {
  const start = dateSwipe;
  dateSwipe = null;
  if (!start || start.id !== event.pointerId) return;
  const dx = event.clientX - start.x;
  if (Math.abs(dx) < 40 || Math.abs(dx) <= Math.abs(event.clientY - start.y)) return;
  browseDates(dx > 0 ? -1 : 1);
  swipedUntil = Date.now() + 300;
}

function selectStripDate(date: string, event: MouseEvent) {
  if (event.detail && Date.now() < swipedUntil) return;
  changeDate(date);
}

function closeMenu(restoreFocus = false) {
  const button = menu.value === 'account' ? accountButton.value : settingsButton.value;
  menu.value = null;
  if (restoreFocus) button?.focus();
}

function menuAction(action: 'service' | 'widget' | 'device' | 'logout') {
  if (menuBusy.value) return;
  closeMenu();
  if (action === 'service') emit('serviceSettings');
  else if (action === 'widget' && !props.widgetBusy) emit('addWidget');
  else if (action === 'logout') void logout();
  else if (action === 'device') {
    if (session.value.deviceId) void openSettings();
    else { page.value = page.value === 'add' ? 'dashboard' : 'add'; void refresh(); }
  }
}

function outsideMenu(event: PointerEvent) {
  if (menu.value && event.target instanceof Node && !menuRoot.value?.contains(event.target)) closeMenu();
}

function menuKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && menu.value) { closeMenu(true); event.preventDefault(); }
}

function updateToday() {
  if (!today.value) return;
  const date = dateInZone(timeZone.value);
  if (selectedDate.value === today.value && date !== today.value) {
    selectedDate.value = date;
    dashboard.value = null;
  }
  if (date !== today.value) stripEnd.value = dateWeekEnd(selectedDate.value, date);
  today.value = date;
}

async function refreshDashboard() {
  if (!session.value.user) return;
  const currentRequest = ++requestId;
  const version = sessionVersion;
  const date = selectedDate.value;
  try {
    const result = await request<Dashboard>(date ? `/api/dashboard?date=${encodeURIComponent(date)}` : '/api/dashboard');
    if (disposed || version !== sessionVersion || currentRequest !== requestId || date !== selectedDate.value) return;
    if ((result.device?.id ?? null) !== session.value.deviceId || (result.device?.bindingId ?? null) !== session.value.bindingId) {
      // Reconcile device/batch changes without treating permission changes as logout.
      if (provisioningBusy.value || page.value === 'add' || settingsOpen.value) {
        dashboardError.value = '绑定状态已变化，完成当前操作后请刷新账号状态。';
        return;
      }
      const current = await request<Session>('/api/auth/session');
      if (disposed || version !== sessionVersion || currentRequest !== requestId) return;
      if (current.user?.id !== session.value.user?.id) { invalidateSession(); return; }
      resetDeviceState();
      session.value = current;
      void refresh();
      return;
    }
    timeZone.value = result.timeZone;
    if (!today.value) {
      today.value = result.date;
      selectedDate.value = result.date;
      stripEnd.value = result.date;
    }
    dashboard.value = result;
    dashboardError.value = '';
  } catch (cause) {
    if (disposed || version !== sessionVersion || currentRequest !== requestId || date !== selectedDate.value) return;
    if (!handleAccessError(cause)) dashboardError.value = `云端同步失败：${errorMessage(cause)}`;
  }
}

async function refresh() {
  if (!props.active || !session.value.user || page.value === 'admin' || pollingVersion === sessionVersion) return;
  const version = sessionVersion;
  pollingVersion = version;
  updateToday();
  try { await refreshDashboard(); }
  finally { if (pollingVersion === version) pollingVersion = null; }
}

async function revoke(event: DrinkEvent) {
  if (revokePending.value || authBusy.value) return;
  const version = sessionVersion;
  revokePending.value = event.id;
  actionError.value = '';
  feedback.value = '';
  try {
    await request(`/api/events/${encodeURIComponent(event.id)}/revoke`, {});
    if (disposed || version !== sessionVersion) return;
    await refreshDashboard();
    if (version === sessionVersion) feedback.value = '该记录已撤销，页面会自动刷新统计。重复撤销不会重复扣减。';
  } catch (cause) {
    if (disposed || version !== sessionVersion) return;
    if (!handleAccessError(cause)) actionError.value = `撤销失败：${errorMessage(cause)}`;
  } finally {
    if (version === sessionVersion) revokePending.value = null;
  }
}

watch(() => props.active, active => { if (active) void refresh(); else closeMenu(); });

function back(event: Event) {
  if (event.defaultPrevented || !props.active) return;
  if (menu.value) { closeMenu(true); event.preventDefault(); }
  else if (settingsOpen.value) { settingsDialog.value?.close(); event.preventDefault(); }
  else if (page.value !== 'dashboard') { page.value = 'dashboard'; event.preventDefault(); void refresh(); }
}
onMounted(() => {
  if (props.mobile) window.addEventListener('companion-back', back);
  document.addEventListener('pointerdown', outsideMenu);
  document.addEventListener('keydown', menuKey);
  void loadSession();
  timer = setInterval(() => void refresh(), 5000);
});

onBeforeUnmount(() => {
  disposed = true;
  if (props.mobile) platform.notices?.clear('web:');
  window.removeEventListener('companion-back', back);
  document.removeEventListener('pointerdown', outsideMenu);
  document.removeEventListener('keydown', menuKey);
  clearInterval(timer);
  ++sessionVersion;
  ++requestId;
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" :href="mobile ? undefined : '/'" aria-label="水伴首页">
        <span class="brand-mark" aria-hidden="true"><span></span></span>
        <span>{{ mobile ? '饮水陪伴' : '水伴' }}<span v-if="!mobile" class="brand-subtitle">让每一口，都有迹可循</span></span>
      </a>
      <div v-if="mobile" ref="menuRoot" class="topbar-right mobile-navigation">
        <div v-if="session.user" class="menu-anchor">
          <button id="account-menu-button" ref="accountButton" class="menu-trigger account-trigger" :disabled="menuBusy" :aria-expanded="menu === 'account'" aria-controls="account-menu" @click="menu = menu === 'account' ? null : 'account'">
            <span>{{ session.user.username }}</span>
            <svg class="menu-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
          <div v-if="menu === 'account'" id="account-menu" class="dropdown-menu" aria-labelledby="account-menu-button"><button :disabled="menuBusy" @click="menuAction('logout')">退出登录</button></div>
        </div>
        <div class="menu-anchor">
          <button id="settings-menu-button" ref="settingsButton" class="menu-trigger" :disabled="menuBusy" :aria-expanded="menu === 'settings'" aria-controls="settings-menu" @click="menu = menu === 'settings' ? null : 'settings'">
            <span>设置</span>
            <svg class="menu-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false"><path d="m3 4.5 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
          <div v-if="menu === 'settings'" id="settings-menu" class="dropdown-menu" aria-labelledby="settings-menu-button">
            <button :disabled="menuBusy" @click="menuAction('service')">服务设置</button>
            <button v-if="session.user" :disabled="menuBusy" @click="menuAction('device')">{{ session.deviceId ? '杯垫设置' : page === 'add' ? '查看历史' : '添加杯垫' }}</button>
            <button :disabled="widgetBusy || menuBusy" @click="menuAction('widget')">{{ widgetBusy ? '正在添加…' : '添加桌面组件' }}</button>
          </div>
        </div>
      </div>
      <div v-else class="topbar-right">
        <span v-if="session.user" class="account-name">{{ session.user.username }}</span>
        <button v-if="!mobile && session.user?.role === 'admin'" class="settings-button" :disabled="provisioningBusy || bindingBusy" @click="page = page === 'admin' ? 'dashboard' : 'admin'; refresh()">{{ page === 'admin' ? '饮水记录' : '管理后台' }}</button>
        <button v-if="session.user && !session.deviceId" class="settings-button" :disabled="bindingBusy" @click="page = page === 'add' ? 'dashboard' : 'add'; refresh()">{{ page === 'add' ? '查看历史' : '添加杯垫' }}</button>
        <button v-if="session.user && session.deviceId" class="settings-button" :disabled="authBusy || unbindBusy" @click="openSettings">杯垫设置</button>
        <button v-if="session.user" class="text-button logout-button" :disabled="authBusy || bindingBusy || unbindBusy || provisioningBusy" @click="logout">{{ authBusy ? '请稍候…' : '退出登录' }}</button>
      </div>
    </header>

    <main v-if="sessionLoading || sessionError" class="welcome-main">
      <section class="panel account-panel" aria-live="polite">
        <h1>连接水伴云端</h1>
        <p class="setup-description">{{ sessionLoading ? '正在确认登录状态…' : mobile ? '暂时未连接云端，可重新连接。' : sessionError }}</p>
        <button v-if="!sessionLoading" class="setup-action" @click="loadSession">重新连接</button>
      </section>
    </main>

    <main v-else-if="!session.user" class="welcome-main">
      <section class="panel account-panel" aria-labelledby="account-title">
        <p class="eyebrow">你的饮水日常</p>
        <h1 id="account-title">{{ authMode === 'login' ? '登录水伴' : '创建水伴账号' }}</h1>
        <p class="setup-description">登录后绑定杯垫，在这里查看设备状态与饮水记录。</p>
        <form class="account-form" @submit.prevent="authenticate">
          <label for="account-name">账号<input id="account-name" v-model="username" required minlength="3" maxlength="32" autocomplete="username" title="3–32 位中文、字母、数字或下划线" :disabled="authBusy" /></label>
          <p class="field-help">3–32 位中文、字母、数字或下划线，英文字母不区分大小写。</p>
          <label for="account-password">密码<input id="account-password" v-model="password" type="password" required minlength="8" maxlength="128" :autocomplete="authMode === 'login' ? 'current-password' : 'new-password'" :disabled="authBusy" /></label>
          <p class="field-help">8–128 位，请妥善保存账号与密码。</p>
          <div v-if="!mobile && authError" class="notice error" role="alert">{{ authError }}</div>
          <button class="setup-action" :disabled="authBusy">{{ authBusy ? '请稍候…' : authMode === 'login' ? '登录' : '注册并登录' }}</button>
          <button type="button" class="text-button account-switch" :disabled="authBusy" @click="authMode = authMode === 'login' ? 'register' : 'login'; authError = ''">{{ authMode === 'login' ? '还没有账号？注册' : '已有账号？登录' }}</button>
        </form>
      </section>
    </main>

    <AdminPanel v-else-if="!mobile && session.user.role === 'admin' && page === 'admin'" :key="session.user.id" @access-error="handleAccessError" />

    <main v-else-if="!session.deviceId && page === 'add'" class="welcome-main">
      <section class="panel binding-panel" aria-labelledby="binding-title">
        <p class="eyebrow">连接杯垫</p><h1 id="binding-title">开启新的饮水日常</h1>
        <p class="setup-description">历史记录始终归你所有，<button class="text-button" @click="page = 'dashboard'; refresh()">返回查看自己的历史</button>。</p>
        <DeviceOnboarding :active="active" :key="session.user.id" :session="session" @completed="provisioningCompleted" @access-error="handleAccessError" @busy="provisioningBusy = $event" />
        <details class="legacy-setup">
        <summary>旧版热点配网与 8 位绑定码</summary>
        <p class="setup-description">热点页只能更换 Wi-Fi，不能设置服务器地址或设备信任。旧固件若尚未配置服务器，请联系管理员通过 USB 设置；无法通过此网页填入地址。</p>
        <ol class="connection-steps">
          <li><strong>为杯垫连接 Wi-Fi</strong><p>接通电源，连接屏幕显示的杯垫热点，密码也在屏幕上。若未出现热点，在杯垫启动后长按 BOOT 配网键 3 秒。</p><p>连接热点后，用浏览器打开 <a href="http://192.168.4.1" target="_blank" rel="noopener noreferrer">192.168.4.1 ↗</a>，选择家中的 2.4 GHz Wi-Fi 并输入密码。</p></li>
          <li><strong>确认连接云端</strong><p>等待屏幕显示 Wi-Fi 和云服务均已连接。将手机切回正常 Wi-Fi 或移动网络，再回到本网站。</p></li>
          <li><strong>输入屏幕上的绑定码</strong><p>绑定码为 8 位数字，5 分钟内有效。过期后重新连接杯垫热点，在配网页点击“获取/刷新绑定码”；若热点已关闭，长按 BOOT 配网键 3 秒重新开启。</p></li>
        </ol>
        <form class="account-form" @submit.prevent="bindDevice">
          <label for="binding-code">杯垫绑定码<input id="binding-code" v-model="bindingCode" required inputmode="numeric" pattern="[0-9]{8}" minlength="8" maxlength="8" autocomplete="off" placeholder="8 位数字" :disabled="bindingBusy || authBusy || provisioningBusy" /></label>
          <div v-if="!mobile && bindingError" class="notice error" role="alert">{{ bindingError }}</div>
          <button class="setup-action" :disabled="bindingBusy || authBusy || provisioningBusy || !/^[0-9]{8}$/.test(bindingCode)">{{ bindingBusy ? '正在绑定…' : '绑定杯垫' }}</button>
        </form>
        <p class="setup-description">绑定后无需再次连接热点。换 Wi-Fi 只需重新配网，账号绑定与历史记录会保留。</p>
        </details>
      </section>
    </main>

    <main v-else>
      <section v-if="!mobile" class="page-heading" aria-labelledby="page-title">
        <div><p class="eyebrow">你的饮水日常</p><h1 id="page-title">喝水这件小事，<span>慢慢养成。</span></h1><p class="page-description">通过杯垫重量变化，记录每一次饮水。</p></div>
        <div class="date-control"><label for="statistics-date">查看日期</label><button class="date-step" aria-label="前一天" :disabled="!today" @click="changeDate(shiftDate(selectedDate, -1))">‹</button><input id="statistics-date" :value="selectedDate" aria-label="查看统计日期" type="date" :max="today" :disabled="!today" @change="selectDate" /><button class="date-step" aria-label="后一天" :disabled="!today || isToday" @click="changeDate(shiftDate(selectedDate, 1))">›</button><button v-if="!isToday && today" class="text-button" @click="changeDate(today)">回到今天</button></div>
      </section>

      <section v-if="!session.deviceId" class="calibration-prompt" aria-labelledby="unbound-title">
        <div><h2 id="unbound-title">当前没有绑定杯垫</h2><p>你自己的历史饮水记录仍可按日期查看。添加杯垫后继续记录新的饮水日常。</p></div>
        <button class="setup-action" @click="page = 'add'">添加杯垫</button>
      </section>
      <section v-else-if="needsFactoryService" class="calibration-prompt" aria-labelledby="factory-prompt-title">
        <div><h2 id="factory-prompt-title">杯垫尚未完成出厂标定</h2><p>请联系售后处理，暂时无法记录饮水。你无需准备砝码或自行校准。</p></div>
      </section>
      <section v-else-if="needsCup" class="calibration-prompt" aria-labelledby="cup-prompt-title">
        <div><h2 id="cup-prompt-title">放上空杯，开始记录</h2><p>放上日常使用的空杯，静置至少 3 秒，然后在设置中记住这个杯子。</p></div>
        <button class="setup-action" @click="openSettings">设置空杯</button>
      </section>

      <div v-if="!mobile" class="estimate-note"><span class="note-icon" aria-hidden="true">i</span><p><strong>饮水量根据真实称重差值估算</strong> · {{ estimateDescription }}</p></div>
      <div v-if="!mobile && dashboardError" class="notice error" role="alert">{{ dashboardError }}<span v-if="dashboard"> · 下方保留上次成功同步的数据。</span> <button class="text-button" @click="loadSession">刷新账号状态</button></div>
      <div v-if="!mobile && actionError" class="notice error" role="alert">{{ actionError }}</div>
      <div v-if="!mobile && feedback" class="notice success" role="status">{{ feedback }}</div>

      <div class="dashboard-grid">
        <div class="main-column">
          <section class="summary-grid" aria-label="饮水统计">
            <article class="total-card">
              <div class="card-topline"><h2>{{ isToday ? '今日' : shortDate(selectedDate) }}饮水量</h2><button v-if="mobile" class="estimate-tag" aria-label="查看饮水量估算说明" @click="showEstimate">估算</button><span v-else class="estimate-tag">估算</span></div>
              <div class="total-number"><strong data-testid="drink-total">{{ number(dashboard?.totals.drinkMl) }}</strong><span>ml</span></div>
              <p>{{ mobile && !isToday ? `${selectedDate} · 历史记录` : '一口一口，积累你的日常。' }}</p>
              <slot v-if="mobile" name="companion" :dashboard="isToday ? dashboard : null" :session="session" :online="!dashboardError" />
              <svg v-if="!mobile || !isToday" class="water-art" viewBox="0 0 140 135" fill="none" aria-hidden="true"><path d="M32 10h77l-8 110a7 7 0 0 1-7 6H47a7 7 0 0 1-7-6L32 10Z" stroke="currentColor" stroke-width="2"/><path d="M37 63c15-12 26 11 41 0 11-8 17-5 27-1l-4 58a7 7 0 0 1-7 6H47a7 7 0 0 1-7-6l-3-57Z" fill="currentColor" opacity=".28"/><path d="M37 63c15-12 26 11 41 0 11-8 17-5 27-1" stroke="currentColor" stroke-width="2"/><circle cx="75" cy="88" r="4" fill="currentColor" opacity=".7"/><circle cx="62" cy="105" r="2" fill="currentColor" opacity=".5"/></svg>
            </article>
            <article class="metric-card"><span class="metric-icon drink-icon" aria-hidden="true">↘</span><h2>饮水次数</h2><div class="metric-number"><strong data-testid="drink-count">{{ number(dashboard?.totals.drinkCount) }}</strong><span>次</span></div><p>有效取放记录</p></article>
            <article class="metric-card"><span class="metric-icon refill-icon" aria-hidden="true">↗</span><h2>补水量</h2><div class="metric-number"><strong data-testid="refill-total">{{ number(dashboard?.totals.refillMl) }}</strong><span>ml</span></div><p>单独统计，不计入饮水</p></article>
          </section>

          <section class="panel trend-panel" aria-labelledby="trend-title">
            <div class="section-heading"><div><h2 id="trend-title">{{ mobile ? '饮水趋势' : '近七日饮水趋势' }}</h2><p>{{ dashboard ? `${dashboard.week[0]?.date} — ${dashboard.date}` : '截至所选日期的七天' }}</p></div><div v-if="mobile" class="trend-date-actions"><label class="calendar-trigger">日历<input :value="selectedDate" aria-label="查看统计日期" type="date" :max="today" :disabled="!today" @change="selectDate" /></label><button v-if="!isToday && today" class="text-button" @click="changeDate(today)">今天</button></div><span v-else class="legend"><i></i>饮水量 / ml</span></div>
            <div v-if="mobile" class="date-strip" aria-label="按日期查看饮水记录">
              <button class="date-step" aria-label="前七天" :disabled="!today" @click="browseDates(-1)">‹</button>
              <div class="date-days" @pointerdown="startDateSwipe" @pointerup="endDateSwipe" @pointercancel="dateSwipe = null">
                <button v-for="date in stripDates" :key="date" :aria-label="`查看 ${date} 的饮水记录`" :aria-pressed="date === selectedDate" :class="{ selected: date === selectedDate }" @click="selectStripDate(date, $event)"><span>{{ date === today ? '今天' : weekday(date) }}</span><strong>{{ Number(date.slice(8)) }}</strong></button>
              </div>
              <button class="date-step" aria-label="后七天" :disabled="!today || stripEnd >= today" @click="browseDates(1)">›</button>
            </div>
            <div v-if="dashboard" class="chart" role="group" aria-label="近七日饮水量，点击柱形查看当天记录">
              <div class="chart-grid" aria-hidden="true"><span>{{ number(maximumMl) }}</span><span>{{ number(maximumMl / 2) }}</span><span>0</span></div>
              <div class="chart-columns"><button v-for="day in dashboard.week" :key="day.date" class="chart-column" :class="{ selected: day.date === selectedDate }" :aria-label="`${day.date} 饮水 ${number(day.drinkMl)} 毫升，查看当天记录`" :aria-pressed="day.date === selectedDate" @click="changeDate(day.date)"><span class="bar-space"><span class="bar-value">{{ number(day.drinkMl) }}</span><span class="bar" :class="{ zero: day.drinkMl === 0 }" :style="{ height: `${Math.max(day.drinkMl === 0 ? 1 : 3, day.drinkMl / maximumMl * 100)}%` }"></span></span><span class="bar-label">{{ day.date === today ? '今天' : shortDate(day.date) }}</span></button></div>
            </div>
            <div v-else class="loading-placeholder">{{ dashboardError ? '连接恢复后显示趋势' : '正在读取饮水趋势…' }}</div>
          </section>

          <section class="panel records-panel" aria-labelledby="records-title">
            <div class="section-heading"><div><h2 id="records-title">饮水记录</h2><p>{{ selectedDate }} · {{ mobile ? '饮水与补水明细' : '保留取放前后的重量，支持撤销误判' }}</p></div><span class="record-count">{{ dashboard?.events.length ?? '—' }} 条记录</span></div>
            <div v-if="!dashboard" class="empty-state"><span class="empty-icon" aria-hidden="true">≋</span><p>{{ dashboardError ? '暂时无法读取记录' : '正在读取记录…' }}</p></div>
            <div v-else-if="!dashboard.events.length" class="empty-state"><span class="empty-icon" aria-hidden="true">≋</span><h3>这一天还没有记录</h3><p>杯垫联网并完成空杯设置后，<br />饮水后放回杯子，重量稳定后记录会自动同步。</p></div>
            <ul v-else class="event-list">
              <li v-for="event in dashboard.events" :key="event.id" class="event-row" :class="{ revoked: event.revokedAt }">
                <span class="event-icon" :class="event.kind" aria-hidden="true">{{ event.kind === 'drink' ? '↘' : '↗' }}</span>
                <div class="event-info"><div class="event-title"><strong>{{ event.kind === 'drink' ? '饮水' : '补水' }}</strong><time :datetime="event.occurredAt">{{ time(event.occurredAt) }}</time><span v-if="event.revokedAt" class="revoked-label">已撤销</span></div><p>{{ number(event.beforeGrams) }} g <span aria-label="变为">→</span> {{ number(event.afterGrams) }} g</p></div>
                <div class="event-amount"><strong>{{ number(event.amountMl) }}</strong><span> ml</span></div>
                <button class="revoke-button" :disabled="Boolean(event.revokedAt) || Boolean(revokePending)" :aria-label="`撤销${time(event.occurredAt)}的${event.kind === 'drink' ? '饮水' : '补水'}记录`" @click="revoke(event)">{{ revokePending === event.id ? '撤销中…' : event.revokedAt ? '已撤销' : '撤销' }}</button>
              </li>
            </ul>
          </section>
        </div>

        <aside class="side-column" aria-label="称重设备">
          <section class="panel device-panel" aria-labelledby="device-title">
            <div class="section-heading"><h2 id="device-title">我的杯垫</h2><span class="connection-badge" :class="{ online }"><i></i>{{ online ? '云端在线' : '离线或未同步' }}</span></div>
            <div class="device-illustration" aria-hidden="true"><div class="cup"><div class="cup-handle"></div><div class="cup-water"></div></div><div class="coaster"><i :class="{ lit: online }"></i></div></div>
            <div class="weight-reading"><strong data-testid="device-weight">{{ number(online ? dashboard?.device?.weightGrams : null) }}</strong><span>g</span></div><p class="weight-state"><i :class="{ stable: online && dashboard?.device?.stable && !dashboard?.device?.error }"></i>{{ weightState }}</p>
            <dl class="device-details">
              <div><dt>设备</dt><dd>{{ dashboard?.device?.id ?? '—' }}</dd></div>
              <div><dt>最后同步</dt><dd>{{ time(dashboard?.device?.lastSeenAt, true) }}</dd></div>
              <div><dt>当前重量</dt><dd>杯子与水的总重</dd></div>
              <div><dt>空杯重量</dt><dd>{{ number(dashboard?.device?.emptyCupGrams) }} g</dd></div>
              <div><dt>待上传记录</dt><dd>{{ number(dashboard?.device?.pendingCount) }}</dd></div>
              <div><dt>固件版本</dt><dd>{{ dashboard?.device?.firmwareVersion ?? '—' }}</dd></div>
            </dl>
            <p v-if="online && !dashboard?.device?.clockSynced" class="queue-note">设备正在校时，记录会先保存在杯垫中。</p>
            <p v-if="dashboard?.device?.timePendingCount" class="queue-note">有 {{ dashboard.device?.timePendingCount }} 条记录时间待确认；保留在杯垫中，未计入每日统计。</p>
          </section>

        </aside>
      </div>
      <footer class="page-footer"><span><span class="footer-dot"></span>自动读取云端记录 · 离线时保留最近同步的数据</span><span>水伴 · {{ dashboard?.timeZone ?? 'Asia/Shanghai' }}</span></footer>
    </main>

    <dialog v-if="session.user && session.deviceId" ref="settingsDialog" class="settings-dialog" aria-labelledby="settings-title" @close="settingsOpen = false">
      <div class="settings-header">
        <div><h2 id="settings-title">杯垫设置</h2><p>设置日常空杯，或为杯垫更换 Wi-Fi。</p></div>
        <button class="settings-close" aria-label="关闭设置" @click="settingsDialog?.close()">✕</button>
      </div>
      <DeviceSetup :key="`${session.user.id}:${session.deviceId}:${session.bindingId}`" :online="online" :device-id="session.deviceId" :user-id="session.user.id" :binding-id="session.bindingId" :calibrated="dashboard?.device?.lastSeenAt ? dashboard.device.calibrated : undefined" :empty-cup-grams="dashboard?.device?.emptyCupGrams" :weight-grams="dashboard?.device?.weightGrams" :active="active && settingsOpen && !unbindBusy" @updated="refresh" @access-error="handleSetupAccessError" />
      <div class="settings-section">
        <DeviceOnboarding :key="`wifi:${session.user.id}:${session.deviceId}:${session.bindingId}`" :session="session" :active="active && settingsOpen && !unbindBusy" @completed="provisioningCompleted" @access-error="handleAccessError" @busy="provisioningBusy = $event" />
      </div>
      <section class="settings-section unbind-section">
        <h3>解绑杯垫</h3><p class="setup-description">解绑后杯垫可交给其他账号使用，当前配网授权与未完成命令会作废。你的登录和历史饮水记录会保留。</p>
        <button v-if="!unbindConfirm" class="settings-button" :disabled="provisioningBusy" @click="unbindConfirm = true">解绑我的杯垫</button>
        <div v-else class="unbind-confirm" role="group" aria-label="确认解绑当前杯垫">
          <p>确认解绑 {{ session.deviceId }}？</p>
          <button class="settings-button" :disabled="unbindBusy" @click="unbindConfirm = false">暂不解绑</button>
          <button class="setup-action" :disabled="unbindBusy || provisioningBusy" @click="unbind">{{ unbindBusy ? '正在确认…' : '确认解绑' }}</button>
        </div>
        <p v-if="!mobile && actionError" class="notice error" role="alert">{{ actionError }}</p>
      </section>
    </dialog>
  </div>
</template>

<style scoped>
.legacy-setup { border-top:1px solid #e5eadf; margin-top:24px; padding-top:20px; }
.legacy-setup summary { cursor:pointer; color:#43745d; font-weight:600; }
.settings-section { padding:22px var(--settings-inline-padding, 26px); border-top:1px solid #e5eadf; }
.unbind-section h3 { font-size:16px; }
.unbind-confirm { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
.unbind-confirm p { width:100%; }
.unbind-section .notice { margin-top:15px; }
</style>
