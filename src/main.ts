import './styles/main.css';
import { createApp, joinRoom, startApp } from './app';
import { CONFIG, resolveServerUrl, resolveIceServers } from './config';
import { createLogger, logHub } from './core/logger';
import { renderOnboarding } from './ui/views/Onboarding';
import { renderPermissionsScreen } from './ui/views/PermissionsPanel';
import { isHeadless, isNative, native } from './native/native';
import { ContactsScreen } from './ui/views/ContactsScreen';
import { validateRoomName } from './services/RoomService';
import { h } from './ui/dom';
import type { LaunchContext } from './push/payloads';
import { UIManager } from './ui/UIManager';
import { collectDiagnostics } from './ui/views/DiagnosticsPanel';
import { listIceServers, probeIceServers, testIceServer } from './webrtc/IceServerProbe';
import { WebRTCManager } from './webrtc/WebRTCManager';

logHub.setLevel(localStorage.getItem('voip.logLevel') ?? CONFIG.logLevel);
const log = createLogger('App');
const mount = document.getElementById('app')!;

window.addEventListener('unhandledrejection', (e) => log.error('Unhandled promise rejection', e.reason));
window.addEventListener('error', (e) => log.error('Uncaught error', e.error ?? e.message));

async function boot(): Promise<void> {
  if (!WebRTCManager.isSupported()) {
    mount.innerHTML = `<div class="onboarding-wrap"><div class="card"><h1>Unsupported browser</h1><p>WebRTC and media capture are required. Use a current Chrome, Edge, Firefox or Safari over HTTPS (or localhost).</p></div></div>`;
    return;
  }
  const app = createApp();
  // Register the Service Worker immediately (offline shell + installability), even before the
  // user has entered a name.
  void app.pwa.register();
  // Debug handle: window.__voip.diagnostics() → selected candidate pair / path per peer.
  (window as unknown as { __voip: unknown }).__voip = {
    app,
    diagnostics: () => collectDiagnostics(app),
    probeIceServers: () => probeIceServers(app.config.iceServers),
    /** Test any single server, e.g. __voip.testIceServer({ urls: 'turn:host:3478', username, credential }). */
    testIceServer: (server: RTCIceServer, timeoutMs?: number) => testIceServer(listIceServers([server])[0]!, timeoutMs),
  };

  let ui: UIManager | null = null;

  /** Fixed hidden room every user auto-joins (WhatsApp-style: no room name entry). */
  const FIXED_ROOM_NAME = 'voip';
  const fixedRoom = (() => {
    const v = validateRoomName(FIXED_ROOM_NAME);
    if (!v.ok) throw new Error('Invalid fixed room name');
    return v.room;
  })();

  /** Ring someone back once their presence is known (wait briefly after joining a room). */
  const callBack = async (ctx: { callerId?: string; callType?: string }) => {
    if (!ctx.callerId) return;
    for (let i = 0; i < 20 && app.presence.status(ctx.callerId) === 'unknown'; i++) await new Promise((r) => setTimeout(r, 250));
    ui?.callUser(ctx.callerId, ctx.callType === 'video' ? 'video' : 'audio');
  };

  const doLogout = () => {
    app.identity.clearAuth();
    app.signaling.stop();
    // Reload the page to clear all in-memory state and show the login screen cleanly.
    window.location.reload();
  };

  /** Show the main UIManager. UIManager is created once and kept alive. */
  const showMainUI = (ctx?: LaunchContext) => {
    document.title = 'MeshCall';
    if (!ui) {
      ui = new UIManager(app, mount, {
        onLeaveRoom: () => showContactsScreen(),
        onLogout: doLogout,
      });
    } else {
      ui.attach(mount);
    }
    // Android, first time: ask for permissions + battery exemption.
    if (isNative && !isHeadless && !native.setupDone) {
      const overlay = document.createElement('div');
      overlay.className = 'perm-overlay';
      document.body.appendChild(overlay);
      renderPermissionsScreen(overlay, () => overlay.remove());
    }
    if (ctx?.kind === 'incoming-call' && ctx.action === 'callback') void callBack(ctx);
    else if (ctx?.kind === 'incoming-call' && ctx.callType === 'live') { if (ctx.action === 'accept') app.live.acceptInvite(ctx.callId); }
    else if (ctx?.kind === 'incoming-call' && ctx.callType !== 'live') (ctx.action === 'accept' ? app.calls.acceptFromNotification(ctx.callId, ctx.callerName, ctx.callerId) : app.calls.expectCall(ctx.callId, ctx.callerName));
    else if (ctx?.kind === 'chat-message') ui?.openConversation(ctx.senderId, ctx.messageId);
  };

  /** Show the contacts screen inside UIManager's stage so the topbar and bottom nav stay visible. */
  let contactsScreen: ContactsScreen | null = null;
  const showContactsScreen = () => {
    document.title = 'MeshCall';
    // Ensure UIManager is mounted first so topbar + bottom-nav are always visible.
    if (!ui) showMainUI();
    if (contactsScreen) { ui?.showContacts(contactsScreen.el); return; }
    contactsScreen = new ContactsScreen({
      app,
      contacts: app.contacts,
      onCall: (contact, media) => {
        ui?.hideContacts();
        const deviceId = app.presence.deviceIdForPhone(contact.phone);
        if (deviceId) {
          ui?.callUser(deviceId, media);
        } else {
          ui?.toast?.('warn', `${contact.name} is not currently online`);
        }
      },
      onMessage: (contact) => {
        // Do NOT hideContacts() here — the drawer is a full-screen overlay, contacts stays
        // in the stage underneath so it's still there when the drawer closes.
        const deviceId = app.presence.deviceIdForPhone(contact.phone);
        ui?.openConversation(deviceId ?? contact.phone);
      },
    });
    ui?.showContacts(contactsScreen.el);
    void contactsScreen.init();
  };

  /** Auto-join the fixed room (silent – user never sees room name). */
  let joining: Promise<void> | null = null;
  const autoJoinFixed = (): Promise<void> => {
    if (joining) return joining;
    if (app.rooms.current?.roomId === fixedRoom.roomId) return Promise.resolve();
    mount.replaceChildren(h('div', { class: 'boot-splash', role: 'status' }, 'Connecting…'));
    joining = joinRoom(app, fixedRoom)
      .then(() => {
        app.rooms.saveActive(fixedRoom);
        log.info('Auto-joined fixed room');
      })
      .catch((err) => {
        log.warn('Fixed room join failed', err instanceof Error ? err.message : String(err));
      })
      .finally(() => { joining = null; });
    return joining;
  };

  /**
   * Handle push/click notifications. With the fixed-room model the room is always the
   * same, so we just apply the action directly.
   */
  const handleLaunchContext = (ctx: LaunchContext, source: 'click' | 'push') => {
    if (ctx.kind === 'chat-message' && ctx.replyText) {
      const text = ctx.replyText.trim();
      if (text && app.rooms.current) { app.dms.send(ctx.senderId, text); app.dms.markRead(ctx.senderId); }
      return;
    }
    if (ctx.kind === 'incoming-call' && ctx.replyText && ctx.callerId) {
      const text = ctx.replyText.trim();
      if (text && app.rooms.current) { app.dms.send(ctx.callerId, text); app.dms.markRead(ctx.callerId); }
      return;
    }
    if (ctx.kind === 'incoming-call' && ctx.missed && ctx.action !== 'callback') return;
    if (ctx.kind === 'incoming-call' && ctx.action === 'decline') return app.calls.declineFromNotification(ctx.callId);
    if (ctx.kind === 'incoming-call' && ctx.action === 'callback') {
      if (ui) return void callBack(ctx);
      contactsScreen?.destroy(); contactsScreen = null;
      showMainUI(ctx);
      return;
    }
    const apply = () => {
      if (ctx.kind === 'incoming-call') {
        if (ctx.callType === 'live') { if (ctx.action === 'accept') app.live.acceptInvite(ctx.callId); }
        else (ctx.action === 'accept' ? app.calls.acceptFromNotification(ctx.callId, ctx.callerName, ctx.callerId) : app.calls.expectCall(ctx.callId, ctx.callerName));
      } else if (source === 'click') ui?.openConversation(ctx.senderId, ctx.messageId);
      else ui?.toast('info', `New message from ${ctx.senderName ?? 'someone'}`, { label: 'Open', run: () => ui?.openConversation(ctx.senderId, ctx.messageId) });
    };
    if (ui) return apply();
    // Not showing UI yet – switch to it and apply the action.
    contactsScreen?.destroy(); contactsScreen = null;
    showMainUI(ctx);
  };
  app.notifications.events.on('click', (ctx) => handleLaunchContext(ctx, 'click'));
  app.notifications.events.on('pushCall', (ctx) => handleLaunchContext(ctx, 'push'));
  app.notifications.events.on('pushChat', (ctx) => handleLaunchContext(ctx, 'push'));

  // If an incoming call arrives while the contacts screen is showing (no push notification,
  // e.g. a new user who hasn't set up push yet), switch to UIManager so the call dialog appears.
  app.calls.events.on('state', (s) => {
    if (s?.status === 'ringing' && s.direction === 'incoming') {
      // If still on contacts screen, hide it so the incoming call dialog is visible.
      if (ui) ui.hideContacts();
      else showMainUI();
    }
  });

  // On auth failure: first try fetching a fresh server URL (the Cloudflare tunnel may have
  // changed) and retry. Only show the login screen if the token is genuinely rejected on
  // the NEW URL too (i.e. the secret changed, e.g. server wiped its data).
  let authRetrying = false;
  app.signaling.events.on('authFailed', () => {
    if (authRetrying) {
      // Second failure even after URL refresh → token truly invalid, force re-login.
      authRetrying = false;
      doLogout();
      return;
    }
    // First failure: re-fetch the pointer URL in case the tunnel changed, then retry.
    authRetrying = true;
    log.info('Auth failed – refreshing server URL and retrying…');
    resolveServerUrl().then((url) => {
      CONFIG.serverUrl = url;
      void app.signaling.start();
    });
  });

  // Periodically re-fetch the server URL while disconnected so the app auto-reconnects
  // when the Cloudflare tunnel restarts with a new URL.
  let urlPollTimer: ReturnType<typeof setInterval> | null = null;
  const clearUrlPollTimer = () => { if (urlPollTimer) { clearInterval(urlPollTimer); urlPollTimer = null; } };
  app.signaling.events.on('status', (status) => {
    if (status === 'connected') {
      authRetrying = false;
      clearUrlPollTimer();
    } else if (status === 'unavailable' || status === 'reconnecting') {
      if (!urlPollTimer) {
        urlPollTimer = setInterval(() => {
          resolveServerUrl().then((url) => {
            if (url !== CONFIG.serverUrl) {
              log.info(`Server URL changed → ${url}`);
              CONFIG.serverUrl = url;
              app.signaling.reconnectNow('url-changed');
            }
          });
        }, 15_000);
      }
    }
  });
  // Cleanup on unload
  window.addEventListener('beforeunload', clearUrlPollTimer);

  const launch = async () => {
    await startApp(app);
    let launchCtx = await app.pwa.consumeLaunchContext();
    if (launchCtx?.kind === 'incoming-call' && launchCtx.missed && launchCtx.action !== 'callback') launchCtx = null;
    log.info(`Launch context: ${launchCtx ? launchCtx.kind + '/' + launchCtx.action : 'none'}`);
    log.info(`Started as ${app.identity.displayName} (${app.identity.deviceId.slice(0, 8)})`);

    // Always join the fixed room first.
    await autoJoinFixed();

    if (launchCtx) {
      handleLaunchContext(launchCtx, 'click');
    } else {
      // Default: show the contacts screen.
      showContactsScreen();
    }
  };

  // Double-press back to exit (while on the contacts/root screen).
  if (isNative) {
    let lastBack = 0;
    native.onRootBack = () => {
      const now = Date.now();
      if (now - lastBack < 2000) {
        native.exitApp();
        return true;
      }
      lastBack = now;
      contactsScreen?.setStatus('Press back again to exit');
      setTimeout(() => contactsScreen?.setStatus?.(''), 2000);
      return true;
    };
  }

  if (!app.identity.isLoggedIn) {
    renderOnboarding(mount, app.config.serverUrl, (result) => {
      app.identity.setAuth(result.token, result.name, result.phone, result.role);
      app.contacts.reloadForPhone();
      void launch();
    });
  } else {
    await launch();
  }
}

resolveServerUrl().then(async (url) => {
  CONFIG.serverUrl = url;
  await resolveIceServers(url);
  void boot();
});
