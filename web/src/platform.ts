import type { BluetoothAccess } from './ble';

export interface OperationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface Notice {
  source: string;
  message: string;
  action?: { label: string; run: () => void | Promise<void> };
}
export interface Notices {
  show(notice: Notice): void;
  reset(source: string): void;
  clear(prefix?: string): void;
}
export const platform: {
  request?: <T>(path: string, body?: unknown, timeoutMs?: number) => Promise<T>;
  bluetooth?: BluetoothAccess;
  storage?: OperationStorage;
  notices?: Notices;
  mobile: boolean;
} = { mobile: false };

export const operationStorage: OperationStorage = {
  getItem: key => (platform.storage ?? sessionStorage).getItem(key),
  setItem: (key, value) => (platform.storage ?? sessionStorage).setItem(key, value),
  removeItem: key => (platform.storage ?? sessionStorage).removeItem(key),
};
