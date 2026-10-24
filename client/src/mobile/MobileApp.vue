<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { addPluginListener, invoke, type PluginListener } from '@tauri-apps/api/core';
import WebApp from '../../../web/src/App.vue';
import { platform, type Notice } from '../../../web/src/platform';
import MobileCompanion from './MobileCompanion.vue';
import { nativeError } from './errors';
import { NoticeQueue } from './notices';

const props = defineProps<{ startupError?: string }>();
const server = ref<string | null>(null);
const address = ref('');
const settings = ref(false);
const loaded = ref(false);
const active = ref(true);
const busy = ref(false);
const pinning = ref(false);
const notice = shallowRef<Notice | null>(null);
const noticeDialog = ref<HTMLDialogElement | null>(null);
const notices = new NoticeQueue(value => { notice.value = value; });
platform.notices = notices;
let listener: PluginListener | undefined;
let disposed = false;
watch(notice, async () => {
  await nextTick();
  const dialog = noticeDialog.value;
  if (!dialog || disposed) return;
  if (notice.value) {
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('.mobile-message-body')?.scrollTo(0, 0);
  } else if (dialog.open) dialog.close();
}, { flush: 'post' });
function dismissNotice() { notices.dismiss(); }
function noticeAction() {
  const action = notice.value?.action;
  dismissNotice();
  void action?.run();
}
function noticeBack(event: Event) {
  if (!notice.value) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  dismissNotice();
}
function storage(origin: string) {
  const prefix = `water-mobile:${encodeURIComponent(origin)}:`;
  platform.storage = {
    getItem: key => localStorage.getItem(prefix + key),
    setItem: (key, value) => localStorage.setItem(prefix + key, value),
    removeItem: key => localStorage.removeItem(prefix + key),
  };
}
function message(error: unknown) { return nativeError(error).message; }
async function configure() {
  if (busy.value) return;
  busy.value = true;
  notices.reset('configure');
  try {
    const origin = await invoke<string>('mobile_address', { address: address.value });
    const result = await invoke<{ server: string }>('plugin:coaster-mobile|configure', { address: origin });
    if (disposed) return;
    notices.clear();
    server.value = result.server; address.value = result.server; storage(result.server); settings.value = false;
  } catch (error) { if (!disposed) notices.show({ source: 'configure', message: message(error) }); }
  finally { busy.value = false; }
}
async function pin() {
  if (pinning.value) return;
  pinning.value = true;
  notices.reset('widget');
  try {
    const result = await invoke<{ supported: boolean }>('plugin:coaster-mobile|pinWidget');
    if (!disposed) notices.show({ source: 'widget', message: result.supported ? '请在系统提示中确认添加；添加后长按组件并拖动边框，可切换小、中、大三种布局。也可从桌面小组件列表添加“饮水陪伴”。' : '请长按桌面，打开小组件列表，选择“饮水陪伴”；添加后拖动组件边框，可切换小、中、大三种布局。' });
  } catch (error) { if (!disposed) notices.show({ source: 'widget', message: message(error) }); }
  finally { pinning.value = false; }
}
function back(event: Event) { if (!event.defaultPrevented && settings.value && server.value) { settings.value = false; event.preventDefault(); } }
onMounted(async () => {
  window.addEventListener('companion-back', noticeBack, true);
  window.addEventListener('companion-back', back);
  if (props.startupError) notices.show({ source: 'startup', message: props.startupError });
  try {
    listener = await addPluginListener<{ active: boolean }>('coaster-mobile', 'lifecycle', value => { active.value = value.active; });
    if (disposed) { void listener.unregister(); return; }
    const value = await invoke<{ server: string | null; active: boolean; error: string | null }>('plugin:coaster-mobile|status');
    if (disposed) return;
    server.value = value.server; address.value = value.server ?? ''; active.value = value.active;
    if (value.server) storage(value.server);
    if (value.error) notices.show({ source: 'startup', message: value.error });
  } catch (error) { if (!disposed) notices.show({ source: 'startup', message: message(error) }); }
  finally { loaded.value = true; }
});
onBeforeUnmount(() => {
  disposed = true;
  void listener?.unregister();
  window.removeEventListener('companion-back', noticeBack, true);
  window.removeEventListener('companion-back', back);
  noticeDialog.value?.close();
  notices.clear();
  if (platform.notices === notices) platform.notices = undefined;
});
</script>
<template>
  <div class="mobile-root">
    <header class="mobile-toolbar"><strong>饮水陪伴</strong><button class="text-button" :disabled="!loaded || pinning" @click="pin">添加桌面组件</button><button class="text-button" @click="settings = !settings">{{ settings ? '返回' : '服务设置' }}</button></header>
    <section v-if="!loaded" class="mobile-config">正在读取本机设置…</section>
    <section v-else-if="!server || settings" class="panel mobile-config">
      <h1>连接你的饮水服务</h1><p>填写服务根地址，登录后可查看记录、配网并添加桌面小组件。</p>
      <form class="account-form" @submit.prevent="configure"><label>服务器地址<input v-model="address" type="text" inputmode="url" autocomplete="url" autocapitalize="none" spellcheck="false" placeholder="https://water.example.com" required :disabled="busy" /></label><p class="field-help">安装版使用 HTTPS，支持域名、IP 和端口，无需添加 /api。切换服务器后需重新登录。</p><button class="setup-action" :disabled="busy">{{ busy ? '正在连接…' : '连接服务器' }}</button></form>
    </section>
    <WebApp v-else :key="server" mobile :active="active">
      <template #companion="{ dashboard, session, online }"><MobileCompanion :dashboard="dashboard" :identity="`${server}:${session.user?.id ?? ''}`" :active="active && online" /></template>
    </WebApp>
    <dialog ref="noticeDialog" class="settings-dialog mobile-message-dialog" aria-labelledby="mobile-message-title" aria-describedby="mobile-message-text" @cancel.prevent="dismissNotice">
      <div class="settings-header"><h2 id="mobile-message-title">提示</h2><button type="button" class="settings-close" aria-label="关闭提示" autofocus @click="dismissNotice">✕</button></div>
      <div class="mobile-message-body"><p id="mobile-message-text">{{ notice?.message }}</p></div>
      <div class="mobile-message-actions">
        <button v-if="notice?.action" type="button" class="settings-button" @click="noticeAction">{{ notice.action.label }}</button>
        <button type="button" class="setup-action" @click="dismissNotice">知道了</button>
      </div>
    </dialog>
  </div>
</template>
