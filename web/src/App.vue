<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import DeviceSetup from './DeviceSetup.vue';
import { errorMessage, request } from './api';

type EventKind = 'drink' | 'refill';
interface DrinkEvent {
  id: string;
  kind: EventKind;
  amountMl: number;
  beforeGrams: number;
  afterGrams: number;
  occurredAt: string;
  revokedAt: string | null;
}
interface Dashboard {
  date: string;
  timeZone: string;
  totals: { drinkMl: number; refillMl: number; drinkCount: number };
  week: { date: string; drinkMl: number }[];
  events: DrinkEvent[];
  device: {
    id: string;
    lastSeenAt: string | null;
    online: boolean;
    weightGrams: number | null;
    stable: boolean;
    cupPresent: boolean;
    source: 'hx711';
    calibrated: boolean;
    emptyCupGrams: number | null;
    pendingCount: number;
    timePendingCount: number;
    clockSynced: boolean;
    error: string | null;
    firmwareVersion: string | null;
  };
}
const today = ref('');
const selectedDate = ref('');
const timeZone = ref('Asia/Shanghai');
const dashboard = ref<Dashboard | null>(null);
const dashboardError = ref('');
const actionError = ref('');
const feedback = ref('');
const revokePending = ref<string | null>(null);
const settingsDialog = ref<HTMLDialogElement | null>(null);
const initializing = ref(false);
const settingsOpen = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
let polling = false;
let requestId = 0;

const isToday = computed(() => selectedDate.value === today.value);
const online = computed(() => Boolean(dashboard.value?.device.online) && !dashboardError.value);
const needsCalibration = computed(() => online.value && dashboard.value?.device.calibrated === false);
const maximumMl = computed(() => Math.max(100, ...dashboard.value?.week.map(day => day.drinkMl) ?? []));
const weightState = computed(() => {
  if (!online.value) return '等待设备连接';
  if (dashboard.value?.device.error) return dashboard.value.device.error;
  if (!dashboard.value?.device.calibrated) return '请先完成首次校准';
  if (dashboard.value.device.emptyCupGrams === null) return '请登记空杯重量';
  if (!dashboard.value?.device.cupPresent) return '杯子已取走';
  return dashboard.value.device.stable ? '重量已稳定' : '等待重量稳定';
});

function number(value: number | undefined | null) {
  return value == null ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
}

async function openSettings(calibration = false) {
  initializing.value = calibration;
  settingsOpen.value = true;
  await nextTick();
  settingsDialog.value?.showModal();
  settingsDialog.value?.scrollTo(0, 0);
}

function closeSettings() {
  settingsOpen.value = false;
  initializing.value = false;
}

function time(value: string | null | undefined) {
  if (!value) return '尚未同步';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: dashboard.value?.timeZone ?? 'Asia/Shanghai',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}

function shortDate(value: string) {
  const [, month, day] = value.split('-');
  return `${Number(month)}/${Number(day)}`;
}

function selectDate(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  changeDate(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : today.value);
}

function changeDate(date: string) {
  selectedDate.value = date;
  dashboard.value = null;
  void refreshDashboard();
}

function updateToday() {
  if (!today.value) return;
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone.value, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  if (selectedDate.value === today.value && date !== today.value) {
    selectedDate.value = date;
    dashboard.value = null;
  }
  today.value = date;
}

async function refreshDashboard() {
  const currentRequest = ++requestId;
  const date = selectedDate.value;
  try {
    const result = await request<Dashboard>(date ? `/api/dashboard?date=${encodeURIComponent(date)}` : '/api/dashboard');
    if (currentRequest !== requestId || date !== selectedDate.value) return;
    timeZone.value = result.timeZone;
    if (!today.value) {
      today.value = result.date;
      selectedDate.value = result.date;
    }
    dashboard.value = result;
    dashboardError.value = '';
  } catch (error) {
    if (currentRequest !== requestId || date !== selectedDate.value) return;
    dashboardError.value = `统计服务连接失败：${errorMessage(error)}`;
  }
}

async function refresh() {
  if (polling) return;
  updateToday();
  polling = true;
  try { await refreshDashboard(); } finally { polling = false; }
}

async function revoke(event: DrinkEvent) {
  if (revokePending.value) return;
  revokePending.value = event.id;
  actionError.value = '';
  feedback.value = '';
  try {
    await request(`/api/events/${encodeURIComponent(event.id)}/revoke`, {});
    await refreshDashboard();
    feedback.value = '该记录已撤销，页面会自动刷新统计。重复撤销不会重复扣减。';
  } catch (error) {
    actionError.value = `撤销失败：${errorMessage(error)}`;
  } finally {
    revokePending.value = null;
  }
}

onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 1500);
});

onBeforeUnmount(() => {
  clearInterval(timer);
  ++requestId;
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <a class="brand" href="/" aria-label="水伴首页">
        <span class="brand-mark" aria-hidden="true"><span></span></span>
        <span>水伴<span class="brand-subtitle">让每一口，都有迹可循</span></span>
      </a>
      <div class="topbar-right"><span class="mode-badge"><span></span>硬件联调</span><span class="local-label">本机工作台</span><button class="settings-button" @click="openSettings()">设置</button></div>
    </header>

    <main>
      <section class="page-heading" aria-labelledby="page-title">
        <div><p class="eyebrow">你的饮水日常</p><h1 id="page-title">喝水这件小事，<span>慢慢养成。</span></h1><p class="page-description">通过杯垫重量变化，记录每一次饮水。</p></div>
        <div class="date-control"><label for="statistics-date">查看日期</label><input id="statistics-date" :value="selectedDate" aria-label="查看统计日期" type="date" :max="today" :disabled="!today" @change="selectDate" /><button v-if="!isToday" class="text-button" @click="changeDate(today)">回到今天</button></div>
      </section>

      <section v-if="needsCalibration" class="calibration-prompt" aria-labelledby="calibration-prompt-title">
        <div><h2 id="calibration-prompt-title">开始记录前，先校准杯垫</h2><p>杯垫已连接。完成首次重量校准并登记空杯后，即可记录饮水。</p></div>
        <button class="setup-action" @click="openSettings(true)">开始校准</button>
      </section>

      <div class="estimate-note"><span class="note-icon" aria-hidden="true">i</span><p><strong>饮水量根据真实称重差值估算</strong> · 清水按 1 g ≈ 1 ml 换算，倒水与喝水无法区分，喝完直接补水只记录净变化。</p></div>
      <div v-if="dashboardError" class="notice error" role="alert">{{ dashboardError }}<span v-if="dashboard"> · 下方保留上次成功同步的数据。</span></div>
      <div v-if="actionError" class="notice error" role="alert">{{ actionError }}</div>
      <div v-if="feedback" class="notice success" role="status">{{ feedback }}</div>

      <div class="dashboard-grid">
        <div class="main-column">
          <section class="summary-grid" aria-label="饮水统计">
            <article class="total-card">
              <div class="card-topline"><h2>{{ isToday ? '今日' : shortDate(selectedDate) }}饮水量</h2><span class="estimate-tag">估算</span></div>
              <div class="total-number"><strong data-testid="drink-total">{{ number(dashboard?.totals.drinkMl) }}</strong><span>ml</span></div>
              <p>一口一口，积累你的日常。</p>
              <svg class="water-art" viewBox="0 0 140 135" fill="none" aria-hidden="true"><path d="M32 10h77l-8 110a7 7 0 0 1-7 6H47a7 7 0 0 1-7-6L32 10Z" stroke="currentColor" stroke-width="2"/><path d="M37 63c15-12 26 11 41 0 11-8 17-5 27-1l-4 58a7 7 0 0 1-7 6H47a7 7 0 0 1-7-6l-3-57Z" fill="currentColor" opacity=".28"/><path d="M37 63c15-12 26 11 41 0 11-8 17-5 27-1" stroke="currentColor" stroke-width="2"/><circle cx="75" cy="88" r="4" fill="currentColor" opacity=".7"/><circle cx="62" cy="105" r="2" fill="currentColor" opacity=".5"/></svg>
            </article>
            <article class="metric-card"><span class="metric-icon drink-icon" aria-hidden="true">↘</span><h2>饮水次数</h2><div class="metric-number"><strong data-testid="drink-count">{{ number(dashboard?.totals.drinkCount) }}</strong><span>次</span></div><p>有效取放记录</p></article>
            <article class="metric-card"><span class="metric-icon refill-icon" aria-hidden="true">↗</span><h2>补水量</h2><div class="metric-number"><strong data-testid="refill-total">{{ number(dashboard?.totals.refillMl) }}</strong><span>ml</span></div><p>单独统计，不计入饮水</p></article>
          </section>

          <section class="panel trend-panel" aria-labelledby="trend-title">
            <div class="section-heading"><div><h2 id="trend-title">近七日饮水趋势</h2><p>截至所选日期，每天的小小积累</p></div><span class="legend"><i></i>饮水量 / ml</span></div>
            <div v-if="dashboard" class="chart" role="img" :aria-label="dashboard.week.map(day => `${day.date} 饮水 ${day.drinkMl} 毫升`).join('；')">
              <div class="chart-grid" aria-hidden="true"><span>{{ number(maximumMl) }}</span><span>{{ number(maximumMl / 2) }}</span><span>0</span></div>
              <div class="chart-columns"><div v-for="day in dashboard.week" :key="day.date" class="chart-column" :class="{ selected: day.date === selectedDate }"><div class="bar-space"><span class="bar-value">{{ number(day.drinkMl) }}</span><div class="bar" :class="{ zero: day.drinkMl === 0 }" :style="{ height: `${Math.max(day.drinkMl === 0 ? 1 : 3, day.drinkMl / maximumMl * 100)}%` }"></div></div><span class="bar-label">{{ day.date === today ? '今天' : shortDate(day.date) }}</span></div></div>
            </div>
            <div v-else class="loading-placeholder">{{ dashboardError ? '连接恢复后显示趋势' : '正在读取饮水趋势…' }}</div>
          </section>

          <section class="panel records-panel" aria-labelledby="records-title">
            <div class="section-heading"><div><h2 id="records-title">饮水记录</h2><p>记录保留取放前后的重量，支持撤销误判</p></div><span class="record-count">{{ dashboard?.events.length ?? '—' }} 条记录</span></div>
            <div v-if="!dashboard" class="empty-state"><span class="empty-icon" aria-hidden="true">≋</span><p>{{ dashboardError ? '暂时无法读取记录' : '正在读取记录…' }}</p></div>
            <div v-else-if="!dashboard.events.length" class="empty-state"><span class="empty-icon" aria-hidden="true">≋</span><h3>这一天还没有记录</h3><p>连接杯垫并完成校准后，<br />饮水后放回杯子，重量稳定后记录会自动同步。</p></div>
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
            <div class="section-heading"><h2 id="device-title">我的杯垫</h2><span class="connection-badge" :class="{ online }"><i></i>{{ online ? '设备在线' : '设备离线' }}</span></div>
            <div class="device-illustration" aria-hidden="true"><div class="cup"><div class="cup-handle"></div><div class="cup-water"></div></div><div class="coaster"><i :class="{ lit: online }"></i></div></div>
            <div class="weight-reading"><strong data-testid="device-weight">{{ number(online ? dashboard?.device.weightGrams : null) }}</strong><span>g</span></div><p class="weight-state"><i :class="{ stable: online && dashboard?.device.stable && !dashboard?.device.error }"></i>{{ weightState }}</p>
            <dl class="device-details">
              <div><dt>设备</dt><dd>{{ dashboard?.device.id ?? '—' }}</dd></div>
              <div><dt>最后同步</dt><dd>{{ time(dashboard?.device.lastSeenAt) }}</dd></div>
              <div><dt>采集方式</dt><dd>HX711 · 含杯总重</dd></div>
              <div><dt>空杯重量</dt><dd>{{ number(dashboard?.device.emptyCupGrams) }} g</dd></div>
              <div><dt>待上传记录</dt><dd>{{ number(dashboard?.device.pendingCount) }}</dd></div>
              <div><dt>固件版本</dt><dd>{{ dashboard?.device.firmwareVersion ?? '—' }}</dd></div>
            </dl>
            <p v-if="online && !dashboard?.device.clockSynced" class="queue-note">设备正在校时，记录会先保存在杯垫中。</p>
            <p v-if="dashboard?.device.timePendingCount" class="queue-note">有 {{ dashboard.device.timePendingCount }} 条记录时间待确认；保留在杯垫中，未计入每日统计。</p>
          </section>

        </aside>
      </div>
      <footer class="page-footer"><span><span class="footer-dot"></span>每 1.5 秒自动同步</span><span>水伴 · 硬件联调版 · {{ dashboard?.timeZone ?? 'Asia/Shanghai' }}</span></footer>
    </main>

    <dialog ref="settingsDialog" class="settings-dialog" aria-labelledby="settings-title" @close="closeSettings">
      <div class="settings-header">
        <div><h2 id="settings-title">{{ initializing ? '首次校准' : '设置与初始化' }}</h2><p>{{ initializing ? '完成一次校准，之后即可日常使用。' : '配网、称重校准与空杯设置。' }}</p></div>
        <button class="settings-close" aria-label="关闭设置" @click="settingsDialog?.close()">✕</button>
      </div>
      <DeviceSetup :online="online" :device-id="dashboard?.device.id" :initializing="initializing" :active="settingsOpen" @calibrated="refresh" />
    </dialog>
  </div>
</template>
