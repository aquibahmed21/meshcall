import { PUSH_STATUS_LABEL } from '../services/PushNotificationService';
import type { AppContext } from '../app';
import { isTerminal } from '../calls/CallStateMachine';
import type { SavedCall } from '../calls/CallManager';
import type { NetworkQuality } from '../types/state';
import { backStack } from './BackStack';
import { colorFor, h, initials, nodes } from './dom';
import { icons, logo } from './icons';
import { CallView } from './views/CallView';
import { DiagnosticsPanel } from './views/DiagnosticsPanel';
import { openAddParticipants, openGoLive, openGroupCall, openIncomingCall, openInstallHelp, openLiveInvite, openManageAudience, openOfflineCallDialog, openSettings } from './views/Dialogs';
import { ConversationDrawer } from './views/ConversationDrawer';
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
  private pushPill = h('button', { class: 'pill pill-btn', type: 'button', onclick: () => openSettings(this.app, 'device') });
  private banner = h('div', { class: 'banner', hidden: true });
  private nav: HTMLElement;
  private incoming: Modal | null = null;
  private diagOpen = false;
  private view: MobileView = 'people';
  private lastCallId: string | null = null;
  private worstQuality: NetworkQuality = 'unknown';
  private rejoin: SavedCall | null = null;
  /** Top bar: my profile (opens Settings) and the ⋮ menu (room, install, leave). */
  private profile = h('button', { class: 'me', type: 'button', title: 'Profile & settings' });
  private topMenu = h('div', { class: 'more-menu top-menu', role: 'menu', hidden: true });
  private topMenuBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'More', title: 'More', 'aria-haspopup': 'menu', 'aria-expanded': 'false', html: icons.more });
  private drawer!: ConversationDrawer;
  /** History entries owned by this view (see BackStack). */
  private viewBack: (() => void) | null = null;
  private diagBack: (() => void) | null = null;
  private menuBack: (() => void) | null = null;
  private callGuard: (() => void) | null = null;
  private readonly mobile = matchMedia('(max-width: 767px)');

  constructor(
    private readonly app: AppContext,
    mount: HTMLElement,
    private readonly opts: UIManagerOptions,
  ) {
    this.sidebar = new Sidebar(app, {
      onGroup: () => openGroupCall(app),
      onGoLive: () => openGoLive(app),
      onOpenContact: (id) => this.openConversation(id),
    });
    this.drawer = new ConversationDrawer(app, (id, media) => this.callUser(id, media));
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
        this.profile,
        h('div', { class: 'pills' }, this.pushPill, this.sigPill, this.netPill),
        h('button', { class: 'icon-btn', 'aria-label': 'Diagnostics', title: 'Diagnostics', html: icons.stats, onclick: () => this.toggleDiagnostics() }),
        h('button', { class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', html: icons.settings, onclick: () => openSettings(app) }),
        h('div', { class: 'top-menu-wrap' }, this.topMenuBtn, this.topMenu),
      ),
      this.banner,
      h('div', { class: 'layout' }, this.sidebar.el, this.stage, this.diagnostics.el),
      this.nav,
      this.drawer.el,
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

  /**
   * Call button: online → normal WebRTC call; offline/unknown → explanation dialog (never a blind
   * WebRTC attempt, never a disabled button).
   */
  callUser(userId: string, media: 'audio' | 'video'): void {
    const c = this.app.calls.state;
    if (c?.kind === 'live' && c.role === 'broadcaster' && this.app.live.state?.streamId) {
      void this.callIntoStream(userId);
      return;
    }
    if (this.app.calls.inCall) {
      this.toasts.show('info', 'You are already in a call');
      return;
    }
    if (this.app.presence.status(userId) === 'online') void this.app.calls.startDirectCall(userId, media);
    else openOfflineCallDialog(this.app, userId, media, () => this.openConversation(userId));
  }

  /** Streamer calls someone into the running live stream (ringing if online, targeted push if not). */
  private async callIntoStream(userId: string): Promise<void> {
    const name = this.app.presence.nameOf(userId);
    const r = await this.app.live.callViewer(userId);
    if (r === 'watching') this.toasts.show('info', `${name} is already watching`);
    else if (r === 'ringing') this.toasts.show('info', `Calling ${name} into the stream…`);
    else if (r === 'push') this.toasts.show('info', `${name} is offline – sent a call notification`);
    else if (r === 'waiting') this.toasts.show('info', `${name} is offline – they'll be rung when they come online`);
  }

  /** Open the 1:1 conversation (optionally highlighting a message from a notification). */
  openConversation(userId: string, highlightMessageId?: string): void {
    this.drawer.open(userId, highlightMessageId);
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

  /** Header identity: avatar with a presence dot, my name, and the room I'm in. */
  private renderProfile(): void {
    const { identity, signaling, rooms } = this.app;
    const sig = signaling.status;
    const state = sig === 'connected' ? 'online' : sig === 'unavailable' ? 'offline' : 'connecting';
    const stateText = state === 'online' ? 'Online' : state === 'offline' ? 'Offline' : 'Connecting';
    const room = rooms.current?.roomName;
    this.profile.setAttribute('aria-label', `${identity.displayName}, ${stateText}${room ? `, room ${room}` : ''} – profile and settings`);
    this.profile.onclick = () => openSettings(this.app, 'device');
    this.profile.replaceChildren(
      h(
        'span',
        { class: 'me-avatar' },
        h('span', { class: 'avatar', style: `--avatar:${colorFor(identity.deviceId)}` }, initials(identity.displayName)),
        h('span', { class: `presence-dot ${state}`, title: stateText }),
      ),
      h('span', { class: 'me-text' }, h('strong', {}, identity.displayName), ...nodes(room ? h('small', {}, room) : null)),
    );
  }

  private setTopMenu(open: boolean, viaBack = false): void {
    if (this.topMenu.hidden === !open) return;
    this.topMenu.hidden = !open;
    document.body.classList.toggle('menu-open', open);
    if (open) this.menuBack = backStack.push(() => this.setTopMenu(false, true));
    else {
      if (!viaBack) this.menuBack?.();
      this.menuBack = null;
    }
    this.topMenuBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      this.renderTopMenu();
      (this.topMenu.querySelector('button') as HTMLElement | null)?.focus();
    }
  }

  private renderTopMenu(): void {
    const room = this.app.rooms.current;
    const inst = this.app.pwa.installState;
    const item = (icon: string, label: string, run: () => void, cls = '') =>
      h('button', { class: `menu-item ${cls}`.trim(), role: 'menuitem', type: 'button', onclick: () => (this.setTopMenu(false), run()) }, h('span', { html: icon }), label);
    this.topMenu.replaceChildren(
      ...nodes(
        room ? h('div', { class: 'menu-label', title: room.roomName }, h('small', {}, 'Room'), h('strong', {}, room.roomName)) : null,
        inst === 'available' || inst === 'ios-manual' ? item(icons.download, 'Install app', () => this.install()) : null,
        room
          ? item(
              icons.exit,
              'Leave room',
              () => {
                if (this.app.calls.inCall && !confirm('Leaving the room ends your current call. Leave anyway?')) return;
                this.opts.onLeaveRoom();
              },
              'danger',
            )
          : null,
      ),
    );
  }

  private wire(): void {
    const { app } = this;
    this.topMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setTopMenu(this.topMenu.hidden);
    });
    document.addEventListener('click', (e) => {
      if (!this.topMenu.hidden && !this.topMenu.contains(e.target as Node)) this.setTopMenu(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.topMenu.hidden) {
        this.setTopMenu(false);
        this.topMenuBtn.focus();
      }
    });
    app.pwa.events.on('install', () => !this.topMenu.hidden && this.renderTopMenu());
    app.rooms.events.on('change', (room) => {
      this.renderTopMenu();
      this.renderProfile();
      if (!room) this.drawer.close();
    });
    app.dms.events.on('change', () => this.sidebar.renderUsers());
    app.dms.events.on('incoming', (m) => {
      if (this.drawer.openPeer === m.senderId && document.visibilityState === 'visible') return;
      const room = app.rooms.current;
      void app.notifications.showDirectMessage({ messageId: m.messageId, senderId: m.senderId, senderName: m.senderName, text: m.text, roomId: m.roomId, roomName: room?.roomName ?? '' });
      this.toasts.show('info', `${m.senderName}: ${m.text.slice(0, 80)}`, 6000, { label: 'Open', run: () => this.openConversation(m.senderId, m.messageId) });
    });
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
      if (app.calls.inCall) {
        this.toasts.show('info', `${invite.hostName} ${invite.ring ? 'is calling you into' : 'added you to'} the live stream “${invite.title}” – find it under Live when you're free`);
        return;
      }
      openLiveInvite(app, invite);
      // Tab hidden/unfocused: also a system notification (NotificationService skips it when focused).
      if (invite.ring) {
        const room = app.rooms.current;
        void app.notifications.showIncomingCall({ callId: invite.streamId, callerId: invite.hostId, callerName: invite.hostName, media: 'video', callKind: 'live', groupName: invite.title, roomId: room?.roomId, roomName: room?.roomName });
      }
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
    app.push.events.on('status', () => {
      this.renderIdleHints();
      this.renderPills();
    });
  }

  // ── call lifecycle ───────────────────────────────────────────────────────

  private onCallState(): void {
    const c = this.app.calls.state;
    // First, so the guard sits BELOW the Call view's history entry (Back: call → people → guard).
    this.guardCall(!!c && !isTerminal(c.status));
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
        onCallViewer: (id) => this.callUser(id, 'audio'),
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

  /** During a call, Back at the top level must not leave the page (that would end the call). */
  private guardCall(active: boolean): void {
    if (active && !this.callGuard) {
      this.callGuard = backStack.push(() => {
        this.toasts.show('info', 'Hang up to leave the call');
        return false;
      });
    } else if (!active && this.callGuard) {
      this.callGuard();
      this.callGuard = null;
    }
  }

  private toggleDiagnostics(force?: boolean, viaBack = false): void {
    const open = force ?? !this.diagOpen;
    if (open && !this.diagBack) this.diagBack = backStack.push(() => this.toggleDiagnostics(false, true));
    if (!open) {
      if (!viaBack) this.diagBack?.();
      this.diagBack = null;
    }
    this.diagOpen = open;
    this.diagnostics.el.hidden = !this.diagOpen;
    this.root.classList.toggle('diag-open', this.diagOpen);
    if (this.diagOpen) this.diagnostics.render();
  }

  /**
   * Mobile sections: People is the root; Live / Call own one history entry, so Back returns to
   * People (a running call keeps going – "Return to call" stays available).
   */
  private setView(view: MobileView, viaBack = false): void {
    if (view === 'people') {
      if (!viaBack) this.viewBack?.();
      this.viewBack = null;
    } else if (!this.viewBack && this.mobile.matches) {
      this.viewBack = backStack.push(() => this.setView('people', true));
    }
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
    this.renderProfile();
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
    const push = this.app.push.status;
    const on = push === 'enabled';
    this.pushPill.textContent = on ? '🔔 Push on' : push === 'connecting' ? '🔔 Push…' : '🔕 Push off';
    this.pushPill.dataset.state = on ? 'ok' : push === 'connecting' ? 'warn' : 'bad';
    this.pushPill.title = `Push notifications on this device: ${PUSH_STATUS_LABEL[push]} – open Settings`;
    this.pushPill.setAttribute('aria-label', this.pushPill.title);
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
      h('div', { class: 'brand-mark big', html: logo }),
      h('h1', {}, 'MeshCall'),
      this.idleHints,
    );
  }

  private renderIdleHints(): void {
    const { push } = this.app;
    // Only problems the user must act on – no general guidance.
    const hints: Node[] = [];
    if (push.status === 'install-required') hints.push(h('li', {}, 'Install MeshCall to your Home Screen to get call notifications.'));
    if (!window.isSecureContext) hints.push(h('li', { class: 'warn' }, 'Camera, microphone and notifications need HTTPS.'));
    const card = renderEnableNotificationsCard(this.app, () => this.renderIdleHints());
    this.idleHints.replaceChildren(...(card ? [card] : []), ...(hints.length ? [h('ul', {}, ...hints)] : []));
  }
}
