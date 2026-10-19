import { alertDialog, confirmDialog } from './ConfirmDialog';
import type { AppContext } from '../../app';
import { PUSH_STATUS_LABEL } from '../../services/PushNotificationService';
import { PwaService } from '../../services/PwaService';
import { h, nodes } from '../dom';
import { icons } from '../icons';

/** Browser-specific "how to unblock notifications" – shown instead of re-prompting. */
function unblockHelp(): string {
  const ua = navigator.userAgent;
  if (PwaService.isIos()) return 'iOS: Settings → Notifications → MeshCall → Allow Notifications.';
  if (/Firefox\//.test(ua)) return 'Firefox: click the lock icon in the address bar → Permissions → Send Notifications → Allow, then reload.';
  if (/Edg\//.test(ua)) return 'Edge: click the lock icon in the address bar → Permissions for this site → Notifications → Allow, then reload.';
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'Safari: Settings → Websites → Notifications → allow this site, then reload.';
  return 'Chrome: click the icon left of the address bar → Site settings → Notifications → Allow, then reload.';
}

/**
 * Settings → Notifications. Two separate things:
 *  - Browser notifications (permission) → incoming calls while the tab is in the background
 *  - Incoming calls when closed (Web Push subscription with the push server)
 */
export function renderNotificationSettings(app: AppContext, rerender: () => void): HTMLElement {
  const { push } = app;
  const status = push.status;
  const perm = push.getPermissionState();
  const on = status === 'enabled';
  const busy = status === 'connecting';
  const canToggle = on || status === 'disabled' || status === 'unavailable' || status === 'error';
  const toggle = h(
    'button',
    {
      class: `switch${on ? ' on' : ''}`,
      role: 'switch',
      'aria-checked': String(on),
      'aria-label': 'Incoming call notifications',
      disabled: busy || !canToggle,
      onclick: () => void (on ? push.unsubscribe() : push.subscribe()).then(rerender),
    },
    h('span', { class: 'switch-knob' }),
  );
  const blocked = status === 'denied' || perm === 'denied';
  const permChip: Record<string, [string, string]> = {
    granted: ['Allowed', 'ok'],
    denied: ['Blocked', 'bad'],
    default: ['Not asked', 'muted'],
    unsupported: ['Unavailable', 'muted'],
  };
  const [permText, permTone] = permChip[perm] ?? [String(perm), 'muted'];
  const state = on ? 'on' : busy ? 'busy' : blocked ? 'blocked' : 'off';
  const chip = (text: string, tone: string) => h('span', { class: `notif-chip ${tone}` }, text);

  // Re-subscribing needs a working push setup (not blocked / unsupported / not installed on iOS).
  const canResubscribe = canToggle && perm !== 'denied';
  const action = (icon: string, label: string, run: (b: HTMLButtonElement) => unknown, opts: { title?: string; disabled?: boolean; cls?: string } = {}) =>
    h(
      'button',
      {
        class: `btn small ${opts.cls ?? ''}`.trim(),
        type: 'button',
        title: opts.title ?? '',
        disabled: !!opts.disabled,
        onclick: (e: Event) => void run(e.currentTarget as HTMLButtonElement),
      },
      h('span', { html: icon, 'aria-hidden': 'true' }),
      label,
    );

  const hero = h(
    'div',
    { class: `notif-hero ${state}`, role: 'status', 'data-state': status },
    h('span', { class: 'notif-hero-icon', html: icons.bell, 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'grow' },
      h('strong', {}, on ? 'Notifications are on' : busy ? 'Setting up notifications…' : blocked ? 'Notifications are blocked' : 'Notifications are off'),
      h('small', {}, on ? 'Calls and messages reach this device even when MeshCall is closed.' : status === 'disabled' ? 'Turn on to get calls and messages while MeshCall is closed.' : PUSH_STATUS_LABEL[status]),
    ),
    chip(on ? 'On' : busy ? 'Wait' : blocked ? 'Blocked' : 'Off', on ? 'ok' : blocked ? 'bad' : 'muted'),
  );

  const list = h(
    'div',
    { class: 'notif-list' },
    h(
      'div',
      { class: 'notif-row' },
      h('span', { class: 'notif-row-icon', html: icons.phone, 'aria-hidden': 'true' }),
      h('div', { class: 'grow' }, h('strong', {}, 'Calls & messages when closed'), h('small', {}, PUSH_STATUS_LABEL[status])),
      toggle,
    ),
    h(
      'div',
      { class: 'notif-row' },
      h('span', { class: 'notif-row-icon', html: icons.info, 'aria-hidden': 'true' }),
      h('div', { class: 'grow' }, h('strong', {}, 'Browser permission'), h('small', {}, 'Lets MeshCall show alerts while it runs in the background')),
      chip(permText, permTone),
    ),
  );

  const actions = h(
    'div',
    { class: 'notif-actions' },
    ...nodes(
      perm === 'granted' ? action(icons.bell, 'Send test', () => app.notifications.showTest()) : null,
      action(
        icons.refresh,
        on ? 'Re-subscribe' : 'Subscribe',
        async (b) => {
          b.disabled = true;
          b.lastChild!.textContent = on ? 'Re-subscribing…' : 'Subscribing…';
          await (on ? push.resubscribe() : push.subscribe());
          rerender();
        },
        { title: 'Remove this device’s push subscription and create a fresh one', disabled: busy || !canResubscribe },
      ),
      status === 'install-required' ? action(icons.download, 'How to install', () => import('./Dialogs').then((d) => d.openInstallHelp(app))) : null,
      status === 'unavailable' ? action(icons.refresh, 'Retry', () => push.refreshSubscription().then(rerender)) : null,
      import.meta.env.DEV && on
        ? action(
            icons.warn,
            'Dev: /notifyAll',
            async () => {
              if (!(await confirmDialog({ title: 'Broadcast test?', message: 'DEV ONLY: /notifyAll sends “MeshCall Test” to EVERY subscriber of the push server.', confirmLabel: 'Send', danger: true }))) return;
              try {
                await alertDialog('Broadcast sent', await push.broadcastTest());
              } catch (err) {
                await alertDialog('Broadcast failed', (err as Error).message);
              }
            },
            { title: 'Development only – sends to EVERY subscriber of the push server', cls: 'danger-ghost' },
          )
        : null,
    ),
  );

  return h(
    'section',
    { class: 'notif-settings' },
    h('h3', {}, 'Notifications'),
    hero,
    list,
    ...nodes(
      blocked
        ? h(
            'div',
            { class: 'notif-alert', role: 'note' },
            h('span', { html: icons.warn, 'aria-hidden': 'true' }),
            h('div', {}, h('strong', {}, 'Unblock notifications'), h('small', {}, `${unblockHelp()} MeshCall won't ask again until you change this.`)),
          )
        : null,
    ),
    actions,
  );
}

/** Idle-screen card: explicit opt-in (permission is only requested from this click). */
export function renderEnableNotificationsCard(app: AppContext, rerender: () => void): HTMLElement | null {
  const s = app.push.status;
  if (s === 'denied') {
    return h('div', { class: 'enable-card blocked' }, h('strong', {}, 'Notifications are blocked'), h('p', {}, unblockHelp()));
  }
  if (s !== 'disabled' && s !== 'unavailable') return null;
  return h(
    'div',
    { class: 'enable-card' },
    h(
      'button',
      {
        class: 'btn primary',
        onclick: async (e: Event) => {
          (e.currentTarget as HTMLButtonElement).disabled = true;
          await app.push.subscribe();
          rerender();
        },
      },
      h('span', { html: icons.bell }),
      s === 'unavailable' ? 'Retry notifications' : 'Enable notifications',
    ),
  );
}
