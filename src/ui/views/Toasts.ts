import { h } from '../dom';

export class Toasts {
  readonly el = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  private recent = new Map<string, number>();

  show(level: 'info' | 'warn' | 'error', text: string, ms = 4500, action?: { label: string; run: () => void }): void {
    const now = Date.now();
    if ((this.recent.get(text) ?? 0) > now - 3000) return; // de-dupe bursts
    this.recent.set(text, now);
    for (const [k, t] of this.recent) if (now - t > 10_000) this.recent.delete(k);
    const t = h('div', { class: `toast ${level}${action ? ' has-action' : ''}` }, h('span', {}, text));
    if (action) {
      t.append(h('button', { class: 'btn small primary', onclick: (e: Event) => { e.stopPropagation(); t.remove(); action.run(); } }, action.label));
    }
    t.addEventListener('click', () => t.remove());
    this.el.append(t);
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    setTimeout(() => t.remove(), action ? Math.max(ms, 20_000) : level === 'error' ? ms * 1.5 : ms);
  }
}
