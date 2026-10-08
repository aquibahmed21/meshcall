import { h, nodes } from '../dom';
import { icons } from '../icons';
import { Modal } from './Modal';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action (red confirm button + warning icon). */
  danger?: boolean;
  icon?: string;
}

/**
 * In-app replacement for window.confirm(): same look as the rest of the app, and Back / Esc /
 * tapping outside count as "Cancel". Resolves true only for the confirm button.
 */
export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const m = new Modal(o.title, { className: `confirm${o.danger ? ' danger' : ''}` });
    const ok = h('button', { class: `btn ${o.danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => ((result = true), m.close()) }, o.confirmLabel ?? 'OK');
    m.setContent(
      ...nodes(
        h('div', { class: 'confirm-icon', html: o.icon ?? (o.danger ? icons.warn : icons.info), 'aria-hidden': 'true' }),
        h('h2', { class: 'confirm-title' }, o.title),
        o.message ? h('p', { class: 'confirm-text' }, o.message) : null,
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, o.cancelLabel ?? 'Cancel'), ok),
      ),
    );
    m.onClose = () => resolve(result);
    m.open();
    ok.focus();
  });
}

/** In-app replacement for window.alert(). */
export function alertDialog(title: string, message?: string): Promise<void> {
  return new Promise((resolve) => {
    const m = new Modal(title, { className: 'confirm' });
    const ok = h('button', { class: 'btn primary', type: 'button', onclick: () => m.close() }, 'OK');
    m.setContent(
      ...nodes(
        h('div', { class: 'confirm-icon', html: icons.info, 'aria-hidden': 'true' }),
        h('h2', { class: 'confirm-title' }, title),
        message ? h('p', { class: 'confirm-text' }, message) : null,
        h('div', { class: 'modal-actions' }, ok),
      ),
    );
    m.onClose = () => resolve();
    m.open();
    ok.focus();
  });
}
