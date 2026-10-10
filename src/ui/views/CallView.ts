import { backStack } from '../BackStack';
import type { AppContext } from '../../app';
import { isTerminal } from '../../calls/CallStateMachine';
import { Disposer } from '../../core/emitter';
import { formatBitrate, formatBytes, formatDuration } from '../../core/format';
import { MediaManager, type MediaSnapshot } from '../../media/MediaManager';
import type { CallState, CallStatus, ParticipantState } from '../../types/state';
import type { DataUsageSnapshot } from '../../webrtc/DataUsageMonitor';
import type { StatsReport } from '../../webrtc/StatsMonitor';
import { colorFor, h, initials, nodes } from '../dom';
import { icons } from '../icons';
import { CALL_LAYOUTS, CallLayoutManager, type LayoutPlan } from '../layout/CallLayoutManager';
import { ViewModeController, type ViewModeSnapshot } from '../ViewModeController';
import type { MeshSession } from '../../calls/MeshSession';
import { ChatPanel } from './ChatPanel';
import { peerNetInfo } from '../netInfo';
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

type PanelTab = 'chat' | 'people';

interface CtrlSpec {
  key: string;
  label: string;
  icon: string;
  on: () => void;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  badge?: string;
  /** Moved into the "More" menu on small screens. */
  secondary?: boolean;
  /** "warn" = red active state (muted / camera off / sharing); default = accent toggle. */
  tone?: 'warn';
}

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
  /** Add participants (1:1 → group conversion or group invite). */
  onInvite: () => void;
  /** Live streamer: change who may watch. */
  onManageAudience: () => void;
  /** Streamer: call this person into the live stream. */
  onCallViewer: (userId: string) => void;
  onToggleDiagnostics: () => void;
  /** Devices, quality, echo / noise / gain for the running call. */
  onCallSettings: () => void;
  onBack: () => void;
  onToast: (level: 'info' | 'warn' | 'error', text: string) => void;
}

export class CallView {
  readonly el: HTMLElement;
  private grid: VideoGrid;
  private viewModes: ViewModeController;
  private chatPanel: ChatPanel;
  private disposer = new Disposer();
  private title = h('div', { class: 'call-title' });
  private status = h('span', { class: 'call-status' });
  private timer = h('span', { class: 'call-timer' });
  private usage = h('span', { class: 'call-usage', title: 'Data used in this call' });
  private overlay = h('div', { class: 'call-overlay', hidden: true });
  private controls = h('div', { class: 'controls', role: 'toolbar', 'aria-label': 'Call controls' });
  private moreMenu = h('div', { class: 'more-menu', role: 'menu', hidden: true });
  private layoutMenu = h('div', { class: 'layout-menu', role: 'menu', 'aria-label': 'Call layout', hidden: true });
  private layoutOpen = false;
  readonly layout = new CallLayoutManager();
  private speakerSession: MeshSession | null = null;
  private plan: LayoutPlan = { layout: 'grid', mainId: null, main: [], strip: [], reason: 'none' };
  private panel: HTMLElement;
  private panelTabs = h('div', { class: 'panel-tabs', role: 'tablist' });
  private peopleBody = h('div', { class: 'people-body', role: 'tabpanel' });
  private audioUnlock = h('button', { class: 'btn primary audio-unlock', hidden: true }, 'Tap to enable audio');
  private tick: ReturnType<typeof setInterval>;
  private panelOpen = false;
  private tab: PanelTab = 'chat';
  private moreOpen = false;
  /** History entries for the open panel / menus (Back closes them). */
  private back: Partial<Record<'panel' | 'more' | 'layout', () => void>> = {};
  private mainId: string | null = null;
  private followTarget: string | null = null;
  private exitedOnEnd = false;
  private controlsSig = '';
  private tabsSig = '';
  private lastViewError: string | undefined;
  private lastUsage: DataUsageSnapshot | null = null;
  private lastStats: StatsReport | null = null;

  constructor(
    private readonly app: AppContext,
    private readonly cb: CallViewCallbacks,
  ) {
    this.grid = new VideoGrid({
      onAutoplayBlocked: () => (this.audioUnlock.hidden = false),
      onSelect: (id) => this.select(id),
      onTileAction: (id, action) => void this.tileAction(id, action),
    });
    this.chatPanel = new ChatPanel(app.chat);
    this.audioUnlock.addEventListener('click', () => {
      this.grid.resumePlayback();
      this.audioUnlock.hidden = true;
    });
    const back = h('button', { class: 'icon-btn mobile-only', 'aria-label': 'Back to contacts', html: icons.back, onclick: () => cb.onBack() });
    this.panel = h(
      'aside',
      { class: 'call-panel', 'aria-label': 'Participants and chat', hidden: true },
      h('div', { class: 'panel-head' }, this.panelTabs, h('button', { class: 'icon-btn', 'aria-label': 'Close panel', html: icons.close, onclick: () => this.setPanel(false) })),
      this.peopleBody,
      this.chatPanel.el,
    );
    this.el = h(
      'section',
      { class: 'call', 'aria-live': 'polite' },
      h('header', { class: 'call-header' }, back, h('div', { class: 'call-heading' }, this.title, h('div', { class: 'call-meta' }, this.status, this.timer, this.usage))),
      h('div', { class: 'call-body' }, h('div', { class: 'call-main' }, this.grid.el, this.overlay, this.audioUnlock), this.panel),
      h('div', { class: 'controls-wrap' }, this.moreMenu, this.layoutMenu, this.controls),
    );

    // Fullscreen targets the call container (video + chat + controls), never the whole app.
    this.viewModes = new ViewModeController(this.el, (v) => this.grid.owns(v));
    this.disposer.add(this.viewModes.events.on('change', (s) => this.onViewModes(s)));
    this.setupAutoPip();
    this.disposer.add(this.app.settings.events.on('change', ({ changed }) => changed.includes('mirrorSelf') && this.render()));
    this.disposer.add(this.app.chat.events.on('change', () => {
      this.chatPanel.render();
      this.renderPanelTabs();
      this.renderControlsFor();
    }));
    this.disposer.listen(document, 'pointerdown', (e) => {
      if (!(e.target as Element).closest?.('.controls-wrap')) {
        if (this.moreOpen) this.setMore(false);
        if (this.layoutOpen) this.setLayoutMenu(false);
      }
    });
    this.disposer.listen(document, 'keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') {
        if (this.moreOpen) this.setMore(false);
        if (this.layoutOpen) this.setLayoutMenu(false);
      }
    });
    this.disposer.add(this.layout.events.on('change', () => this.render()));
    this.disposer.add(this.app.live.events.on('state', () => this.panelOpen && this.tab === 'people' && this.render()));
    this.tick = setInterval(() => this.renderTimer(), 1000);
  }

  // ── background popup (automatic Picture-in-Picture) ──────────────────────

  /** Opened automatically because the app went to the background (closed again on return). */
  private autoPip = false;

  /** The video to float: the main tile, else any remote video, else my camera. */
  private pipCandidate(): HTMLVideoElement | null {
    const ids = this.grid.videoIds();
    const id = this.grid.hasVideo(this.mainId) ? this.mainId : (ids[0] ?? null);
    return this.grid.video(id);
  }

  /**
   * Home button / app switch during a call → the call keeps showing as a floating popup.
   * Browsers only allow PiP without a tap through these hooks:
   *  - Chrome: Media Session "enterpictureinpicture" (automatic PiP for video-call pages)
   *  - Safari (iOS/iPadOS): the `autopictureinpicture` attribute on the playing <video>
   * Audio-only calls have no video to float; they simply keep running in the background.
   */
  private setupAutoPip(): void {
    const session = navigator.mediaSession as (MediaSession & { setActionHandler(a: string, h: (() => void) | null): void }) | undefined;
    if (session && this.viewModes.pipAvailable) {
      try {
        session.setActionHandler('enterpictureinpicture', () => {
          const c = this.app.calls.state;
          const video = this.pipCandidate();
          if (!c || isTerminal(c.status) || !video || this.viewModes.snapshot.pip === 'active') return;
          void this.viewModes.enterPip(video).then((ok) => (this.autoPip = ok));
        });
        this.disposer.add(() => {
          try {
            session.setActionHandler('enterpictureinpicture', null);
          } catch {
            /* unsupported */
          }
        });
      } catch {
        // This browser has no automatic PiP action – Safari's attribute (below) may still apply.
      }
    }
    if (session) {
      try {
        session.metadata = new MediaMetadata({ title: 'MeshCall', artist: this.app.calls.state?.remoteUser?.name ?? this.app.calls.state?.title ?? 'Call' });
        session.playbackState = 'playing';
        this.disposer.add(() => {
          session.metadata = null;
          session.playbackState = 'none';
        });
      } catch {
        /* metadata unsupported */
      }
    }
    this.disposer.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        // Fallback where the media-session action does not exist: some browsers still allow
        // PiP while the page is being hidden (others reject it – harmless).
        const c = this.app.calls.state;
        const video = this.pipCandidate();
        if (c && !isTerminal(c.status) && video && this.viewModes.snapshot.pip !== 'active') {
          void this.viewModes.enterPip(video).then((ok) => ok && (this.autoPip = true));
        }
        return;
      }
      // Back in the app: close a popup we opened automatically (a user-opened PiP stays).
      if (!this.autoPip) return;
      this.autoPip = false;
      if (this.viewModes.snapshot.pip === 'active') void this.viewModes.exitPip();
    });
  }

  /** Safari: only the candidate video carries `autopictureinpicture` while the call is live. */
  private markAutoPip(active: boolean): void {
    const target = active ? this.pipCandidate() : null;
    for (const id of [...this.grid.videoIds(), this.mainId, 'local']) {
      const v = this.grid.video(id);
      if (v) v.toggleAttribute('autopictureinpicture', v === target);
    }
  }

  dispose(): void {
    // Give back the history entries of anything still open (panel, menus).
    for (const release of Object.values(this.back)) release?.();
    this.back = {};
    clearInterval(this.tick);
    this.viewModes.dispose(); // exits PiP/fullscreen and removes document listeners
    this.disposer.dispose();
    this.app.chat.setPanelOpen(false);
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

    if (isTerminal(c.status)) {
      // Call over: leave PiP/fullscreen immediately (the view itself lingers for the end screen).
      if (!this.exitedOnEnd) {
        this.exitedOnEnd = true;
        void this.viewModes.exitAll();
        this.setPanel(false);
      }
    }

    this.watchSpeaker();
    const tiles = this.tiles(c);
    const vm = this.viewModes.snapshot;
    this.plan = this.layout.plan(tiles.map((t) => ({ id: t.id, local: t.local, screen: t.screen, hasVideo: this.grid.hasVideo(t.id) })));
    this.mainId = this.plan.mainId;
    this.followPip(vm, !isTerminal(c.status) && c.participants.size > 0);
    this.grid.update(
      tiles,
      {
        sinkId: this.app.settings.get().audioOutputId,
        selectedId: tiles.length > 1 ? this.mainId : null,
        pinnedId: this.layout.pinned,
        speakerId: tiles.length > 2 ? this.layout.activeSpeaker : null,
        pipId: this.grid.idOfVideo(vm.pipVideo),
        pipAvailable: this.viewModes.pipAvailable,
        fullscreenAvailable: this.viewModes.fullscreenAvailable,
      },
      this.plan,
    );
    this.el.classList.toggle('is-fullscreen', vm.fullscreen === 'active');
    this.markAutoPip(!isTerminal(c.status));
    this.renderControls(c, m, vm);
    this.renderPanelTabs();
    if (this.panelOpen && this.tab === 'people') this.renderPeople(c);
  }

  // ── selection / PiP / fullscreen ─────────────────────────────────────────

  /** Feed the mesh's active-speaker detection into the layout (re-subscribes per mesh). */
  private watchSpeaker(): void {
    const session = this.app.calls.session;
    if (session === this.speakerSession) return;
    this.speakerSession = session;
    this.layout.setActiveSpeaker(session?.activeSpeaker ?? null);
    session?.events.on('activeSpeaker', (id) => {
      if (this.speakerSession === session) this.layout.setActiveSpeaker(id);
    });
  }

  /** Tile click = pin/unpin (manual spotlight). Runs in the click handler → PiP follow has user activation. */
  private select(id: string): void {
    this.layout.togglePin(id);
  }

  /** Own (or give up) the history entry of one layer; `viaBack` = Back already consumed it. */
  private trackBack(key: 'panel' | 'more' | 'layout', open: boolean, close: () => void, viaBack: boolean): void {
    if (open) this.back[key] ??= backStack.push(close);
    else {
      if (!viaBack) this.back[key]?.();
      delete this.back[key];
    }
  }

  private setLayoutMenu(open: boolean, viaBack = false): void {
    if (this.layoutOpen === open) return;
    this.layoutOpen = open;
    this.trackBack('layout', open, () => this.setLayoutMenu(false, true), viaBack);
    if (open) this.setMore(false);
    this.renderLayoutMenu();
    this.renderControlsFor();
    if (open) (this.layoutMenu.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
  }

  private renderLayoutMenu(): void {
    this.layoutMenu.hidden = !this.layoutOpen;
    if (!this.layoutOpen) return;
    const current = this.layout.layout;
    const pinned = this.layout.pinned;
    this.layoutMenu.replaceChildren(
      h('div', { class: 'menu-title' }, 'Layout'),
      ...CALL_LAYOUTS.map((l) =>
        h(
          'button',
          {
            class: `menu-item layout-option${l.id === current ? ' on' : ''}`,
            role: 'menuitemradio',
            'aria-checked': String(l.id === current),
            'data-layout': l.id,
            onclick: () => {
              this.layout.setLayout(l.id); // UI-only: no RTCPeerConnection / MediaStream is touched
              this.setLayoutMenu(false);
            },
          },
          h('span', { class: 'radio-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'grow' }, l.label, h('small', {}, l.hint)),
        ),
      ),
      ...nodes(
        pinned
          ? h('button', { class: 'menu-item', role: 'menuitem', onclick: () => { this.layout.pin(null); this.setLayoutMenu(false); } }, 'Unpin – follow active speaker')
          : h('p', { class: 'menu-hint' }, 'Tip: click a video to pin it as the main participant.'),
      ),
    );
  }

  /** Keep PiP on the main participant when it changes (once per change, never in a loop). */
  private followPip(vm: ViewModeSnapshot, callActive: boolean): void {
    // Only follow to a tile that really shows video, and never while the call is ending.
    if (vm.pip !== 'active' || !this.mainId || !callActive || !this.grid.hasVideo(this.mainId)) {
      this.followTarget = null;
      return;
    }
    const pipId = this.grid.idOfVideo(vm.pipVideo);
    if (pipId === this.mainId || this.followTarget === this.mainId) return;
    this.followTarget = this.mainId;
    void this.viewModes.followVideo(this.grid.video(this.mainId));
  }

  private async tileAction(id: string, action: 'pip' | 'fullscreen'): Promise<void> {
    const vm = this.viewModes.snapshot;
    if (action === 'pip') {
      if (vm.pip === 'active' && this.grid.idOfVideo(vm.pipVideo) === id) return void (await this.viewModes.exitPip());
      this.layout.pin(id);
      await this.viewModes.enterPip(this.grid.video(id)!);
    } else {
      if (vm.fullscreen === 'active' && this.mainId === id) return void (await this.viewModes.exitFullscreen());
      this.layout.pin(id);
      await this.viewModes.enterFullscreen();
    }
  }

  private onViewModes(s: ViewModeSnapshot): void {
    if (s.error && s.error !== this.lastViewError && (s.pip === 'error' || s.fullscreen === 'error')) this.cb.onToast('warn', s.error);
    this.lastViewError = s.error;
    this.render();
  }

  // ── side panel (participants / chat) ─────────────────────────────────────

  private setPanel(open: boolean, tab: PanelTab = this.tab, viaBack = false): void {
    if (this.panelOpen !== open) this.trackBack('panel', open, () => this.setPanel(false, this.tab, true), viaBack);
    this.panelOpen = open;
    this.tab = tab;
    this.panel.hidden = !open;
    this.el.classList.toggle('panel-open', open);
    this.peopleBody.hidden = tab !== 'people';
    this.chatPanel.el.hidden = tab !== 'chat';
    this.app.chat.setPanelOpen(open && tab === 'chat');
    if (open && tab === 'chat') {
      this.chatPanel.render();
      if (!matchMedia('(pointer: coarse)').matches) this.chatPanel.focus(); // don't pop the mobile keyboard
    }
    this.render();
  }

  private togglePanel(tab: PanelTab): void {
    this.setPanel(!(this.panelOpen && this.tab === tab), tab);
  }

  private renderPanelTabs(): void {
    const c = this.app.calls.state;
    const unread = this.app.chat.unread;
    const broadcaster = c?.kind === 'live' && c.role === 'broadcaster';
    const sig = `${this.tab}|${unread}|${c?.participants.size ?? 0}|${broadcaster}`;
    if (sig === this.tabsSig) return; // keep focus on the tab buttons across re-renders
    this.tabsSig = sig;
    const tab = (id: PanelTab, label: string) =>
      h(
        'button',
        {
          role: 'tab',
          class: 'panel-tab',
          'aria-selected': String(this.tab === id),
          onclick: () => this.setPanel(true, id),
        },
        label,
        id === 'chat' && unread && this.tab !== 'chat' ? h('span', { class: 'badge' }, String(unread)) : null,
      );
    this.panelTabs.replaceChildren(
      tab('people', broadcaster ? `Audience (${c?.participants.size ?? 0})` : `Participants (${(c?.participants.size ?? 0) + 1})`),
      tab('chat', 'Chat'),
    );
  }

  private renderPeople(c: CallState): void {
    if (c.kind === 'live' && c.role === 'broadcaster') return this.renderAudience();
    const isHost = c.hostId === this.app.identity.deviceId && c.kind === 'group';
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
    this.peopleBody.replaceChildren(
      ...nodes(
        h(
          'ul',
          { class: 'people-list' },
          h(
            'li',
            {},
            h('span', { class: 'avatar sm', style: `--avatar:${colorFor(this.app.identity.deviceId)}` }, initials(this.app.identity.displayName)),
            h('span', { class: 'grow' }, `${this.app.identity.displayName} (You)`, h('small', {}, c.hostId === this.app.identity.deviceId && c.kind !== 'direct' ? 'Host' : '')),
          ),
          ...rows,
          ...this.app.calls.pendingInviteIds.map((id) =>
            h(
              'li',
              { class: 'pending' },
              h('span', { class: 'avatar sm', style: `--avatar:${colorFor(id)}` }, initials(this.app.presence.nameOf(id))),
              h('span', { class: 'grow' }, this.app.presence.nameOf(id), h('small', {}, 'Invited – waiting for answer…')),
            ),
          ),
        ),
        c.kind !== 'live' ? h('button', { class: 'btn small', onclick: () => this.cb.onInvite() }, h('span', { html: icons.userPlus }), 'Add participants') : null,
        c.participants.size > 1 ? h('p', { class: 'hint' }, `Mesh: you upload a separate stream to each of the ${c.participants.size} other participants.`) : null,
        this.lastUsage ? h('p', { class: 'hint' }, `Upload now ${formatBitrate(this.lastUsage.uploadBps)} · download ${formatBitrate(this.lastUsage.downloadBps)}`) : null,
      ),
    );
  }

  /** Streamer's audience: per-viewer permission/connection state + measured upload per viewer. */
  private renderAudience(): void {
    const st = this.app.live.state;
    const label: Record<string, string> = {
      streaming: '✓ Streaming',
      connecting: 'Connecting…',
      invited: 'Invited',
      available: 'Can watch',
      disconnected: 'Disconnected',
      'not-selected': '✕ Not selected',
    };
    const viewers = st ? [...st.viewers.values()].sort((a, b) => Number(b.allowed) - Number(a.allowed) || a.name.localeCompare(b.name)) : [];
    const total = viewers.reduce((sum, v) => sum + v.uploadBps, 0);
    this.peopleBody.replaceChildren(
      ...nodes(
        h(
          'div',
          { class: 'audience-summary' },
          h('div', {}, h('strong', {}, st?.audienceMode === 'selected' ? 'Selected members' : 'Everyone in the room'), h('small', {}, 'can watch')),
          h('div', { class: 'upload-total' }, h('small', {}, 'My upload'), h('strong', {}, formatBitrate(total))),
        ),
        viewers.length
          ? h(
              'ul',
              { class: 'people-list audience-list' },
              ...viewers.map((v) =>
                h(
                  'li',
                  { 'data-status': v.status },
                  h('span', { class: 'avatar sm', style: `--avatar:${colorFor(v.userId)}` }, initials(v.name)),
                  h('span', { class: 'grow' }, v.name, h('small', { class: `viewer-status ${v.status}` }, label[v.status] ?? v.status)),
                  v.connected ? h('span', { class: 'viewer-rate', title: 'Measured upload to this viewer' }, formatBitrate(v.uploadBps)) : null,
                  !v.connected && v.status !== 'connecting'
                    ? h('button', { class: 'icon-btn viewer-call', title: `Call ${v.name} into the stream`, 'aria-label': `Call ${v.name} into the stream`, html: icons.phone, onclick: () => this.cb.onCallViewer(v.userId) })
                    : null,
                ),
              ),
            )
          : h('p', { class: 'hint' }, 'Nobody else is in the room yet.'),
        h('button', { class: 'btn small', onclick: () => this.cb.onManageAudience() }, 'Manage audience'),
        h('p', { class: 'hint' }, 'Mesh: every viewer receives a separate copy of your stream, so your upload grows with each viewer.'),
      ),
    );
  }

  // ── controls ─────────────────────────────────────────────────────────────

  private renderControlsFor(): void {
    const c = this.app.calls.state;
    if (c) this.renderControls(c, this.app.media.state, this.viewModes.snapshot);
  }

  private renderControls(c: CallState, m: MediaSnapshot, vm: ViewModeSnapshot): void {
    const calls = this.app.calls;
    const active = !isTerminal(c.status);
    const viewer = c.role === 'viewer';
    const isTouch = matchMedia('(pointer: coarse)').matches;
    const unread = this.app.chat.unread;
    const pipOn = vm.pip === 'active';
    const fsOn = vm.fullscreen === 'active';
    const busyPip = vm.pip === 'entering' || vm.pip === 'exiting';
    const specs: CtrlSpec[] = [];
    if (active) {
      if (!viewer) {
        specs.push(
          { key: 'mute', label: m.audioMuted ? 'Unmute' : 'Mute', icon: m.audioMuted ? icons.micOff : icons.mic, on: () => calls.toggleMute(), active: m.audioMuted, disabled: !m.hasAudio, tone: 'warn' },
          { key: 'cam', label: m.videoMuted ? 'Camera on' : 'Camera off', icon: m.videoMuted ? icons.camOff : icons.cam, on: () => void calls.toggleCamera(), active: m.videoMuted, tone: 'warn' },
        );
        if (isTouch && !m.videoMuted) specs.push({ key: 'flip', label: 'Flip', icon: icons.flip, on: () => void this.app.media.flipCamera(), secondary: true });
        if (!isTouch && MediaManager.screenShareSupported())
          specs.push({ key: 'share', label: m.screenSharing ? 'Stop share' : 'Share', icon: icons.screen, on: () => void calls.toggleScreenShare(), active: m.screenSharing, secondary: true });
      }
      specs.push({
        key: 'chat',
        label: 'Chat',
        icon: icons.chat,
        on: () => this.togglePanel('chat'),
        active: this.panelOpen && this.tab === 'chat',
        badge: unread ? (unread > 9 ? '9+' : String(unread)) : undefined,
      });
      specs.push({
        key: 'people',
        label: c.kind === 'live' && c.role === 'broadcaster' ? 'Viewers' : 'People',
        icon: icons.users,
        on: () => this.togglePanel('people'),
        active: this.panelOpen && this.tab === 'people',
        secondary: true,
      });
      if (c.kind === 'direct' || c.kind === 'group')
        specs.push({ key: 'invite', label: 'Add', icon: icons.userPlus, on: () => this.cb.onInvite(), secondary: true });
      if (c.kind === 'live' && c.role === 'broadcaster')
        specs.push({ key: 'audience', label: 'Manage', icon: icons.settings, on: () => this.cb.onManageAudience(), secondary: true });
      if (c.kind !== 'live' || c.role === 'viewer')
        specs.push({
          key: 'layout',
          label: 'Layout',
          icon: icons.layout,
          on: () => this.setLayoutMenu(!this.layoutOpen),
          active: this.layoutOpen,
          secondary: true,
        });
      if (this.viewModes.fullscreenAvailable)
        specs.push({ key: 'fs', label: fsOn ? 'Exit fullscreen' : 'Fullscreen', icon: fsOn ? icons.exitFullscreen : icons.fullscreen, on: () => void this.viewModes.toggleFullscreen(), active: fsOn, secondary: true });
      if (this.viewModes.pipAvailable)
        specs.push({
          key: 'pip',
          label: pipOn ? 'Exit PiP' : 'Enter PiP',
          icon: pipOn ? icons.pipExit : icons.pip,
          on: () => void this.viewModes.togglePip(this.grid.video(this.mainId)),
          active: pipOn,
          disabled: busyPip || (!pipOn && !this.grid.hasVideo(this.mainId)),
          secondary: true,
        });
      specs.push({ key: 'stats', label: 'Network', icon: icons.stats, on: () => this.cb.onToggleDiagnostics(), secondary: true });
      specs.push({ key: 'settings', label: 'Call settings', icon: icons.settings, on: () => this.cb.onCallSettings(), secondary: true });
    }
    specs.push({
      key: 'end',
      label: active ? (c.kind === 'live' && c.role === 'broadcaster' ? 'End stream' : c.kind === 'group' || viewer ? 'Leave' : 'Hang up') : 'Close',
      icon: active ? icons.hangup : icons.close,
      on: () => calls.hangup(),
      danger: active,
    });

    // Rebuild only when something visible changed – keeps keyboard focus on the toolbar.
    const sig = `${this.moreOpen}|${this.layoutOpen}|${specs.map((s) => `${s.key}:${s.label}:${!!s.active}:${!!s.disabled}:${s.badge ?? ''}`).join(',')}`;
    if (sig === this.controlsSig) return;
    const focusedKey = (document.activeElement as HTMLElement | null)?.dataset?.ctrl;
    this.controlsSig = sig;

    const secondary = specs.filter((s) => s.secondary);
    const moreBtn: CtrlSpec | null = secondary.length
      ? { key: 'more', label: 'More', icon: icons.more, on: () => this.setMore(!this.moreOpen), active: this.moreOpen }
      : null;
    const endIdx = specs.findIndex((s) => s.key === 'end');
    const bar = [...specs.slice(0, endIdx), ...(moreBtn ? [moreBtn] : []), ...specs.slice(endIdx)];
    this.controls.replaceChildren(...bar.map((s) => this.ctrlButton(s)));
    this.moreMenu.replaceChildren(
      ...secondary.map((s) =>
        h(
          'button',
          {
            class: `menu-item${s.active ? ' on' : ''}`,
            role: 'menuitem',
            'data-ctrl': `menu-${s.key}`,
            disabled: s.disabled,
            onclick: () => {
              this.setMore(false);
              s.on();
            },
          },
          h('span', { html: s.icon }),
          s.label,
        ),
      ),
    );
    this.moreMenu.hidden = !this.moreOpen;
    if (focusedKey) (this.el.querySelector(`[data-ctrl="${focusedKey}"]`) as HTMLElement | null)?.focus();
  }

  private ctrlButton(s: CtrlSpec): HTMLButtonElement {
    return h(
      'button',
      {
        class: `ctrl ctrl-${s.key}${s.active ? (s.tone === 'warn' ? ' on' : ' toggled') : ''}${s.danger ? ' danger' : ''}${s.secondary ? ' secondary' : ''}`,
        'data-ctrl': s.key,
        'aria-label': s.badge ? `${s.label} (${s.badge} unread)` : s.label,
        title: s.label,
        'aria-pressed': s.key === 'end' ? undefined : String(!!s.active),
        'aria-haspopup': s.key === 'more' ? 'menu' : undefined,
        'aria-expanded': s.key === 'more' ? String(this.moreOpen) : undefined,
        disabled: s.disabled,
        onclick: s.on,
      },
      h('span', { class: 'ctrl-icon', html: s.icon }),
      h('span', { class: 'ctrl-label' }, s.label),
      s.badge ? h('span', { class: 'badge' }, s.badge) : null,
    );
  }

  private setMore(open: boolean, viaBack = false): void {
    if (this.moreOpen === open) return;
    this.moreOpen = open;
    this.trackBack('more', open, () => this.setMore(false, true), viaBack);
    this.moreMenu.hidden = !open;
    this.renderControlsFor();
    if (open) (this.moreMenu.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
  }

  // ── misc ─────────────────────────────────────────────────────────────────

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
        net: peerNetInfo(p, snap),
      });
    }
    if (c.role !== 'viewer') {
      tiles.push({
        id: 'local',
        name: this.app.identity.displayName,
        stream: this.app.media.stream,
        local: true,
        audioMuted: m.audioMuted || !m.hasAudio,
        videoMuted: !m.hasVideo,
        screen: m.screenSharing,
        // Selfie view for the front camera only (a rear camera is never mirrored).
        mirror: this.app.settings.get().mirrorSelf !== false && m.facingMode !== 'environment',
      });
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
    const text =
      liveEmpty && !isTerminal(c.status)
        ? `You are live · ${viewers}/${this.app.config.mesh.maxLiveViewers} viewer${viewers === 1 ? '' : 's'}`
        : (c.statusDetail ?? STATUS_LABEL[c.status]);
    this.overlay.replaceChildren(
      ...nodes(
        h('div', { class: `avatar big${c.status === 'calling' || c.status === 'ringing' ? ' pulse' : ''}`, style: `--avatar:${colorFor(c.remoteUser?.deviceId ?? c.callId)}` }, initials(who || '?')),
        h('div', { class: 'overlay-name' }, liveEmpty ? (c.title ?? 'Live') : who),
        h('div', { class: 'overlay-text' }, text),
        liveEmpty && !isTerminal(c.status) ? h('div', { class: 'overlay-hint' }, 'Mesh streaming uploads one full copy per viewer – keep the viewer count small.') : null,
      ),
    );
    this.overlay.classList.toggle('compact', liveEmpty);
  }

  private renderTimer(): void {
    const c = this.app.calls.state;
    this.timer.textContent = c?.connectedAt && !isTerminal(c.status) ? formatDuration(Date.now() - c.connectedAt) : '';
  }
}
