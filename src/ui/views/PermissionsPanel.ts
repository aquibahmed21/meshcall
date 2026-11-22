import { native, type PermissionStatus, type PermState } from '../../native/native';
import { h } from '../dom';
import { icons } from '../icons';

type Key = keyof PermissionStatus;

interface Row {
  key: Key;
  icon: string;
  title: string;
  why: string;
  /** 'runtime' → system dialog; others open their own system screen. */
  kind: 'runtime' | 'fullScreen' | 'battery';
}

const ROWS: Row[] = [
  { key: 'microphone', icon: icons.mic, title: 'Microphone', why: 'So people can hear you in calls', kind: 'runtime' },
  { key: 'camera', icon: icons.cam, title: 'Camera', why: 'For video calls and live streams', kind: 'runtime' },
  { key: 'notifications', icon: icons.bell, title: 'Notifications', why: 'Incoming calls and messages', kind: 'runtime' },
  { key: 'bluetooth', icon: icons.volume, title: 'Nearby devices', why: 'Use Bluetooth headsets and car audio', kind: 'runtime' },
  { key: 'fullScreen', icon: icons.phone, title: 'Full-screen call alerts', why: 'Show incoming calls over the lock screen', kind: 'fullScreen' },
  { key: 'battery', icon: icons.refresh, title: 'Unrestricted battery', why: 'Lets MeshCall keep running so calls always ring', kind: 'battery' },
];

const chip = (text: string, tone: string) => h('span', { class: `notif-chip ${tone}` }, text);

/**
 * Android permission list with live status. Each row can be granted from here, and a denied
 * permission links straight to MeshCall's system settings page. Used by the first-run screen and
 * by Settings → Device. Refreshes itself when the user returns from the system settings.
 */
export function renderPermissionsPanel(onChange?: (s: PermissionStatus) => void): HTMLElement {
  const list = h('div', { class: 'notif-list' });
  const root = h('section', { class: 'notif-settings perm-panel' }, h('h3', {}, 'App permissions'), list);
  let status: PermissionStatus | null = null;
  let off: (() => void) | null = null;

  const act = async (row: Row, state: PermState) => {
    if (row.kind === 'runtime') {
      // First ask (or a re-ask Android still allows); once it is "denied" the system dialog will
      // not show again, so go straight to the app's settings page.
      if (state === 'denied') await native.openAppSettings();
      else status = await native.requestRuntimePermissions();
    } else if (row.kind === 'fullScreen') await native.requestFullScreenIntent();
    else await native.requestBatteryExemption();
    await refresh();
  };

  const draw = () => {
    if (!status) return;
    const s = status;
    list.replaceChildren(
      ...ROWS.map((row) => {
        const state = s[row.key];
        const ok = state === 'granted';
        const btn = ok
          ? chip('Allowed', 'ok')
          : h(
              'button',
              { class: `btn small${state === 'prompt' ? ' primary' : ''}`, type: 'button', onclick: () => void act(row, state) },
              row.kind === 'runtime' ? (state === 'denied' ? 'Open settings' : 'Allow') : 'Allow…',
            );
        return h(
          'div',
          { class: 'notif-row', 'data-perm': row.key, 'data-state': state },
          h('span', { class: 'notif-row-icon', html: row.icon, 'aria-hidden': 'true' }),
          h('div', { class: 'grow' }, h('strong', {}, row.title, ok ? null : h('span', { class: 'red-dot', title: 'Not granted' })), h('small', {}, row.why)),
          btn,
        );
      }),
    );
    // Phone makers (Xiaomi, Oppo, Vivo, Huawei, Samsung…) add their own "autostart / sleeping apps"
    // switch that Android cannot read – so this row is always offered, never a red dot.
    list.append(
      h(
        'div',
        { class: 'notif-row', 'data-perm': 'autostart' },
        h('span', { class: 'notif-row-icon', html: icons.refresh, 'aria-hidden': 'true' }),
        h('div', { class: 'grow' }, h('strong', {}, 'Autostart / never sleeping'), h('small', {}, 'Some phones close MeshCall unless you allow it here')),
        h('button', { class: 'btn small', type: 'button', onclick: () => void native.openAutostartSettings() }, 'Open…'),
      ),
    );
    onChange?.(s);
  };

  const refresh = async () => {
    status = await native.permissionStatus();
    draw();
  };

  const watch = () => {
    off?.();
    off = native.events.on('resume', () => {
      if (!root.isConnected) return off?.();
      void refresh();
    });
  };
  watch();
  void refresh();
  return root;
}

/**
 * First launch on Android: explain and request everything MeshCall needs, once. Nothing here is
 * mandatory – "Continue" always works, and every item stays available in Settings → Device.
 */
export function renderPermissionsScreen(root: HTMLElement, onDone: () => void): void {
  const panel = renderPermissionsPanel();
  const allow = h('button', { class: 'btn primary', type: 'button' }, 'Allow all');
  allow.addEventListener('click', async () => {
    allow.disabled = true;
    await native.requestRuntimePermissions(); // microphone, camera, notifications, nearby devices
    const s = await native.permissionStatus();
    if (s.fullScreen !== 'granted') await native.requestFullScreenIntent();
    else if (s.battery !== 'granted') await native.requestBatteryExemption();
    allow.disabled = false;
  });
  const cont = h('button', { class: 'btn', type: 'button' }, 'Continue');
  cont.addEventListener('click', () => {
    native.markSetupDone();
    onDone();
  });
  root.replaceChildren(
    h(
      'div',
      { class: 'onboarding-wrap' },
      h(
        'div',
        { class: 'onboarding card perm-screen' },
        h('h1', {}, 'Allow MeshCall to work'),
        h('p', { class: 'hint' }, 'So calls ring even when the app is closed or the phone is locked. You can change any of these later in Settings → Device.'),
        panel,
        h('div', { class: 'perm-actions' }, allow, cont),
      ),
    ),
  );
}
