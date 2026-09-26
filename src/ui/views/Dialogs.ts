import type { AppContext } from '../../app';
import { logHub } from '../../core/logger';
import type { AudioQualityPreset, IceTestMode, VideoQualityPreset } from '../../services/SettingsService';
import type { AudienceMode, MediaKind } from '../../types/signaling';
import type { LiveInvite } from '../../calls/LiveStreamManager';
import type { CallState } from '../../types/state';
import { colorFor, h, initials, nodes } from '../dom';
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
  let version = '';
  void app.pwa.version().then((v) => {
    version = v ?? '';
    if (m.isOpen) render();
  });
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
      'install-required': 'Install MeshCall to your Home Screen first (iOS requirement)',
      'not-configured': 'No push relay configured for this deployment (VITE_PUSH_SERVER_URL)',
      available: 'Off',
      denied: 'Blocked in browser settings',
      subscribed: 'On – you can be called while the app is closed',
      error: 'Error – see log',
    };
    const install = app.pwa.installState;
    const installText: Record<string, string> = {
      installed: 'Installed – running as an app',
      available: 'Can be installed on this device',
      'ios-manual': 'Install via Share → Add to Home Screen',
      unavailable: 'Use your browser menu → "Install app" / "Add to Home screen" (if offered)',
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
          pushStatus === 'subscribed' ? h('button', { class: 'btn', onclick: () => void app.push.disable().then(render) }, 'Turn off push notifications') : null,
          pushStatus === 'install-required' ? h('button', { class: 'btn', onclick: () => openInstallHelp(app) }, 'How to install') : null,
          app.notifications.permission === 'default'
            ? h('button', { class: 'btn', onclick: () => void app.notifications.requestPermission().then(render) }, 'Allow notifications while backgrounded')
            : null,
          app.notifications.permission === 'granted'
            ? h('button', { class: 'btn', onclick: () => void app.notifications.showTest() }, 'Send a test notification')
            : null,
        ),
        h(
          'section',
          {},
          h('h3', {}, 'App'),
          h('p', {}, installText[install]),
          install === 'available' ? h('button', { class: 'btn primary', onclick: () => void app.pwa.promptInstall().then(render) }, h('span', { html: icons.download }), 'Install MeshCall') : null,
          install === 'ios-manual' ? h('button', { class: 'btn', onclick: () => openInstallHelp(app) }, 'Show me how') : null,
          h('p', { class: 'hint' }, `Offline app shell: ${app.pwa.registration ? 'on' : 'unavailable'}${version ? ` · version ${version}` : ''}`),
          app.pwa.updateReady
            ? h('button', { class: 'btn primary', onclick: () => app.pwa.applyUpdate() }, 'Reload to update')
            : h('button', { class: 'btn small', onclick: () => void app.pwa.checkForUpdate().then(() => setTimeout(render, 1500)) }, 'Check for updates'),
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

/** Multi-select of room users: used to add people to a 1:1 (→ group) or group call. */
export function openAddParticipants(app: AppContext): Modal {
  const c = app.calls.state;
  const m = new Modal(c?.kind === 'direct' ? 'Add participants' : 'Add to call');
  const inCall = new Set([...(c?.participants.keys() ?? []), ...app.calls.pendingInviteIds]);
  const users = app.presence.list().filter((u) => !inCall.has(u.deviceId));
  const chosen = new Set<string>();
  const add = h('button', { class: 'btn primary', disabled: true }, 'Add to Call');
  const max = app.config.mesh.maxParticipants - 1 - (c?.participants.size ?? 0) - app.calls.pendingInviteIds.length;
  add.addEventListener('click', () => {
    const invited = app.calls.addParticipants([...chosen]);
    if (invited.length) m.close();
  });
  m.setContent(
    ...nodes(
      c?.kind === 'direct' ? h('p', { class: 'hint' }, 'This 1:1 call becomes a group call. Your current connection stays up – only new connections are set up for the people you add.') : null,
      users.length && max > 0
        ? h(
            'ul',
            { class: 'pick-list' },
            ...users.map((u) => {
              const reachable = u.status === 'online' || u.pushEnabled;
              const cb = h('input', { type: 'checkbox', disabled: !reachable, 'data-user': u.deviceId });
              cb.addEventListener('change', () => {
                if (cb.checked && chosen.size >= max) {
                  cb.checked = false;
                  return;
                }
                if (cb.checked) chosen.add(u.deviceId);
                else chosen.delete(u.deviceId);
                add.disabled = chosen.size === 0;
                add.textContent = chosen.size > 1 ? `Add ${chosen.size} to Call` : 'Add to Call';
              });
              return h(
                'li',
                {},
                h('label', {}, cb, h('span', { class: `dot ${u.status}` }), h('span', { class: 'grow' }, u.name), h('small', {}, u.busy ? 'in another call' : reachable ? u.status : 'offline')),
              );
            }),
          )
        : h('p', { class: 'hint' }, max <= 0 ? `The call is full (mesh limit ${app.config.mesh.maxParticipants}).` : 'Nobody else is available in this room.'),
      h('p', { class: 'hint' }, `Mesh: every participant sends a separate stream to every other participant (max ${app.config.mesh.maxParticipants}).`),
      h('div', { class: 'modal-actions' }, add),
    ),
  );
  return m.open();
}

/** Everyone / Selected members + room-user checklist (Go live & Manage audience). */
function audiencePicker(app: AppContext, mode: AudienceMode, selected: Set<string>, onChange: () => void) {
  const state = { mode, ids: new Set(selected) };
  const users = app.presence.list();
  const list = h(
    'ul',
    { class: 'pick-list audience-pick' },
    ...(users.length
      ? users.map((u) => {
          const cb = h('input', { type: 'checkbox', checked: state.ids.has(u.deviceId), 'data-user': u.deviceId });
          cb.addEventListener('change', () => {
            if (cb.checked) state.ids.add(u.deviceId);
            else state.ids.delete(u.deviceId);
            onChange();
          });
          return h('li', {}, h('label', {}, cb, h('span', { class: `dot ${u.status}` }), h('span', { class: 'grow' }, u.name), h('small', {}, u.status)));
        })
      : [h('li', { class: 'empty' }, 'Nobody else is in this room yet.')]),
  );
  const radio = (value: AudienceMode, label: string, hint: string) => {
    const input = h('input', { type: 'radio', name: 'audience', value, checked: state.mode === value });
    input.addEventListener('change', () => {
      state.mode = value;
      list.hidden = value !== 'selected';
      onChange();
    });
    return h('label', { class: 'radio-row' }, input, h('span', {}, h('strong', {}, label), h('small', {}, hint)));
  };
  list.hidden = state.mode !== 'selected';
  const el = h(
    'fieldset',
    { class: 'audience-fieldset' },
    h('legend', {}, 'Who can watch?'),
    radio('everyone', 'Everyone', 'Anyone in this room can join'),
    radio('selected', 'Selected participants', 'Only the people you pick receive the stream'),
    list,
  );
  return { el, state };
}

export function openGoLive(app: AppContext): Modal {
  const m = new Modal('Go live', { className: 'wide-sm' });
  const title = h('input', { type: 'text', placeholder: `${app.identity.displayName}'s stream`, maxlength: 60 });
  const start = h('button', { class: 'btn primary' }, 'Start Live Stream');
  const picker = audiencePicker(app, 'everyone', new Set(), () => {
    start.disabled = picker.state.mode === 'selected' && picker.state.ids.size === 0;
  });
  start.addEventListener('click', () => {
    m.close();
    void app.live.goLive(title.value.trim(), { mode: picker.state.mode, viewerIds: [...picker.state.ids] });
  });
  m.setContent(
    field('Title', title),
    picker.el,
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

/** Streamer: change the audience while live. Removed viewers stop receiving immediately. */
export function openManageAudience(app: AppContext): Modal | null {
  const st = app.live.state;
  if (!st?.streamId) return null;
  const m = new Modal('Manage audience', { className: 'wide-sm' });
  const update = h('button', { class: 'btn primary' }, 'Update Audience');
  const picker = audiencePicker(app, st.audienceMode, st.selectedViewerIds, () => undefined);
  update.addEventListener('click', () => {
    app.live.updateAudience(picker.state.mode, [...picker.state.ids]);
    m.close();
  });
  m.setContent(
    picker.el,
    h('p', { class: 'hint' }, 'Viewers you remove are disconnected at once – the stream is no longer sent to them. People you add are invited and connect peer-to-peer (TURN only if needed).'),
    h('div', { class: 'modal-actions' }, update),
  );
  return m.open();
}

/** Viewer: the streamer added you to a (selected-audience) live stream. */
export function openLiveInvite(app: AppContext, invite: LiveInvite): Modal {
  const m = new Modal('Live stream invitation');
  m.setContent(
    h('div', { class: 'avatar big', style: `--avatar:${colorFor(invite.hostId)}` }, initials(invite.hostName)),
    h('p', { class: 'incoming-text' }, `${invite.hostName} added you to the live stream “${invite.title}”`),
    h(
      'div',
      { class: 'modal-actions' },
      h('button', { class: 'btn', onclick: () => m.close() }, 'Not now'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () => {
            m.close();
            app.live.watch(invite);
          },
        },
        'Watch',
      ),
    ),
  );
  return m.open();
}

/** Install instructions – iOS has no install prompt API; elsewhere this explains the browser menu. */
export function openInstallHelp(app: AppContext): Modal {
  const m = new Modal('Install MeshCall');
  const ios = app.pwa.installState === 'ios-manual';
  m.setContent(
    ...nodes(
    h('div', { class: 'install-hero' }, h('img', { src: `${import.meta.env.BASE_URL}icons/icon-192.png`, alt: '', width: 72, height: 72 }), h('p', {}, 'Install MeshCall for a full-screen app with its own icon, faster start-up, and call notifications while it is closed.')),
    ios
      ? h(
          'ol',
          { class: 'install-steps' },
          h('li', {}, 'Tap the ', h('span', { class: 'inline-icon', html: icons.share }), ' Share button in Safari'),
          h('li', {}, 'Choose ', h('strong', {}, 'Add to Home Screen')),
          h('li', {}, 'Open MeshCall from your Home Screen and enable notifications in Settings'),
        )
      : h(
          'ol',
          { class: 'install-steps' },
          h('li', {}, 'Open your browser menu (⋮ or ⋯)'),
          h('li', {}, 'Choose ', h('strong', {}, 'Install app'), ' or ', h('strong', {}, 'Add to Home screen')),
        ),
    ios ? h('p', { class: 'hint' }, 'On iPhone and iPad, web push notifications only work for apps added to the Home Screen (iOS 16.4+).') : null,
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', onclick: () => m.close() }, 'Got it')),
    ),
  );
  return m.open();
}
