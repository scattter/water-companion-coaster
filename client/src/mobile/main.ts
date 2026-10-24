import { createApp } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { platform } from '../../../web/src/platform';
import { ApiError } from '../../../web/src/api';
import { AndroidBluetooth } from './bluetooth';
import { nativeError } from './errors';
import MobileApp from './MobileApp.vue';
import '../../../web/src/style.css';
import './style.css';

export async function mountMobile() {
  platform.mobile = true;
  platform.request = async <T>(path: string, body?: unknown, timeoutMs = 8000): Promise<T> => {
    const reply = await invoke<{ status: number; data: T & { message?: string; error?: string; code?: string } }>('plugin:coaster-mobile|request', {
      path, body: body === undefined ? null : JSON.stringify(body), timeoutMs,
    }).catch((cause: unknown) => { throw nativeError(cause); });
    if (reply.status < 200 || reply.status >= 300) throw new ApiError(reply.data.message ?? reply.data.error ?? `请求失败（${reply.status}）`, reply.status, reply.data.code);
    return reply.data;
  };
  const bluetooth = new AndroidBluetooth();
  platform.bluetooth = bluetooth;
  // Register before rendering the pairing UI so immediate GATT events cannot be lost.
  let startupError: string | undefined;
  try { await bluetooth.listen(); }
  catch (cause) { startupError = nativeError(cause).message; }
  createApp(MobileApp, { startupError }).mount('#app');
}
