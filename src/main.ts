import './styles/main.css';
import { createApp, joinRoom, startApp } from './app';
import { CONFIG, resolveServerUrl } from './config';
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

  /** Show the main UIManager after joining the fixed room. */
  const showMainUI = (ctx?: LaunchContext) => {
    document.title = 'MeshCall';
    if (!ui) {
      ui = new UIManager(app, mount, {
        onLeaveRoom: () => {
          // In WhatsApp mode there's nothing to “leave” to — just go back to contacts.
          showContactsScreen();
        },
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

  /** Show the contacts screen (and join the fixed room in the background if not yet joined). */
  let contactsScreen: ContactsScreen | null = null;
  const showContactsScreen = () => {
    document.title = 'MeshCall';
    if (contactsScreen) return; // already shown
    contactsScreen = new ContactsScreen({
      app,
      contacts: app.contacts,
      onCall: (contact, media) => {
        contactsScreen?.destroy();
        contactsScreen = null;
        const deviceId = app.presence.deviceIdForPhone(contact.phone);
        if (deviceId) {
          showMainUI();
          ui?.callUser(deviceId, media);
        } else {
          showMainUI();
          ui?.toast?.('warn', `${contact.name} is not currently online`);
        }
      },
      onMessage: (contact) => {
        contactsScreen?.destroy();
        contactsScreen = null;
        const deviceId = app.presence.deviceIdForPhone(contact.phone);
        if (deviceId) {
          showMainUI();
          ui?.openConversation(deviceId);
        } else {
          showMainUI();
          ui?.toast?.('warn', `${contact.name} is not currently online`);
        }
      },
    });
    mount.replaceChildren(contactsScreen.el);
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

  // If the server rejects our token (expired / revoked), show the sign-in screen.
  app.signaling.events.on('authFailed', () => {
    app.identity.clearAuth();
    app.signaling.stop();
    contactsScreen?.destroy(); contactsScreen = null;
    renderOnboarding(mount, app.config.serverUrl, (result) => {
      app.identity.setAuth(result.token, result.name, result.phone);
      void app.signaling.start();
    });
  });

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

  if (!app.identity.isLoggedIn) {
    renderOnboarding(mount, app.config.serverUrl, (result) => {
      app.identity.setAuth(result.token, result.name, result.phone);
      void launch();
    });
  } else {
    await launch();
  }
}

resolveServerUrl().then((url) => {
  CONFIG.serverUrl = url;
  void boot();
});
