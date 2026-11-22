import { h } from '../dom';
import { icons } from '../icons';

const ICON = { info: icons.info, warn: icons.warn, error: icons.error } as const;

export class Toasts {
  readonly el = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  private recent = new Map<string, number>();

  show(level: 'info' | 'warn' | 'error', text: string, ms = 4500, action?: { label: string; run: () => void }): void {
    const now = Date.now();
    if ((this.recent.get(text) ?? 0) > now - 3000) return; // de-dupe bursts
    this.recent.set(text, now);
    for (const [k, t] of this.recent) if (now - t > 10_000) this.recent.delete(k);
    const t = h(
      'div',
      { class: `toast ${level}${action ? ' has-action' : ''}`, role: level === 'error' ? 'alert' : undefined },
      h('span', { class: 'toast-icon', html: ICON[level], 'aria-hidden': 'true' }),
      h('span', { class: 'toast-text' }, text),
    );
    const dismiss = () => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 180);
    };
    if (action) {
      t.append(h('button', { class: 'btn small primary', onclick: (e: Event) => { e.stopPropagation(); t.remove(); action.run(); } }, action.label));
    }
    t.append(h('button', { class: 'toast-x', type: 'button', 'aria-label': 'Dismiss', html: icons.close, onclick: (e: Event) => (e.stopPropagation(), dismiss()) }));
    t.addEventListener('click', dismiss);
    // Swipe sideways (or up) to dismiss.
    let sx = 0;
    let sy = 0;
    t.addEventListener('pointerdown', (e) => ((sx = e.clientX), (sy = e.clientY)));
    t.addEventListener('pointermove', (e) => {
      if (e.buttons || e.pointerType === 'touch') {
        const dx = e.clientX - sx;
        if (Math.abs(dx) > 8) t.style.transform = `translateX(${dx}px)`;
        if (Math.abs(dx) > 70 || sy - e.clientY > 40) dismiss();
      }
    });
    t.addEventListener('pointerup', () => (t.style.transform = ''));
    this.el.append(t);
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    setTimeout(dismiss, action ? Math.min(Math.max(ms, 6000), 8000) : level === 'error' ? ms * 1.5 : ms);
  }
}
