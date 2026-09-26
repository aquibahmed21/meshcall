import type { AppContext } from '../app';
import { isTerminal } from '../calls/CallStateMachine';
import type { SavedCall } from '../calls/CallManager';
import type { NetworkQuality } from '../types/state';
import { h } from './dom';
import { icons } from './icons';
import { CallView } from './views/CallView';
import { DiagnosticsPanel } from './views/DiagnosticsPanel';
import { openAddParticipants, openGoLive, openGroupCall, openIncomingCall, openInstallHelp, openLiveInvite, openManageAudience, openSettings } from './views/Dialogs';
import type { Modal } from './views/Modal';
import { Sidebar } from './views/Sidebar';
import { Toasts } from './views/Toasts';
import { renderEnableNotificationsCard } from './views/NotificationSettings';

type MobileView = 'people' | 'live' | 'call';

export interface UIManagerOptions {
  onLeaveRoom: () => void;
}

/**
 * Renders application state. Holds DOM state only – call/peer/signaling state lives in the
 * services and is read on every render.
 */
export class UIManager {
  private root: HTMLElement;
  private sidebar: Sidebar;
  private stage = h('main', { class: 'stage', id: 'stage' });
  private idle: HTMLElement;
  private callView: CallView | null = null;
  private diagnostics: DiagnosticsPanel;
  private toasts = new Toasts();
  private sigPill = h('span', { class: 'pill', title: 'Signaling (ScaleDrone)' });
  private netPill = h('span', { class: 'pill', title: 'Network' });
  private banner = h('div', { class: 'banner', hidden: true });
  private nav: HTMLElement;
  private incoming: Modal | null = null;
  private diagOpen = false;
  private view: MobileView = 'people';
  private lastCallId: string | null = null;
  private worstQuality: NetworkQuality = 'unknown';
  private rejoin: SavedCall | null = null;
  private roomChip = h('div', { class: 'room-chip' });

  constructor(
    private readonly app: AppContext,
    mount: HTMLElement,
    private readonly opts: UIManagerOptions,
  ) {
    this.sidebar = new Sidebar(app, { onGroup: () => openGroupCall(app), onGoLive: () => openGoLive(app), onInstall: () => this.install() });
    this.diagnostics = new DiagnosticsPanel(app, () => this.toggleDiagnostics(false));
    this.idle = this.renderIdle();
    this.nav = h(
      'nav',
      { class: 'bottom-nav', 'aria-label': 'Sections' },
      this.navBtn('people', 'People', icons.users),
      this.navBtn('live', 'Live', icons.live),
      this.navBtn('call', 'Call', icons.phone),
    );
    this.root = h(
      'div',
      { class: 'app' },
      h(
        'header',
        { class: 'topbar' },
        h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, '◉'), h('span', { class: 'brand-text' }, 'Mesh', h('b', {}, 'Call'))),
        this.roomChip,
        h('div', { class: 'pills' }, this.sigPill, this.netPill),
        h('button', { class: 'icon-btn', 'aria-label': 'Diagnostics', title: 'Diagnostics', html: icons.stats, onclick: () => this.toggleDiagnostics() }),
        h('button', { class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', html: icons.settings, onclick: () => openSettings(app) }),
      ),
      this.banner,
      h('div', { class: 'layout' }, this.sidebar.el, this.stage, this.diagnostics.el),
      this.nav,
      this.toasts.el,
    );
    mount.replaceChildren(this.root);
    this.stage.append(this.idle);
    this.diagnostics.el.hidden = true;
    this.wire();
    this.rejoin = app.calls.rejoinOffer;
    this.renderAll();
  }

  /** Public toast (used for cross-room call offers etc.). */
  toast(level: 'info' | 'warn' | 'error', text: string, action?: { label: string; run: () => void }): void {
    this.toasts.show(level, text, 6000, action);
  }

  private install(): void {
    if (this.app.pwa.installState === 'available') void this.app.pwa.promptInstall();
    else openInstallHelp(this.app);
  }

  /** Re-mount after returning from the room screen. */
  attach(mount: HTMLElement): void {
    mount.replaceChildren(this.root);
    this.rejoin = this.app.calls.rejoinOffer;
    this.setView('people');
    this.renderAll();
  }

  private renderRoomChip(): void {
    const room = this.app.rooms.current;
    if (!room) {
      this.roomChip.replaceChildren();
      return;
    }
    const copy = h('button', { class: 'btn small ghost', type: 'button', title: 'Copy room name', 'aria-label': `Copy room name ${room.roomName}` }, 'Copy');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(room.roomName);
        this.toasts.show('info', `Copied room name “${room.roomName}”`);
      } catch {
        this.toasts.show('warn', 'Copy failed – select the room name manually');
      }
    });
    const leave = h('button', { class: 'btn small danger-ghost', type: 'button', title: 'Leave room', 'aria-label': 'Leave room' }, 'Leave');
    leave.addEventListener('click', () => {
      if (this.app.calls.inCall && !confirm('Leaving the room ends your current call. Leave anyway?')) return;
      this.opts.onLeaveRoom();
    });
    this.roomChip.replaceChildren(
      h('span', { class: 'room-label', title: room.roomName }, h('span', { class: 'room-prefix' }, 'Room: '), h('strong', {}, room.roomName)),
      copy,
      leave,
    );
  }

  private wire(): void {
    const { app } = this;
    app.rooms.events.on('change', () => this.renderRoomChip());
    app.pwa.events.on('install', () => {
      this.sidebar.render();
      this.renderIdleHints();
    });
    app.pwa.events.on('updateReady', () => this.renderBanner());
    // Toasts live in the top layer of whatever is fullscreen (the call view), else in the app.
    document.addEventListener('fullscreenchange', () => {
      const host = document.fullscreenElement ?? this.root;
      if (this.toasts.el.parentElement !== host) host.append(this.toasts.el);
    });
    // Mobile keyboards shrink the *visual* viewport; size the app to it so the chat input is
    // never covered (iOS Safari does not resize the layout viewport).
    const vv = window.visualViewport;
    if (vv && matchMedia('(pointer: coarse)').matches) {
      const apply = () => document.documentElement.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
      vv.addEventListener('resize', apply);
      apply();
    }
    app.signaling.events.on('status', () => this.renderAll());
    app.presence.events.on('change', () => this.sidebar.renderUsers());
    app.live.events.on('streams', () => this.sidebar.renderStreams());
    app.live.events.on('invite', (invite) => {
      if (app.calls.inCall) this.toasts.show('info', `${invite.hostName} added you to the live stream “${invite.title}” – find it under Live when you're free`);
      else openLiveInvite(app, invite);
    });
    app.network.events.on('change', ({ reason }) => {
      if (reason === 'offline') this.toasts.show('warn', 'You are offline – calls will recover when the network returns');
      else if (reason === 'online') this.toasts.show('info', 'Back online – re-establishing connections');
      this.renderPills();
    });
    app.calls.events.on('state', () => this.onCallState());
    app.calls.events.on('toast', ({ level, text }) => this.toasts.show(level, text));
    app.calls.events.on('stats', ({ report, usage }) => {
      this.worstQuality = [...report.peers.values()].reduce<NetworkQuality>((w, p) => {
        const rank: NetworkQuality[] = ['unknown', 'excellent', 'good', 'poor', 'critical'];
        return rank.indexOf(p.quality) > rank.indexOf(w) ? p.quality : w;
      }, 'unknown');
      this.renderPills();
      this.callView?.onStats(report, usage);
      if (this.diagOpen) this.diagnostics.onStats(report, usage);
    });
    app.calls.events.on('rejoinAvailable', (saved) => {
      this.rejoin = saved;
      this.renderBanner();
    });
    app.media.events.on('state', () => this.callView?.render());
    app.settings.events.on('change', () => this.callView?.render());
    app.push.events.on('status', () => this.renderIdleHints());
  }

  // ── call lifecycle ───────────────────────────────────────────────────────

  private onCallState(): void {
    const c = this.app.calls.state;
    const incomingRinging = !!c && c.status === 'ringing' && c.direction === 'incoming';
    if (incomingRinging && !this.incoming) {
      this.incoming = openIncomingCall(this.app, c);
      this.incoming.onClose = () => (this.incoming = null);
    } else if (!incomingRinging && this.incoming) {
      this.incoming.close();
      this.incoming = null;
    }

    const showCall = !!c && !incomingRinging;
    if (showCall && !this.callView) {
      this.callView = new CallView(this.app, {
        onInvite: () => openAddParticipants(this.app),
        onManageAudience: () => openManageAudience(this.app),
        onToggleDiagnostics: () => this.toggleDiagnostics(),
        onBack: () => this.setView('people'),
        onToast: (level, text) => this.toasts.show(level, text),
      });
      this.stage.replaceChildren(this.callView.el);
    } else if (!showCall && this.callView) {
      this.callView.dispose();
      this.callView = null;
      this.stage.replaceChildren(this.idle);
    }
    if (c && c.callId !== this.lastCallId && showCall) {
      this.lastCallId = c.callId;
      this.setView('call');
    }
    if (!c) {
      this.lastCallId = null;
      if (this.view === 'call') this.setView('people');
    }
    this.callView?.render();
    this.sidebar.render();
    this.root.classList.toggle('in-call', !!c && !isTerminal(c.status));
    this.renderBanner();
    if (this.diagOpen) this.diagnostics.render();
  }

  private toggleDiagnostics(force?: boolean): void {
    this.diagOpen = force ?? !this.diagOpen;
    this.diagnostics.el.hidden = !this.diagOpen;
    this.root.classList.toggle('diag-open', this.diagOpen);
    if (this.diagOpen) this.diagnostics.render();
  }

  private setView(view: MobileView): void {
    this.view = view;
    this.root.dataset.view = view;
    for (const b of this.nav.querySelectorAll('button')) b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
    if (view === 'live') document.getElementById('live')?.scrollIntoView({ block: 'start' });
    if (view === 'people') document.getElementById('people')?.scrollIntoView({ block: 'start' });
    this.renderBanner();
  }

  private navBtn(view: MobileView, label: string, icon: string): HTMLButtonElement {
    return h('button', { 'data-view': view, 'aria-label': label, onclick: () => this.setView(view) }, h('span', { html: icon }), h('span', {}, label));
  }

  // ── rendering ────────────────────────────────────────────────────────────

  private renderAll(): void {
    this.renderBanner();
    this.renderRoomChip();
    this.renderPills();
    this.sidebar.render();
    this.renderIdleHints();
    this.setView(this.view);
  }

  private renderPills(): void {
    const s = this.app.signaling.status;
    this.sigPill.textContent = s === 'connected' ? 'Signaling ✓' : `Signaling: ${s}`;
    this.sigPill.dataset.state = s === 'connected' ? 'ok' : s === 'unavailable' ? 'bad' : 'warn';
    const online = this.app.network.online;
    const q = this.worstQuality;
    this.netPill.textContent = !online ? 'Offline' : this.app.calls.inCall && q !== 'unknown' ? `Network: ${q}` : 'Online';
    this.netPill.dataset.state = !online || q === 'critical' ? 'bad' : q === 'poor' ? 'warn' : 'ok';
  }

  private renderBanner(): void {
    const c = this.app.calls.state;
    const nodes: Node[] = [];
    if (c && !isTerminal(c.status) && this.view !== 'call' && this.callView) {
      nodes.push(h('span', {}, `In call · ${c.remoteUser?.name ?? c.title ?? ''}`), h('button', { class: 'btn small primary', onclick: () => this.setView('call') }, 'Return to call'));
    } else if (this.rejoin && !c) {
      const r = this.rejoin;
      nodes.push(
        h('span', {}, `You left a ${r.kind === 'live' ? 'stream' : 'call'}${r.remote ? ` with ${r.remote.name}` : r.title ? ` “${r.title}”` : ''}.`),
        h('button', { class: 'btn small primary', onclick: () => void this.app.calls.rejoin(r) }, 'Rejoin'),
        h('button', { class: 'btn small', onclick: () => this.app.calls.dismissRejoin() }, 'Dismiss'),
      );
    }
    if (!nodes.length && this.app.pwa.updateReady) {
      nodes.push(
        h('span', {}, 'A new version of MeshCall is available.'),
        h(
          'button',
          {
            class: 'btn small primary',
            onclick: () => {
              if (this.app.calls.inCall && !confirm('Reloading ends your current call. Reload now?')) return;
              this.app.pwa.applyUpdate();
            },
          },
          'Reload',
        ),
      );
    }
    this.banner.hidden = nodes.length === 0;
    this.banner.replaceChildren(...nodes);
  }

  private idleHints = h('div', { class: 'idle-hints' });

  private renderIdle(): HTMLElement {
    return h(
      'section',
      { class: 'idle' },
      h('div', { class: 'brand-mark big' }, '◉'),
      h('h1', {}, 'Peer-to-peer calls'),
      h('p', {}, 'Pick someone from the list to start an audio or video call, start a group call, or go live.'),
      this.idleHints,
    );
  }

  private renderIdleHints(): void {
    const { config, push } = this.app;
    const hints: Node[] = [
      h('li', {}, 'Media flows directly between browsers (mesh). Direct P2P is always tried first; TURN relay is only a fallback.'),
    ];
    if (!config.hasTurn) hints.push(h('li', { class: 'warn' }, 'No TURN server configured – calls between restrictive networks may fail.'));
    const inst = this.app.pwa.installState;
    if (inst === 'available' || inst === 'ios-manual')
      hints.push(h('li', {}, h('button', { class: 'btn small', onclick: () => this.install() }, h('span', { html: icons.download }), 'Install MeshCall as an app')));
    if (push.status === 'install-required') hints.push(h('li', {}, 'On iPhone/iPad, install MeshCall to your Home Screen to receive call notifications.'));
    if (!window.isSecureContext) hints.push(h('li', { class: 'warn' }, 'This page is not a secure context – camera, microphone and notifications need HTTPS.'));
    const card = renderEnableNotificationsCard(this.app, () => this.renderIdleHints());
    this.idleHints.replaceChildren(...(card ? [card] : []), h('ul', {}, ...hints));
  }
}
