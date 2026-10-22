import type { Dashboard } from '../../shared/dashboard';
import type { Session } from '../../web/src/session';

export type CompanionState = 'working' | 'sleeping' | 'drinking' | 'reminding' | 'idle';
export type Connection = 'unconfigured' | 'signedOut' | 'connecting' | 'online' | 'offline';
export type Page = 'dashboard' | 'settings';

export interface Settings {
  autoRest: boolean;
  reminders: boolean;
}

export interface Snapshot {
  revision: number;
  server: string | null;
  session: Session;
  dashboard: Dashboard | null;
  connection: Connection;
  error: string | null;
  lastSyncedAt: string | null;
  state: CompanionState;
  frame: number;
  settings: Settings;
}
