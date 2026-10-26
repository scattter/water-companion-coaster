<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Dashboard } from '../../shared/dashboard';
import { dateInZone, selectableDate } from '../../shared/dates';
import DrinkTrend from '../../shared/DrinkTrend.vue';
import '../../shared/date-motion.css';
import { amount, clockTime } from './display';
import { errorMessage, native } from './native';

const props = defineProps<{ identity: string; timeZone: string }>();
const selectedDate = ref('');
const today = ref('');
const dashboard = ref<Dashboard | null>(null);
const loading = ref(false);
const error = ref('');
const displayDate = computed(() => dashboard.value?.date ?? selectedDate.value);
let requestId = 0;
let disposed = false;

function updateToday() {
  const date = dateInZone(props.timeZone);
  const followToday = !selectedDate.value || selectedDate.value === today.value;
  today.value = date;
  if (followToday && selectedDate.value !== date) {
    selectedDate.value = date;
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
  void refresh();
}

async function loadWeek(date: string): Promise<Dashboard['week']> {
  const identity = props.identity;
  const result = await native.dashboard(date);
  if (disposed || identity !== props.identity) throw new Error('查询已取消');
  if (result.date !== date) throw new Error('服务器返回的日期与所选日期不一致，请重新查询。');
  return result.week;
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
      <input type="date" aria-label="查看统计日期" :value="selectedDate" :max="today" @change="selectDate" />
      <button class="text-button" :disabled="selectedDate === today" @click="changeDate(today)">今天</button>
    </div>
    <DrinkTrend :key="`${identity}:${timeZone}`" :model-value="selectedDate" :today="today" :week="dashboard?.week ?? []" :load-week="loadWeek" compact @update:model-value="changeDate" />
    <div>
      <dl class="history-totals" :aria-label="`${displayDate} 饮水统计`" :aria-busy="loading">
        <div><dt>饮水量</dt><dd><span :key="dashboard?.date" class="history-value">{{ amount(dashboard?.totals.drinkMl) }}</span><small> ml</small></dd></div>
        <div><dt>饮水次数</dt><dd><span :key="dashboard?.date" class="history-value">{{ amount(dashboard?.totals.drinkCount) }}</span><small> 次</small></dd></div>
        <div><dt>补水量</dt><dd><span :key="dashboard?.date" class="history-value">{{ amount(dashboard?.totals.refillMl) }}</span><small> ml</small></dd></div>
      </dl>
      <p v-if="error" class="error-message" role="alert">{{ error }}<span v-if="dashboard"> · 当前保留 {{ displayDate }} 上次查询的数据。</span></p>
      <div :key="dashboard?.date" class="history-list record-content" :aria-busy="loading" tabindex="0" :aria-label="`${displayDate} 饮水与补水明细`">
        <p v-if="!dashboard" class="history-empty">{{ loading ? '正在读取记录…' : '暂时无法读取记录，请重试。' }}</p>
        <p v-else-if="!dashboard.events.length" class="history-empty">{{ displayDate }} 暂无记录</p>
        <ul v-else>
          <li v-for="event in dashboard.events" :key="event.id" :class="{ revoked: event.revokedAt }">
            <div><span class="history-event-kind">{{ event.kind === 'drink' ? '饮水' : '补水' }}</span><time :datetime="event.occurredAt">{{ clockTime(event.occurredAt, dashboard.timeZone) }}</time><span v-if="event.revokedAt" class="history-revoked">已撤销</span><strong>{{ amount(event.amountMl) }}<small> ml</small></strong></div>
            <p>{{ amount(event.beforeGrams) }} g → {{ amount(event.afterGrams) }} g</p>
          </li>
        </ul>
      </div>
    </div>
    <p class="history-caption">{{ displayDate }} · {{ props.timeZone }} · {{ loading && selectedDate !== displayDate ? `正在读取 ${selectedDate}…` : `${dashboard?.events.length ?? '—'} 条记录` }}</p>
  </section>
</template>
