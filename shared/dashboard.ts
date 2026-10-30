import type { Cup, CupSetup } from './cups';

export type EventKind = 'drink' | 'refill';

export interface DrinkEvent {
  id: string;
  kind: EventKind;
  amountMl: number;
  beforeGrams: number;
  afterGrams: number;
  occurredAt: string;
  revokedAt: string | null;
  bindingId: string | null;
}

export interface Dashboard {
  date: string;
  timeZone: string;
  totals: { drinkMl: number; refillMl: number; drinkCount: number };
  week: { date: string; drinkMl: number }[];
  events: DrinkEvent[];
  device: {
    id: string;
    lastSeenAt: string | null;
    online: boolean;
    weightGrams: number | null;
    stable: boolean;
    cupPresent: boolean;
    source: 'hx711';
    calibrated: boolean;
    emptyCupGrams: number | null;
    cups?: Cup[];
    activeCupId?: number | null;
    cupSetup?: CupSetup | null;
    pendingCount: number;
    timePendingCount: number;
    clockSynced: boolean;
    error: string | null;
    firmwareVersion: string | null;
    bindingId: string | null;
  } | null;
}
