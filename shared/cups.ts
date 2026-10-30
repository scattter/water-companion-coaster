export interface Cup {
  id: number;
  name: string;
  emptyCupGrams: number;
}

export interface CupSetup {
  id: string;
  cupId: number;
  name: string;
  expiresAt: number;
}

export type CupAction = 'prepare' | 'save' | 'manual' | 'cancel' | 'rename' | 'select' | 'delete';
export interface CupCommand {
  id: string;
  action?: CupAction;
  cupId?: number;
  name?: string;
  setupId?: string;
  emptyCupGrams?: number;
}

export function validCupName(name: string): boolean {
  return /^[\u4e00-\u9fffA-Za-z0-9]{1,5}$/u.test(name);
}

export function validCupWeight(grams: unknown): grams is number {
  return typeof grams === 'number' && Number.isFinite(grams) && grams >= 5 && grams <= 1995;
}

export function supportsManualCupWeight(version: string | null | undefined): boolean {
  const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!parts) return false;
  const [major, minor, patch] = parts.slice(1).map(Number);
  return major > 0 || minor > 8 || (minor === 8 && patch >= 1);
}

export function currentCup(device: { cups?: Cup[]; activeCupId?: number | null; emptyCupGrams: number | null } | null | undefined): string {
  if (!device) return '—';
  const cup = device.cups?.find(item => item.id === device.activeCupId);
  if (cup) return `${cup.id} · ${cup.name}`;
  return device.cups === undefined && device.emptyCupGrams != null ? '默认杯' : '未设置杯子';
}
