import type { AppContext } from '../../app';
import { isTerminal } from '../../calls/CallStateMachine';
import { formatBitrate, formatBytes, formatDuration } from '../../core/format';
import { MediaManager, type MediaSnapshot } from '../../media/MediaManager';
import type { CallState, CallStatus, ParticipantState } from '../../types/state';
import type { DataUsageSnapshot } from '../../webrtc/DataUsageMonitor';
import type { StatsReport } from '../../webrtc/StatsMonitor';
import { colorFor, h, initials, nodes } from '../dom';
import { icons } from '../icons';
import { VideoGrid, type TileModel } from './VideoGrid';

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: '',
  calling: 'Calling…',
  ringing: 'Ringing…',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  ended: 'Call ended',
  failed: 'Call failed',
  rejected: 'Call declined',
  busy: 'Busy',
};

function peerProblem(p: ParticipantState): string | undefined {
  const s = p.peer;
  if (!s) return p.role === 'viewer' ? undefined : 'Connecting…';
  switch (s.connectionState) {
    case 'connected':
      return undefined;
    case 'new':
    case 'connecting':
      return s.connectedAt ? 'Reconnecting…' : 'Connecting…';
    case 'disconnected':
    case 'failed':
      return 'Reconnecting…';
    default:
      return undefined;
  }
}

export interface CallViewCallbacks {
  onInvite: () => void;
  onToggleDiagnostics: () => void;
  onBack: () => void;
}

export class CallView {
  readonly el: HTMLElement;
  private grid: VideoGrid;
  private title = h('div', { class: 'call-title' });
  private status = h('span', { class: 'call-status' });
  private timer = h('span', { class: 'call-timer' });
  private usage = h('span', { class: 'call-usage', title: 'Data used in this call' });
  private overlay = h('div', { class: 'call-overlay', hidden: true });
  private controls = h('div', { class: 'controls', role: 'toolbar', 'aria-label': 'Call controls' });
  private people = h('div', { class: 'people-panel', hidden: true });
  private audioUnlock = h('button', { class: 'btn primary audio-unlock', hidden: true }, 'Tap to enable audio');
  private tick: ReturnType<typeof setInterval>;
  private peopleOpen = false;
  private lastUsage: DataUsageSnapshot | null = null;
  private lastStats: StatsReport | null = null;

  constructor(
    private readonly app: AppContext,
    private readonly cb: CallViewCallbacks,
  ) {
    this.grid = new VideoGrid(() => (this.audioUnlock.hidden = false));
    this.audioUnlock.addEventListener('click', () => {
      this.grid.resumePlayback();
      this.audioUnlock.hidden = true;
    });
    const back = h('button', { class: 'icon-btn mobile-only', 'aria-label': 'Back to contacts', html: icons.back, onclick: () => cb.onBack() });
    this.el = h(
      'section',
      { class: 'call', 'aria-live': 'polite' },
      h('header', { class: 'call-header' }, back, h('div', { class: 'call-heading' }, this.title, h('div', { class: 'call-meta' }, this.status, this.timer, this.usage))),
      this.grid.el,
      this.overlay,
      this.audioUnlock,
      this.people,
      this.controls,
    );
    this.tick = setInterval(() => this.renderTimer(), 1000);
  }

  dispose(): void {
    clearInterval(this.tick);
    this.grid.dispose();
  }

  onStats(report: StatsReport, usage: DataUsageSnapshot): void {
    this.lastStats = report;
    this.lastUsage = usage;
    this.usage.textContent = `↑ ${formatBytes(usage.uploadBytes)} ↓ ${formatBytes(usage.downloadBytes)}`;
    this.render();
  }

  render(): void {
    const c = this.app.calls.state;
    if (!c) return;
    const m = this.app.media.state;
    this.el.dataset.status = c.status;
    this.el.dataset.kind = c.kind;
    this.title.textContent =
      c.kind === 'live' ? `🔴 ${c.title ?? 'Live stream'}` : c.kind === 'group' ? (c.title ?? 'Group call') : (c.remoteUser?.name ?? 'Call');
    this.status.textContent = c.statusDetail && c.status !== 'connected' ? `${STATUS_LABEL[c.status]} · ${c.statusDetail}` : c.statusDetail ?? STATUS_LABEL[c.status];
    this.status.dataset.status = c.status;
    this.renderTimer();
    this.renderOverlay(c);
    this.grid.update(this.tiles(c), this.app.settings.get().audioOutputId);
    this.renderControls(c, m);
    this.renderPeople(c);
  }

  private tiles(c: CallState): TileModel[] {
    const m = this.app.media.state;
    const tiles: TileModel[] = [];
    const session = this.app.calls.session;
    for (const p of c.participants.values()) {
      if (c.kind === 'live' && c.role === 'broadcaster') continue; // broadcaster sees viewer count, not viewers
      if (c.kind === 'live' && p.role === 'viewer') continue;
      const snap = this.lastStats?.peers.get(p.deviceId);
      tiles.push({
        id: p.deviceId,
        name: p.name,
        stream: session ? session.remoteStream(p.deviceId) : null,
        local: false,
        audioMuted: p.media.audioMuted,
        videoMuted: p.media.videoMuted && !p.media.screenSharing,
        screen: p.media.screenSharing,
        connection: peerProblem(p),
        pathType: p.peer?.connectionState === 'connected' ? p.peer.selectedPath?.connectionType : undefined,
        quality: snap?.quality,
      });
    }
    if (c.role !== 'viewer') {
      const local: TileModel = {
        id: 'local',
        name: this.app.identity.displayName,
        stream: this.app.media.stream,
        local: true,
        audioMuted: m.audioMuted || !m.hasAudio,
        videoMuted: !m.hasVideo,
        screen: m.screenSharing,
      };
      tiles.push(local);
    }
    return tiles;
  }

  private renderOverlay(c: CallState): void {
    const showFor = c.status === 'calling' || c.status === 'ringing' || isTerminal(c.status) || (c.kind === 'direct' && c.status === 'connecting' && c.participants.size === 0);
    const liveEmpty = c.kind === 'live' && c.role === 'broadcaster';
    if (!showFor && !liveEmpty) {
      this.overlay.hidden = true;
      return;
    }
    this.overlay.hidden = false;
    const who = c.remoteUser?.name ?? c.title ?? '';
    const viewers = [...c.participants.values()].filter((p) => p.role === 'viewer').length;
    const text = liveEmpty && !isTerminal(c.status)
      ? `You are live · ${viewers}/${this.app.config.mesh.maxLiveViewers} viewer${viewers === 1 ? '' : 's'}`
      : c.statusDetail ?? STATUS_LABEL[c.status];
    this.overlay.replaceChildren(
      ...nodes(
      h('div', { class: `avatar big${c.status === 'calling' || c.status === 'ringing' ? ' pulse' : ''}`, style: `--avatar:${colorFor(c.remoteUser?.deviceId ?? c.callId)}` }, initials(who || '?')),
      h('div', { class: 'overlay-name' }, liveEmpty ? (c.title ?? 'Live') : who),
      h('div', { class: 'overlay-text' }, text),
      liveEmpty && !isTerminal(c.status)
        ? h('div', { class: 'overlay-hint' }, 'Mesh streaming uploads one full copy per viewer – keep the viewer count small.')
        : null,
      ),
    );
    this.overlay.classList.toggle('compact', liveEmpty);
  }

  private renderControls(c: CallState, m: MediaSnapshot): void {
    const calls = this.app.calls;
    const active = !isTerminal(c.status);
    const viewer = c.role === 'viewer';
    const btn = (label: string, icon: string, on: () => void, opts: { active?: boolean; danger?: boolean; hidden?: boolean; disabled?: boolean } = {}) =>
      opts.hidden
        ? null
        : h(
            'button',
            {
              class: `ctrl${opts.active ? ' on' : ''}${opts.danger ? ' danger' : ''}`,
              'aria-label': label,
              title: label,
              'aria-pressed': opts.active ? 'true' : 'false',
              disabled: opts.disabled,
              onclick: on,
            },
            h('span', { html: icon }),
            h('span', { class: 'ctrl-label' }, label),
          );
    const isMobile = matchMedia('(pointer: coarse)').matches;
    this.controls.replaceChildren(
      ...[
        btn(m.audioMuted ? 'Unmute' : 'Mute', m.audioMuted ? icons.micOff : icons.mic, () => calls.toggleMute(), {
          active: m.audioMuted,
          hidden: viewer || !active,
          disabled: !m.hasAudio,
        }),
        btn(m.videoMuted ? 'Camera on' : 'Camera off', m.videoMuted ? icons.camOff : icons.cam, () => void calls.toggleCamera(), {
          active: m.videoMuted,
          hidden: viewer || !active,
        }),
        btn('Flip', icons.flip, () => void this.app.media.flipCamera(), { hidden: viewer || !active || !isMobile || m.videoMuted }),
        btn(m.screenSharing ? 'Stop share' : 'Share', icons.screen, () => void calls.toggleScreenShare(), {
          active: m.screenSharing,
          hidden: viewer || !active || !MediaManager.screenShareSupported() || isMobile,
        }),
        btn('People', icons.users, () => {
          this.peopleOpen = !this.peopleOpen;
          this.render();
        }, { active: this.peopleOpen, hidden: c.kind !== 'group' || !active }),
        btn('Invite', icons.userPlus, () => this.cb.onInvite(), { hidden: c.kind !== 'group' || !active }),
        btn('Stats', icons.stats, () => this.cb.onToggleDiagnostics(), { hidden: !active }),
        btn(active ? (c.kind === 'live' && c.role === 'broadcaster' ? 'End stream' : c.kind === 'group' || viewer ? 'Leave' : 'Hang up') : 'Close', active ? icons.hangup : icons.close, () => calls.hangup(), {
          danger: active,
        }),
      ].filter((x): x is HTMLButtonElement => !!x),
    );
  }

  private renderPeople(c: CallState): void {
    const open = this.peopleOpen && c.kind === 'group' && !isTerminal(c.status);
    this.people.hidden = !open;
    if (!open) return;
    const isHost = c.hostId === this.app.identity.deviceId;
    const rows = [...c.participants.values()].map((p) =>
      h(
        'li',
        {},
        h('span', { class: 'avatar sm', style: `--avatar:${colorFor(p.deviceId)}` }, initials(p.name)),
        h('span', { class: 'grow' }, p.name, h('small', {}, peerProblem(p) ?? p.peer?.selectedPath?.pathLabel ?? '')),
        isHost
          ? h('button', { class: 'icon-btn', 'aria-label': `Remove ${p.name}`, title: 'Remove', html: icons.remove, onclick: () => this.app.groups.removeParticipant(p.deviceId) })
          : null,
      ),
    );
    this.people.replaceChildren(
      ...nodes(
      h('h3', {}, `Participants (${c.participants.size + 1})`),
      h('ul', {}, h('li', {}, h('span', { class: 'avatar sm', style: `--avatar:${colorFor(this.app.identity.deviceId)}` }, initials(this.app.identity.displayName)), h('span', { class: 'grow' }, `${this.app.identity.displayName} (You)`, h('small', {}, isHost ? 'Host' : ''))), ...rows),
      h('p', { class: 'hint' }, `Mesh: you upload a separate stream to each of the ${c.participants.size} other participant(s).`),
      this.lastUsage ? h('p', { class: 'hint' }, `Upload now ${formatBitrate(this.lastUsage.uploadBps)} · download ${formatBitrate(this.lastUsage.downloadBps)}`) : null,
      ),
    );
  }

  private renderTimer(): void {
    const c = this.app.calls.state;
    this.timer.textContent = c?.connectedAt && !isTerminal(c.status) ? formatDuration(Date.now() - c.connectedAt) : '';
  }
}
