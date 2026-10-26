<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Dashboard } from './dashboard';
import { dateWeekEnd, selectableDate } from './dates';

const props = defineProps<{
  modelValue: string;
  today: string;
  week: Dashboard['week'];
  loadWeek: (date: string) => Promise<Dashboard['week']>;
  compact?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [date: string] }>();
const viewport = ref<HTMLElement | null>(null);
const width = ref(280);
const range = ref({ start: 0, end: 0 });
const values = ref<Record<string, number>>({});
const preview = ref('');
const maximum = ref(100);
const dragging = ref(false);
const edge = ref(0);
const loadFailed = ref(false);
const dayMs = 86_400_000;
const firstDay = dayNumber('0000-01-01');
const step = computed(() => width.value / 7);
const ready = computed(() => selectableDate(props.modelValue, props.today));
const days = computed(() => ready.value ? Array.from({ length: range.value.end - range.value.start + 1 }, (_, index) => {
  const day = range.value.start + index;
  const date = day >= firstDay ? dateString(day) : '';
  return { day, date, amount: values.value[date] };
}) : []);
const pending = new Set<string>();
const failed = new Set<string>();
let observer: ResizeObserver | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let wheelTimer: ReturnType<typeof setTimeout> | undefined;
let adjustment = 0;
let disposed = false;
let initialized = false;
let moving = false;
let touching = false;
let adjusting = false;
let snapTarget: number | null = null;
let gesture: { id: number; x: number; y: number; left: number; lastX: number; lastTime: number; speed: number } | null = null;

function dayNumber(date: string) { return Date.parse(`${date}T00:00:00Z`) / dayMs; }
function dateString(day: number) { return new Date(day * dayMs).toISOString().slice(0, 10); }
function number(value: number) { return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value); }
function reducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
function selectedDay() {
  return Math.max(firstDay, Math.min(dayNumber(props.today), range.value.start + Math.round((viewport.value?.scrollLeft ?? 0) / step.value) + 6));
}
function updateScale() {
  const end = dayNumber(preview.value);
  maximum.value = Math.max(100, ...Array.from({ length: 7 }, (_, index) => values.value[dateString(Math.max(firstDay, end - index))] ?? 0));
}
function merge(week: Dashboard['week'], overwrite: boolean) {
  const next = { ...values.value };
  for (const item of week) {
    if (selectableDate(item.date, props.today) && (overwrite || next[item.date] === undefined)) next[item.date] = item.drinkMl;
  }
  values.value = next;
  if (!moving && preview.value) updateScale();
}
function preload() {
  if (!ready.value || !preview.value || disposed) return;
  const end = dayNumber(preview.value);
  const weeks = new Set<string>();
  // 只预读可见区附近的周数据；滚动不会逐帧请求每日明细。
  for (let day = Math.max(firstDay, end - 13); day <= Math.min(dayNumber(props.today), end + 7); day++) {
    const date = dateString(day);
    if (values.value[date] === undefined) weeks.add(dateWeekEnd(date, props.today));
  }
  for (const date of weeks) {
    if (pending.has(date) || failed.has(date)) continue;
    pending.add(date);
    void props.loadWeek(date).then(week => {
      if (!disposed) merge(week, false);
    }).catch(() => {
      if (!disposed) { failed.add(date); loadFailed.value = true; }
    }).finally(() => { pending.delete(date); });
  }
}

async function align(date: string, smooth = false) {
  if (!selectableDate(date, props.today)) return;
  const day = dayNumber(date);
  const outside = !initialized || day < range.value.start + 6 || day > range.value.end;
  if (outside) range.value = { start: Math.max(firstDay - 6, day - 20), end: Math.min(dayNumber(props.today), day + 7) };
  initialized = true;
  preview.value = date;
  clearTimeout(timer);
  clearTimeout(wheelTimer);
  wheelTimer = undefined;
  snapTarget = null;
  await nextTick();
  const element = viewport.value;
  if (!element || disposed || date !== props.modelValue) return;
  const left = (day - range.value.start - 6) * step.value;
  if (smooth && !outside && Math.abs(element.scrollLeft - left) <= width.value && !reducedMotion()) {
    snapTarget = left;
    moving = true;
    element.scrollTo({ left, behavior: 'smooth' });
  } else {
    moving = false;
    adjusting = true;
    element.scrollLeft = left;
    cancelAnimationFrame(adjustment);
    adjustment = requestAnimationFrame(() => { adjusting = false; });
  }
  updateScale();
  preload();
}

async function extend() {
  const element = viewport.value;
  if (!element || disposed) return;
  const day = selectedDay();
  const before = range.value.start;
  const start = day - before < 13 ? Math.max(firstDay - 6, before - 14) : before;
  const end = range.value.end - day < 7 ? Math.min(dayNumber(props.today), range.value.end + 14) : range.value.end;
  if (start === before && end === range.value.end) return;
  const left = element.scrollLeft;
  adjusting = true;
  element.style.scrollSnapType = 'none';
  range.value = { start, end };
  await nextTick();
  if (disposed) return;
  element.scrollLeft = left + (before - start) * step.value;
  cancelAnimationFrame(adjustment);
  adjustment = requestAnimationFrame(() => {
    adjusting = false;
    element.style.removeProperty('scroll-snap-type');
  });
}

function finish() {
  if (disposed || !ready.value || adjusting || touching || dragging.value || wheelTimer !== undefined || !viewport.value) return;
  if (snapTarget !== null && Math.abs(viewport.value.scrollLeft - snapTarget) > 1) return;
  snapTarget = null;
  moving = false;
  viewport.value.style.removeProperty('scroll-snap-type');
  preview.value = dateString(selectedDay());
  if (preview.value !== props.modelValue) emit('update:modelValue', preview.value);
  updateScale();
  preload();
  void extend();
}
function scroll() {
  if (adjusting || !ready.value) return;
  moving = true;
  preview.value = dateString(selectedDay());
  preload();
  clearTimeout(timer);
  if (wheelTimer === undefined) timer = setTimeout(finish, 160);
}
function snap(left: number) {
  const element = viewport.value;
  if (!element) return;
  clearTimeout(wheelTimer);
  wheelTimer = undefined;
  edge.value = 0;
  snapTarget = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, Math.round(left / step.value) * step.value));
  element.scrollTo({ left: snapTarget, behavior: reducedMotion() ? 'auto' : 'smooth' });
  clearTimeout(timer);
  timer = setTimeout(finish, 180);
}
function begin() {
  clearTimeout(timer);
  clearTimeout(wheelTimer);
  wheelTimer = undefined;
  snapTarget = null;
  failed.clear();
  loadFailed.value = false;
}
function touchStart() {
  touching = true;
  moving = true;
  begin();
}
function touchEnd(event: TouchEvent) {
  touching = event.touches.length > 0;
  if (!touching) { clearTimeout(timer); timer = setTimeout(finish, 160); }
}
function wheel(event: WheelEvent) {
  if (!ready.value || event.ctrlKey || !viewport.value) return;
  begin();
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  event.preventDefault();
  const element = viewport.value;
  element.style.scrollSnapType = 'none';
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width.value : 1;
  element.scrollLeft -= event.deltaY * unit;
  clearTimeout(timer);
  wheelTimer = setTimeout(() => snap(element.scrollLeft), 120);
}
function pointerDown(event: PointerEvent) {
  if (!ready.value || !event.isPrimary || event.button !== 0) return;
  begin();
  // 触屏使用 WebView 原生惯性滚动；仅补齐鼠标按住拖动的行为。
  if (event.pointerType === 'touch' || !viewport.value) return;
  viewport.value.scrollTo({ left: viewport.value.scrollLeft, behavior: 'auto' });
  gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.value.scrollLeft, lastX: event.clientX, lastTime: event.timeStamp, speed: 0 };
}
function pointerMove(event: PointerEvent) {
  const start = gesture;
  const element = viewport.value;
  if (!start || start.id !== event.pointerId || !element) return;
  const dx = event.clientX - start.x;
  const dy = event.clientY - start.y;
  if (!dragging.value) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
    if (Math.abs(dy) >= Math.abs(dx)) { gesture = null; return; }
    dragging.value = true;
    element.style.scrollSnapType = 'none';
    element.setPointerCapture(event.pointerId);
  }
  event.preventDefault();
  const wanted = start.left - dx;
  element.scrollLeft = wanted;
  edge.value = reducedMotion() ? 0 : -Math.tanh((wanted - element.scrollLeft) / 100) * 24;
  const elapsed = event.timeStamp - start.lastTime;
  if (elapsed > 0) start.speed = start.speed * .65 + Math.max(-1.5, Math.min(1.5, (start.lastX - event.clientX) / elapsed)) * .35;
  start.lastX = event.clientX;
  start.lastTime = event.timeStamp;
}
function pointerUp(event: PointerEvent, cancel = false) {
  const start = gesture;
  const element = viewport.value;
  if (!start || start.id !== event.pointerId || !element) return;
  const moved = dragging.value;
  gesture = null;
  dragging.value = false;
  if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  if (moved) {
    const speed = cancel || event.timeStamp - start.lastTime > 100 ? 0 : start.speed;
    const coast = Math.max(-step.value * 2, Math.min(step.value * 2, speed * 100));
    snap(element.scrollLeft + coast);
  }
}
function keydown(event: KeyboardEvent) {
  const shift: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -7, PageDown: 7 };
  if (!(event.key in shift) && event.key !== 'End') return;
  event.preventDefault();
  const day = event.key === 'End' ? dayNumber(props.today) : dayNumber(props.modelValue) + shift[event.key]!;
  const date = dateString(Math.max(firstDay, Math.min(dayNumber(props.today), day)));
  if (date !== props.modelValue) emit('update:modelValue', date);
}

watch(() => props.week, week => { merge(week, true); }, { immediate: true });
watch(() => [props.modelValue, props.today], () => {
  if (!ready.value) return;
  if (!initialized || props.modelValue !== preview.value) void align(props.modelValue, true);
});
onMounted(() => {
  const element = viewport.value;
  if (!element) return;
  if (element.clientWidth) width.value = element.clientWidth;
  void align(props.modelValue);
  observer = new ResizeObserver(([entry]) => {
    if (!entry || !entry.contentRect.width || entry.contentRect.width === width.value) return;
    width.value = entry.contentRect.width;
    void align(props.modelValue);
  });
  observer.observe(element);
});
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); clearTimeout(wheelTimer); cancelAnimationFrame(adjustment); observer?.disconnect(); });
</script>

<template>
  <div class="drink-trend" :class="{ compact }" :style="{ '--day-width': `${step}px` }">
    <div class="trend-axis" aria-hidden="true"><span>{{ number(maximum) }}</span><span>{{ number(maximum / 2) }}</span><span>0</span></div>
    <div ref="viewport" class="trend-scroll" :class="{ dragging }" tabindex="0" role="group" aria-label="饮水趋势，左右滑动图表或使用方向键切换记录" @scroll.passive="scroll" @scrollend="finish" @wheel="wheel" @touchstart.passive="touchStart" @touchend.passive="touchEnd" @touchcancel.passive="touchEnd" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="pointerUp($event, true)" @lostpointercapture="pointerUp($event, true)" @pointerleave="!dragging && pointerUp($event, true)" @keydown="keydown" @dragstart.prevent>
      <div class="trend-track" :style="{ transform: `translateX(${edge}px)` }">
        <div v-for="day in days" :key="day.day" class="trend-column" :class="{ selected: day.date === preview, unavailable: !day.date }" :aria-current="day.date === preview ? 'date' : undefined" :aria-label="day.date ? `${day.date} 饮水 ${day.amount === undefined ? '尚未读取' : `${number(day.amount)} 毫升`}` : undefined" :aria-hidden="!day.date || undefined">
          <div class="trend-bar-space" :style="{ '--bar-height': `${day.amount === undefined ? 18 : Math.max(2, Math.min(100, day.amount / maximum * 100))}%` }">
            <span class="trend-value">{{ day.amount === undefined ? '—' : number(day.amount) }}</span>
            <span class="trend-bar" :class="{ pending: day.amount === undefined, zero: day.amount === 0 }"></span>
          </div>
          <span class="trend-label">{{ day.date === today ? '今天' : day.date ? `${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8))}` : '' }}</span>
        </div>
      </div>
    </div>
    <p class="trend-hint"><span>{{ loadFailed ? '部分趋势暂未同步，滑动后重试' : '左右滑动图表切换记录' }}</span><span>{{ preview }}</span></p>
  </div>
</template>

<style scoped>
.drink-trend { --plot-height:130px; position:relative; margin-top:14px; padding-left:30px; min-width:0; }
.drink-trend.compact { --plot-height:100px; padding-left:26px; }
.trend-axis { position:absolute; inset:22px 0 43px; display:flex; flex-direction:column; justify-content:space-between; color:var(--muted,#a5aea2); font-size:9px; pointer-events:none; }
.trend-axis span { display:flex; align-items:center; gap:7px; line-height:1; }
.trend-axis span::after { content:''; flex:1; border-top:1px dashed var(--line,#e7ebe1); }
.trend-scroll { position:relative; overflow-x:auto; overflow-y:hidden; height:calc(var(--plot-height) + 48px); scrollbar-width:none; scroll-snap-type:x mandatory; overflow-anchor:none; overscroll-behavior-x:contain; touch-action:pan-x pan-y; cursor:grab; user-select:none; -webkit-user-select:none; }
.trend-scroll::-webkit-scrollbar { display:none; }
.trend-scroll:focus-visible { outline:2px solid #81b7a0; outline-offset:3px; border-radius:6px; }
.trend-scroll.dragging { cursor:grabbing; }
.trend-track { display:flex; width:max-content; height:100%; transition:transform .34s cubic-bezier(.2,.9,.3,1.2); }
.dragging .trend-track { transition:none; }
.trend-column { flex:0 0 var(--day-width); width:var(--day-width); padding-top:22px; scroll-snap-align:end; }
.trend-column.unavailable { visibility:hidden; }
.trend-bar-space { height:var(--plot-height); position:relative; display:flex; align-items:flex-end; justify-content:center; }
.trend-bar { display:block; width:56%; max-width:36px; height:var(--bar-height); min-height:3px; border-radius:5px 5px 2px 2px; background:var(--soft-green,#d6e1cb); transition:height .24s ease-out,background-color .16s ease-out; }
.trend-bar.zero { opacity:.6; }
.trend-bar.pending { background:repeating-linear-gradient(135deg,var(--line,#e3e8df),var(--line,#e3e8df) 3px,transparent 3px,transparent 6px); }
.trend-value { position:absolute; bottom:calc(var(--bar-height) + 5px); font-size:9px; line-height:12px; color:var(--muted,#94a18d); transition:bottom .24s ease-out,color .16s ease-out; }
.trend-label { display:block; margin-top:10px; text-align:center; font-size:10px; line-height:15px; white-space:nowrap; color:var(--muted,#94a18d); }
.selected .trend-bar:not(.pending) { background:var(--green,#6f9361); }
.selected .trend-value,.selected .trend-label { color:var(--green,#43745d); font-weight:600; }
.trend-hint { display:flex; justify-content:space-between; gap:8px; margin:5px 0 0; color:var(--muted,#94a091); font-size:10px; line-height:16px; }
@media (prefers-reduced-motion:reduce) {
  .trend-track,.trend-bar,.trend-value { transition:none; }
}
</style>
