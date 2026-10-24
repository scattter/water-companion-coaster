import { onBeforeUnmount, watch } from 'vue';
import { platform, type Notice } from './platform';

export function useNotice(source: string, message: () => string, options: {
  enabled?: () => boolean;
  action?: () => Notice['action'];
} = {}) {
  let disposed = false;
  function reset() { if (platform.mobile) platform.notices?.reset(source); }
  function show() {
    if (disposed || !platform.mobile) return;
    const text = message();
    if (!text) { reset(); return; }
    if (options.enabled?.() === false) return;
    platform.notices?.show({ source, message: text, action: options.action?.() });
  }
  const stop = watch([message, () => options.enabled?.()], show, { immediate: true });
  onBeforeUnmount(() => {
    disposed = true;
    stop();
    if (platform.mobile) platform.notices?.clear(source);
  });
  return { reset, show };
}
