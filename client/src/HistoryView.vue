<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { Dashboard } from '../../shared/dashboard';
import { dateInZone, selectableDate, shiftDate } from '../../shared/dates';
import { amount, clockTime } from './display';
import { errorMessage, native } from './native';

const props = defineProps<{ identity: string; timeZone: string }>();
const selectedDate = ref('');
const today = ref('');
const dashboard = ref<Dashboard | null>(null);
const loading = ref(false);
const error = ref('');
let requestId = 0;
let disposed = false;

function updateToday() {
  const date = dateInZone(props.timeZone);
  const followToday = !selectedDate.value || selectedDate.value === today.value;
  today.value = date;
  if (followToday && selectedDate.value !== date) {
    selectedDate.value = date;
    dashboard.value = null;
    return true;
  }
  return false;
}

async function refresh() {
  updateToday();
  const date = selectedDate.value;
  if (!selectableDate(date, today.value)) return;
  const id = ++requestId;
  const identity = props.identity;
  loading.value = true;
  error.value = '';
  try {
    const result = await native.dashboard(date);
    if (disposed || id !== requestId || identity !== props.identity || date !== selectedDate.value) return;
    if (result.date !== date) throw new Error('服务器返回的日期与所选日期不一致，请重新查询。');
    dashboard.value = result;
  } catch (cause) {
    if (!disposed && id === requestId && identity === props.identity) error.value = errorMessage(cause);
  } finally {
    if (!disposed && id === requestId) loading.value = false;
  }
}

function changeDate(date: string) {
  updateToday();
  if (!selectableDate(date, today.value) || date === selectedDate.value) return;
  selectedDate.value = date;
  dashboard.value = null;
  void refresh();
}

function selectDate(event: Event) {
  const input = event.target as HTMLInputElement;
  if (selectableDate(input.value, today.value)) changeDate(input.value);
  else input.value = selectedDate.value;
}

watch(() => [props.identity, props.timeZone], () => {
  ++requestId;
  selectedDate.value = '';
  dashboard.value = null;
  void refresh();
}, { immediate: true });
const timer = setInterval(() => { if (updateToday()) void refresh(); }, 30_000);
onBeforeUnmount(() => { disposed = true; ++requestId; clearInterval(timer); });
</script>

<template>
  <section class="history-view" aria-labelledby="history-title">
    <div class="history-heading"><h1 id="history-title">饮水记录</h1><button class="text-button" :disabled="loading" @click="refresh">{{ loading ? '查询中…' : '刷新' }}</button></div>
    <div class="history-date">
      <button class="quiet-button" aria-label="前一天" @click="changeDate(shiftDate(selectedDate, -1))">‹</button>
      <input type="date" aria-label="查看统计日期" :value="selectedDate" :max="today" @change="selectDate" />
      <button class="quiet-button" aria-label="后一天" :disabled="selectedDate >= today" @click="changeDate(shiftDate(selectedDate, 1))">›</button>
      <button class="text-button" :disabled="selectedDate === today" @click="changeDate(today)">今天</button>
    </div>
    <dl class="history-totals" aria-label="所选日期统计">
      <div><dt>饮水量</dt><dd>{{ amount(dashboard?.totals.drinkMl) }}<small> ml</small></dd></div>
      <div><dt>饮水次数</dt><dd>{{ amount(dashboard?.totals.drinkCount) }}<small> 次</small></dd></div>
      <div><dt>补水量</dt><dd>{{ amount(dashboard?.totals.refillMl) }}<small> ml</small></dd></div>
    </dl>
    <p v-if="error" class="error-message" role="alert">{{ error }}<span v-if="dashboard"> · 当前保留这一天上次查询的数据。</span></p>
    <div class="history-list" :aria-busy="loading" tabindex="0" aria-label="当日饮水与补水明细">
      <p v-if="!dashboard" class="history-empty">{{ loading ? '正在读取记录…' : '暂时无法读取记录，请重试。' }}</p>
      <p v-else-if="!dashboard.events.length" class="history-empty">{{ selectedDate }} 暂无记录</p>
      <ul v-else>
        <li v-for="event in dashboard.events" :key="event.id" :class="{ revoked: event.revokedAt }">
          <div><span class="history-event-kind">{{ event.kind === 'drink' ? '饮水' : '补水' }}</span><time :datetime="event.occurredAt">{{ clockTime(event.occurredAt, dashboard.timeZone) }}</time><span v-if="event.revokedAt" class="history-revoked">已撤销</span><strong>{{ amount(event.amountMl) }}<small> ml</small></strong></div>
          <p>{{ amount(event.beforeGrams) }} g → {{ amount(event.afterGrams) }} g</p>
        </li>
      </ul>
    </div>
    <p class="history-caption">{{ selectedDate }} · {{ props.timeZone }} · {{ dashboard?.events.length ?? '—' }} 条记录</p>
  </section>
</template>
