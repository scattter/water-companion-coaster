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

export type CupAction = 'prepare' | 'save' | 'cancel' | 'rename' | 'select' | 'delete';
export interface CupCommand {
  id: string;
  action?: CupAction;
  cupId?: number;
  name?: string;
  setupId?: string;
}

export function validCupName(name: string): boolean {
  return /^[\u4e00-\u9fffA-Za-z0-9]{1,5}$/u.test(name);
}

export function currentCup(device: { cups?: Cup[]; activeCupId?: number | null; emptyCupGrams: number | null } | null | undefined): string {
  if (!device) return '—';
  const cup = device.cups?.find(item => item.id === device.activeCupId);
  if (cup) return `${cup.id} · ${cup.name}`;
  return device.cups === undefined && device.emptyCupGrams != null ? '默认杯' : '未设置杯子';
}
