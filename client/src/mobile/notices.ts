import type { Notice, Notices } from '../../../web/src/platform';

export class NoticeQueue implements Notices {
  private items: Notice[] = [];
  private seen = new Map<string, Set<string>>();

  constructor(private readonly changed: (notice: Notice | null) => void) {}

  get current() { return this.items[0] ?? null; }

  show(notice: Notice) {
    if (!notice.message.trim()) return;
    const messages = this.seen.get(notice.source) ?? new Set<string>();
    if (messages.has(notice.message)) return;
    messages.add(notice.message);
    this.seen.set(notice.source, messages);
    if (this.items.some(item => item.source === notice.source && item.message === notice.message)) return;
    this.items.push(notice);
    this.changed(this.current);
  }

  dismiss() {
    this.items.shift();
    this.changed(this.current);
  }

  reset(source: string) {
    this.seen.delete(source);
    // 恢复或重试时丢弃排队的旧结果；已经展示的提示仍由用户关闭。
    this.items = this.items.filter((item, index) => index === 0 || item.source !== source);
    this.changed(this.current);
  }

  clear(prefix = '') {
    this.items = this.items.filter(item => !item.source.startsWith(prefix));
    for (const source of this.seen.keys()) {
      if (source.startsWith(prefix)) this.seen.delete(source);
    }
    this.changed(this.current);
  }
}
