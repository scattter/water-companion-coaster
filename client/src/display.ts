import type { Dashboard, DrinkEvent } from '../../shared/dashboard';
import type { Character, CompanionState, Snapshot } from './types';

export function amount(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
}

export function recentDrink(dashboard: Dashboard | null): DrinkEvent | null {
  return dashboard?.events.reduce<DrinkEvent | null>((latest, event) => {
    if (event.kind !== 'drink' || event.revokedAt !== null || !Number.isFinite(Date.parse(event.occurredAt))) return latest;
    return !latest || Date.parse(event.occurredAt) > Date.parse(latest.occurredAt) ? event : latest;
  }, null) ?? null;
}

export function clockTime(value: string | null | undefined, timeZone = 'Asia/Shanghai'): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '尚未同步';
  return new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

export function dayLabel(dashboard: Dashboard | null, now = new Date()): string {
  if (!dashboard) return '今日饮水';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: dashboard.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)?.value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  if (dashboard.date === today) return '今日饮水';
  return `${dashboard.date.replaceAll('-', '/')} 饮水`;
}

export function deviceStatus(snapshot: Snapshot): string {
  if (!snapshot.session.user) return '登录后连接杯垫';
  if (snapshot.connection === 'offline') return '云端连接中断';
  if (!snapshot.dashboard) return '正在同步杯垫';
  const device = snapshot.dashboard.device;
  if (!device) return '尚未绑定杯垫';
  if (!device.online) return '杯垫离线';
  if (device.error) return device.error;
  if (!device.calibrated) return '请联系售后完成标定';
  if (device.emptyCupGrams === null) return '请先设置日常空杯';
  if (device.timePendingCount > 0) return '有饮水记录等待校时';
  if (device.pendingCount > 0) return '杯垫记录同步中';
  return device.cupPresent ? '杯垫在线' : '杯子已取走';
}

export const stateText: Record<CompanionState, string> = {
  working: '我陪你一起工作',
  sleeping: '休息一下，待会儿见',
  drinking: '咕嘟咕嘟，一起喝水',
  reminding: '忙了一会儿，喝口水吧',
  idle: '我在这里陪着你',
};

export const characters: { id: Character; name: string }[] = [
  { id: 'robot', name: '小机器人' },
  { id: 'capybara', name: '水豚' },
  { id: 'cat', name: '灰白小猫' },
  { id: 'dog', name: '奶油小狗' },
  { id: 'girl', name: '女生' },
  { id: 'boy', name: '男生' },
];

export function frameStyle(character: Character = 'robot') {
  // 场景原图需要裁去上下留白，机器人全身图则保持完整。
  return character === 'capybara' || character === 'robot' ? undefined : { objectFit: 'cover' as const, objectPosition: 'center 54%' };
}

export function framePath(state: CompanionState, frame: number, character: Character = 'robot'): string {
  if (character !== 'capybara') return `/companion/characters/${character}.png`;
  const pose = state === 'idle' ? 'working' : state;
  const index = state === 'idle' ? 0 : Math.max(0, Math.min(3, Math.trunc(frame)));
  return `/companion/${pose}-${index}.png`;
}
