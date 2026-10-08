import { backStack } from '../BackStack';
import { h } from '../dom';
import { icons } from '../icons';

/** Accessible modal built on <dialog> (focus trapping + Esc handled by the browser). */
export class Modal {
  readonly el: HTMLDialogElement;
  private body: HTMLElement;
  onClose: (() => void) | null = null;
  private readonly dismissible: boolean;
  private releaseBack: (() => void) | null = null;

  constructor(title: string, opts: { dismissible?: boolean; className?: string } = {}) {
    const dismissible = opts.dismissible ?? true;
    this.dismissible = dismissible;
    this.body = h('div', { class: 'modal-body' });
    this.el = h(
      'dialog',
      { class: `modal ${opts.className ?? ''}`, 'aria-label': title },
      h(
        'header',
        { class: 'modal-header' },
        h('h2', {}, title),
        dismissible ? h('button', { class: 'icon-btn', 'aria-label': 'Close', html: icons.close, onclick: () => this.close() }) : null,
      ),
      this.body,
    );
    this.el.addEventListener('cancel', (e) => {
      if (!dismissible) e.preventDefault();
    });
    this.el.addEventListener('close', () => {
      this.releaseBack?.();
      this.releaseBack = null;
      this.el.remove();
      this.onClose?.();
    });
    this.el.addEventListener('click', (e) => {
      if (dismissible && e.target === this.el) this.close();
    });
  }

  setContent(...nodes: Node[]): void {
    this.body.replaceChildren(...nodes);
  }

  open(): this {
    document.body.append(this.el);
    this.el.showModal();
    // Back closes a dismissible dialog; a non-dismissible one (incoming call) stays until answered.
    this.releaseBack = backStack.push(() => {
      if (!this.dismissible) return false;
      this.close();
    });
    return this;
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  get isOpen(): boolean {
    return this.el.open;
  }
}
