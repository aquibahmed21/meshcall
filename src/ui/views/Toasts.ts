import { h } from '../dom';

export class Toasts {
  readonly el = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  private recent = new Map<string, number>();

  show(level: 'info' | 'warn' | 'error', text: string, ms = 4500): void {
    const now = Date.now();
    if ((this.recent.get(text) ?? 0) > now - 3000) return; // de-dupe bursts
    this.recent.set(text, now);
    for (const [k, t] of this.recent) if (now - t > 10_000) this.recent.delete(k);
    const t = h('div', { class: `toast ${level}` }, text);
    t.addEventListener('click', () => t.remove());
    this.el.append(t);
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    setTimeout(() => t.remove(), level === 'error' ? ms * 1.5 : ms);
  }
}
