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
  const permLabel: Record<string, string> = { granted: 'Enabled', denied: 'Blocked by browser', default: 'Not enabled yet', unsupported: 'Unavailable' };
  return h(
    'section',
    { class: 'notif-settings' },
    h('h3', {}, 'Notifications'),
    h('div', { class: 'setting-row' }, h('div', { class: 'grow' }, h('strong', {}, 'Incoming calls'), h('small', {}, PUSH_STATUS_LABEL[status])), toggle),
    h('div', { class: 'setting-row' }, h('div', { class: 'grow' }, h('strong', {}, 'Browser notifications'), h('small', {}, permLabel[perm] ?? perm))),
    ...nodes(
      status === 'denied' || perm === 'denied'
        ? h('p', { class: 'notice' }, h('strong', {}, 'Notifications are blocked. '), unblockHelp(), ' MeshCall will not ask again until you change this.')
        : null,
      status === 'install-required' ? h('button', { class: 'btn small', onclick: () => void import('./Dialogs').then((d) => d.openInstallHelp(app)) }, 'How to install') : null,
      status === 'unavailable' ? h('button', { class: 'btn small', onclick: () => void push.refreshSubscription().then(rerender) }, 'Retry') : null,
      h(
        'p',
        { class: 'hint' },
        on
          ? 'While MeshCall is in the background you get a system notification for incoming calls. Note: the current push server cannot target a single person, so MeshCall cannot yet wake a closed app for a call (see Diagnostics → Push).'
          : 'Allow MeshCall to notify you about incoming calls even when the app is not focused.',
      ),
      perm === 'granted' ? h('button', { class: 'btn small', onclick: () => void app.notifications.showTest() }, 'Show a test notification') : null,
      import.meta.env.DEV && on
        ? h(
            'button',
            {
              class: 'btn small danger-ghost',
              title: 'Development only – sends to EVERY subscriber of the push server',
              onclick: async () => {
                if (!confirm('DEV ONLY: /notifyAll sends "MeshCall Test" to EVERY subscriber of the push server. Continue?')) return;
                try {
                  alert(await push.broadcastTest());
                } catch (err) {
                  alert(`Broadcast test failed: ${(err as Error).message}`);
                }
              },
            },
            'Dev: broadcast test (/notifyAll)',
          )
        : null,
    ),
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
    h('div', { class: 'enable-card-head' }, h('span', { html: icons.bell }), h('strong', {}, 'Enable Notifications')),
    h('p', {}, 'Allow MeshCall to notify you about incoming calls even when the app is not focused.'),
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
      s === 'unavailable' ? 'Retry – Enable Notifications' : 'Enable Notifications',
    ),
  );
}
