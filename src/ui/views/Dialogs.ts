import type { AppContext } from '../../app';
import { logHub } from '../../core/logger';
import type { AudioQualityPreset, IceTestMode, VideoQualityPreset } from '../../services/SettingsService';
import type { MediaKind } from '../../types/signaling';
import type { CallState } from '../../types/state';
import { colorFor, h, initials } from '../dom';
import { icons } from '../icons';
import { Modal } from './Modal';

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
}

function select<T extends string>(options: Array<[T, string]>, value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = h('select', {}, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}

function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: value });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle' }, input, h('span', {}, label));
}

export function openSettings(app: AppContext): Modal {
  const m = new Modal('Settings', { className: 'wide' });
  const render = () => {
    const s = app.settings.get();
    const d = app.devices.devices;
    const devOpts = (list: MediaDeviceInfo[], kind: string): Array<[string, string]> => [
      ['', 'System default'],
      ...list.filter((x) => x.deviceId && x.deviceId !== 'default').map((x, i): [string, string] => [x.deviceId, x.label || `${kind} ${i + 1}`]),
    ];
    const nameInput = h('input', { type: 'text', value: app.identity.displayName, maxlength: 40, autocomplete: 'nickname' });
    nameInput.addEventListener('change', () => {
      try {
        app.identity.setDisplayName(nameInput.value);
        app.signaling.reconnectNow('display name changed');
      } catch {
        nameInput.value = app.identity.displayName;
      }
    });
    const pushStatus = app.push.status;
    const pushText: Record<string, string> = {
      unsupported: 'Not supported in this browser',
      insecure: 'Requires HTTPS',
      'not-configured': 'Push relay not configured (VITE_PUSH_SERVER_URL)',
      available: 'Off',
      denied: 'Blocked in browser settings',
      subscribed: 'On – you can be called while the app is closed',
      error: 'Error – see log',
    };
    m.setContent(
      h(
        'div',
        { class: 'settings-grid' },
        h('section', {}, h('h3', {}, 'Profile'), field('Display name', nameInput, `Device ID ${app.identity.deviceId}`)),
        h(
          'section',
          {},
          h('h3', {}, 'Devices'),
          field('Microphone', select(devOpts(d.audioinput, 'Microphone'), s.audioInputId ?? '', (v) => void app.media.switchDevice('audioinput', v || null))),
          field('Camera', select(devOpts(d.videoinput, 'Camera'), s.videoInputId ?? '', (v) => void app.media.switchDevice('videoinput', v || null))),
          d.outputSelectable
            ? field('Speaker', select(devOpts(d.audiooutput, 'Speaker'), s.audioOutputId ?? '', (v) => app.settings.update({ audioOutputId: v || null })))
            : h('p', { class: 'hint' }, 'Speaker selection is not supported by this browser.'),
          d.audioinput.length && !d.audioinput[0]!.label ? h('p', { class: 'hint' }, 'Device names appear after granting camera/microphone permission.') : null,
        ),
        h(
          'section',
          {},
          h('h3', {}, 'Quality'),
          field(
            'Video',
            select<VideoQualityPreset>(
              [['auto', 'Auto (adaptive)'], ['low', 'Low (180p)'], ['360p', '360p'], ['480p', '480p'], ['720p', '720p'], ['1080p', '1080p']],
              s.videoQuality,
              (v) => app.settings.update({ videoQuality: v }),
            ),
            'Applied live via RTCRtpSender.setParameters – no reconnect.',
          ),
          field('Audio', select<AudioQualityPreset>([['low', 'Low (16 kbps)'], ['standard', 'Standard (32 kbps)'], ['high', 'High (64 kbps)']], s.audioQuality, (v) => app.settings.update({ audioQuality: v }))),
          toggle('Echo cancellation', s.echoCancellation, (v) => app.settings.update({ echoCancellation: v })),
          toggle('Noise suppression', s.noiseSuppression, (v) => app.settings.update({ noiseSuppression: v })),
          toggle('Auto gain control', s.autoGainControl, (v) => app.settings.update({ autoGainControl: v })),
        ),
        h(
          'section',
          {},
          h('h3', {}, 'Notifications'),
          h('p', {}, `Offline call alerts: ${pushText[pushStatus] ?? pushStatus}`),
          pushStatus === 'available' ? h('button', { class: 'btn', onclick: () => void app.push.enable().then(render) }, 'Enable push notifications') : null,
          app.notifications.permission === 'default'
            ? h('button', { class: 'btn', onclick: () => void app.notifications.requestPermission().then(render) }, 'Allow notifications while backgrounded')
            : null,
        ),
        h(
          'section',
          {},
          h('h3', {}, 'Advanced / testing'),
          field(
            'ICE test mode',
            select<IceTestMode>(
              [['normal', 'Normal – P2P first, TURN fallback'], ['relay-only', 'TEST: force TURN relay'], ['no-relay', 'TEST: disable TURN']],
              s.iceTestMode,
              (v) => app.settings.update({ iceTestMode: v }),
            ),
            'Test modes apply to NEW connections only and reset on reload. Never use them for normal calls.',
          ),
          field('Log level', select(['ERROR', 'WARN', 'INFO', 'DEBUG'].map((l): [string, string] => [l, l]), logHub.level, (v) => logHub.setLevel(v))),
        ),
      ),
    );
  };
  render();
  const off = app.devices.events.on('devices', render);
  m.onClose = off;
  return m.open();
}

export function openIncomingCall(app: AppContext, call: CallState): Modal {
  const m = new Modal(call.kind === 'group' ? 'Group call invitation' : `Incoming ${call.media} call`, { dismissible: false, className: 'incoming' });
  const who = call.remoteUser?.name ?? 'Someone';
  m.setContent(
    h('div', { class: 'avatar big pulse', style: `--avatar:${colorFor(call.remoteUser?.deviceId ?? '')}` }, initials(who)),
    h('p', { class: 'incoming-text' }, call.kind === 'group' ? `${who} invites you to “${call.title ?? 'a group call'}”` : `${who} is calling you`),
    h(
      'div',
      { class: 'incoming-actions' },
      h('button', { class: 'round danger', 'aria-label': 'Decline', onclick: () => app.calls.rejectIncoming() }, h('span', { html: icons.hangup }), h('span', {}, 'Decline')),
      h('button', { class: 'round success', 'aria-label': 'Accept', autofocus: true, onclick: () => void app.calls.acceptIncoming() }, h('span', { html: call.media === 'video' ? icons.cam : icons.phone }), h('span', {}, 'Accept')),
    ),
  );
  return m.open();
}

export function openGroupCall(app: AppContext): Modal {
  const m = new Modal('New group call');
  const users = app.presence.list();
  const chosen = new Set<string>();
  let media: MediaKind = 'video';
  const name = h('input', { type: 'text', placeholder: 'Group name (optional)', maxlength: 40 });
  const start = h('button', { class: 'btn primary', disabled: true }, 'Start call');
  const max = app.config.mesh.maxParticipants - 1;
  const list = h(
    'ul',
    { class: 'pick-list' },
    ...users.map((u) => {
      const cb = h('input', { type: 'checkbox', disabled: u.status !== 'online' && !u.pushEnabled });
      cb.addEventListener('change', () => {
        if (cb.checked && chosen.size >= max) {
          cb.checked = false;
          return;
        }
        if (cb.checked) chosen.add(u.deviceId);
        else chosen.delete(u.deviceId);
        start.disabled = chosen.size === 0;
      });
      return h('li', {}, h('label', {}, cb, h('span', { class: `dot ${u.status}` }), h('span', { class: 'grow' }, u.name), h('small', {}, u.busy ? 'in a call' : u.status)));
    }),
  );
  const mediaSel = select<MediaKind>([['video', 'Video'], ['audio', 'Audio only']], media, (v) => (media = v));
  start.addEventListener('click', () => {
    m.close();
    void app.groups.create([...chosen], media, name.value.trim());
  });
  m.setContent(
    field('Name', name),
    field('Media', mediaSel),
    h('p', { class: 'hint' }, `Mesh topology: up to ${app.config.mesh.maxParticipants} people. Each participant uploads one stream per other participant.`),
    users.length ? list : h('p', { class: 'hint' }, 'Nobody else has been seen yet. Open the app on another device.'),
    h('div', { class: 'modal-actions' }, start),
  );
  return m.open();
}

export function openInvite(app: AppContext): Modal {
  const m = new Modal('Add participant');
  const inCall = new Set(app.calls.state?.participants.keys() ?? []);
  const users = app.presence.list().filter((u) => !inCall.has(u.deviceId));
  m.setContent(
    users.length
      ? h(
          'ul',
          { class: 'pick-list' },
          ...users.map((u) =>
            h(
              'li',
              {},
              h('span', { class: `dot ${u.status}` }),
              h('span', { class: 'grow' }, u.name),
              h(
                'button',
                {
                  class: 'btn small',
                  disabled: u.status !== 'online' && !u.pushEnabled,
                  onclick: () => {
                    app.groups.addParticipant(u.deviceId);
                    m.close();
                  },
                },
                'Invite',
              ),
            ),
          ),
        )
      : h('p', { class: 'hint' }, 'No other users available.'),
  );
  return m.open();
}

export function openGoLive(app: AppContext): Modal {
  const m = new Modal('Go live');
  const title = h('input', { type: 'text', placeholder: `${app.identity.displayName}'s stream`, maxlength: 60 });
  const start = h('button', { class: 'btn primary' }, 'Start streaming');
  start.addEventListener('click', () => {
    m.close();
    void app.live.goLive(title.value.trim());
  });
  m.setContent(
    field('Title', title),
    h(
      'div',
      { class: 'notice' },
      h('strong', {}, 'Mesh streaming limits. '),
      `Every viewer receives a separate copy of your stream straight from your device, so your upload is roughly bitrate × viewers (e.g. 8 viewers × 1 Mbps ≈ 8 Mbps up). Viewers are capped at ${app.config.mesh.maxLiveViewers}. There is no media server.`,
    ),
    h('div', { class: 'modal-actions' }, start),
  );
  return m.open();
}
