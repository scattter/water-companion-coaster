<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import type { Dashboard } from '../../../shared/dashboard';
import type { CompanionState } from '../types';
import { framePath, stateText } from '../display';
const props = defineProps<{ dashboard: Dashboard | null; identity: string; active: boolean }>();
const state = ref<CompanionState>('idle');
const frame = ref(0);
let reset = true;
let version = 0;
let pending = false;
let timer: ReturnType<typeof setInterval> | undefined;
watch(() => [props.identity, props.active], () => { reset = true; ++version; if (!props.active) { state.value = 'idle'; frame.value = 0; } });
async function tick() {
  if (!props.active || pending) return;
  const current = version;
  const baseline = reset;
  pending = true;
  try {
    const result = await invoke<[CompanionState, number]>('mobile_companion', { dashboard: props.dashboard, identity: props.identity, reset: baseline });
    if (current !== version) return;
    reset = false; [state.value, frame.value] = result;
  } catch { state.value = 'idle'; frame.value = 0; reset = true; }
  finally { pending = false; }
}
onMounted(() => { void tick(); timer = setInterval(() => void tick(), 1000); });
onBeforeUnmount(() => { clearInterval(timer); ++version; });
</script>
<template><section v-if="dashboard" class="mobile-companion"><img :src="framePath(state, frame)" alt="陪你喝水的小水豚" /><div><strong>{{ stateText[state] }}</strong><p>慢慢喝，慢慢来</p></div></section></template>
