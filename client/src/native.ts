import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Page, Settings, Snapshot } from './types';

export function newerSnapshot(current: Snapshot, incoming: Snapshot): Snapshot {
  // 事件和命令回包走不同通道，只接受原生读取顺序较新的状态。
  return incoming.revision < current.revision ? current : incoming;
}

export const native = {
  snapshot: () => invoke<Snapshot>('get_snapshot'),
  configure: (address: string) => invoke<Snapshot>('configure_server', { address }),
  login: (username: string, password: string) => invoke<Snapshot>('login', { username, password }),
  logout: () => invoke<Snapshot>('logout'),
  refresh: () => invoke<Snapshot>('refresh'),
  settings: (settings: Settings) => invoke<Snapshot>('update_settings', { settings }),
  website: () => invoke<void>('open_website'),
  resize: (height: number) => invoke<void>('resize_panel', { height }),
  hide: () => invoke<void>('hide_panel'),
  quit: () => invoke<void>('quit'),
  onSnapshot: (handler: (snapshot: Snapshot) => void): Promise<UnlistenFn> =>
    listen<Snapshot>('companion://snapshot', event => handler(event.payload)),
  onPage: (handler: (page: Page) => void): Promise<UnlistenFn> =>
    listen<Page>('companion://page', event => handler(event.payload)),
};

export function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}
