import { confirmDialog } from './ui/views/ConfirmDialog';
import './styles/main.css';
import { createApp, joinRoom, leaveRoom, startApp } from './app';
import { CONFIG, resolveServerUrl } from './config';
import { createLogger, logHub } from './core/logger';
import { renderOnboarding } from './ui/views/Onboarding';
import { renderPermissionsScreen } from './ui/views/PermissionsPanel';
import { isHeadless, isNative, native } from './native/native';
import { renderRoomScreen } from './ui/views/RoomScreen';
import { validateRoomName, type RoomContext } from './services/RoomService';
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
  // A notification click may carry the room of the call (?room=…) → prefill, never auto-join.
  const params = new URLSearchParams(location.search);
  let prefill = params.get('room') ?? undefined;
  /** Notification context that can only be acted on after joining its room. */
  let pendingContext: LaunchContext | undefined;

  /** Ring someone back once their presence is known (wait briefly after joining a room). */
  const callBack = async (ctx: { callerId?: string; callType?: string }) => {
    if (!ctx.callerId) return;
    for (let i = 0; i < 20 && app.presence.status(ctx.callerId) === 'unknown'; i++) await new Promise((r) => setTimeout(r, 250));
    ui?.callUser(ctx.callerId, ctx.callType === 'video' ? 'video' : 'audio');
  };

  /** Everything that happens once a room is joined (UI, permissions overlay, notification action). */
  const afterJoin = (room: { roomName: string }, ctx: LaunchContext | undefined) => {
    prefill = undefined;
    document.title = `${room.roomName} – MeshCall`;
    if (!ui) {
      ui = new UIManager(app, mount, {
        onLeaveRoom: () => {
          app.rooms.clearActive(); // explicit leave → next launch asks for a room
          leaveRoom(app);
          showRoomScreen();
        },
      });
    } else {
      ui.attach(mount);
    }
    // Android, first time in a room: now ask for permissions + battery exemption (as an overlay).
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

  /** Re-enter a room we are already "logged in" to: no room screen, no extra tap. */
  let entering: Promise<void> | null = null;
  const directJoin = (room: RoomContext, ctx?: LaunchContext): Promise<void> => {
    // Already on its way in (e.g. a notification action arrived while booting): just hand over the context.
    if (entering) {
      if (ctx) pendingContext = ctx;
      return entering;
    }
    entering = doDirectJoin(room, ctx).finally(() => (entering = null));
    return entering;
  };
  const doDirectJoin = async (room: RoomContext, ctx?: LaunchContext) => {
    document.title = `${room.roomName} – MeshCall`;
    mount.replaceChildren(h('div', { class: 'boot-splash', role: 'status' }, 'Connecting…'));
    try {
      await joinRoom(app, room);
    } catch (err) {
      prefill = room.roomName;
      return showRoomScreen(err instanceof Error ? err.message : 'Unable to join the room');
    }
    const pending = pendingContext ?? ctx;
    pendingContext = undefined;
    afterJoin(room, pending);
  };

  const showRoomScreen = (error?: string, info?: string, autoJoin = false) => {
    document.title = 'MeshCall – Join a room';
    renderRoomScreen(mount, {
      userName: app.identity.displayName,
      prefill,
      error,
      info,
      autoJoin,
      recent: app.rooms.recent(),
      onJoin: async (room) => {
        await joinRoom(app, room);
        const ctx = pendingContext;
        pendingContext = undefined;
        afterJoin(room, ctx);
      },
    });
  };

  /**
   * A notification was clicked (or a push arrived while the app was visible). Rooms are
   * isolated, so another room is only ever entered with the user's consent (switch offer or
   * prefilled room screen).
   *   incoming-call → the call rings with Accept/Reject (never auto-accepted)
   *   chat-message  → that conversation opens with the message highlighted
   */
  const handleLaunchContext = (ctx: LaunchContext, source: 'click' | 'push') => {
    if (ctx.kind === 'chat-message' && ctx.replyText) {
      // Inline reply from the notification: send it without opening the app.
      const text = ctx.replyText.trim();
      if (text && app.rooms.current) {
        app.dms.send(ctx.senderId, text);
        app.dms.markRead(ctx.senderId);
      }
      return;
    }
    if (ctx.kind === 'incoming-call' && ctx.replyText && ctx.callerId) {
      const text = ctx.replyText.trim();
      if (text && app.rooms.current) {
        app.dms.send(ctx.callerId, text);
        app.dms.markRead(ctx.callerId);
      }
      return;
    }
    if (ctx.kind === 'incoming-call' && ctx.missed && ctx.action !== 'callback') return;
    if (ctx.kind === 'incoming-call' && ctx.action === 'decline') return app.calls.declineFromNotification(ctx.callId);
    if (ctx.kind === 'incoming-call' && ctx.action === 'callback') {
      // "Call back" on a missed-call notification: ring them again (in their room).
      const t = ctx.roomName ? validateRoomName(ctx.roomName) : null;
      const cur = app.rooms.current;
      if (cur && (!t?.ok || t.room.roomId === cur.roomId)) return void callBack(ctx);
      if (!t?.ok) return;
      if (cur) leaveRoom(app);
      prefill = t.room.roomName;
      pendingContext = ctx;
      return showRoomScreen(undefined, `Join “${t.room.roomName}” to call ${ctx.callerName ?? 'them'} back`, !cur);
    }
    const target = ctx.roomName ? validateRoomName(ctx.roomName) : null;
    const current = app.rooms.current;
    const sameRoom = !!current && (!target?.ok || target.room.roomId === current.roomId);
    const apply = () => {
      if (ctx.kind === 'incoming-call') {
        // Live stream invitation: the streamer rings us again as soon as we are online in the room.
        if (ctx.callType === 'live') { if (ctx.action === 'accept') app.live.acceptInvite(ctx.callId); }
        else (ctx.action === 'accept' ? app.calls.acceptFromNotification(ctx.callId, ctx.callerName, ctx.callerId) : app.calls.expectCall(ctx.callId, ctx.callerName));
      } else if (source === 'click') ui?.openConversation(ctx.senderId, ctx.messageId);
      else ui?.toast('info', `New message from ${ctx.senderName ?? 'someone'}`, { label: 'Open', run: () => ui?.openConversation(ctx.senderId, ctx.messageId) });
    };
    if (sameRoom) return apply();
    if (!target?.ok) return;
    const who = (ctx.kind === 'incoming-call' ? ctx.callerName : ctx.senderName) ?? 'Someone';
    const info = ctx.kind === 'incoming-call' && ctx.callType === 'live' ? `${who} invites you to a live stream in “${target.room.roomName}”. Join the room to watch.` : ctx.kind === 'incoming-call' ? `${who} is calling you in “${target.room.roomName}”. Join the room to answer.` : `${who} sent you a message in “${target.room.roomName}”. Join the room to read it.`;
    const go = () => {
      if (current) leaveRoom(app);
      prefill = target.room.roomName;
      pendingContext = ctx;
      // Not in any room yet (app was closed) and the user tapped a call/message notification →
      // that tap is the consent: join its room straight away so the call can be answered in time.
      if (!current && source === 'click') return void directJoin(target.room, ctx);
      showRoomScreen(undefined, info, false);
    };
    if (!current || !ui) return go();
    ui.toast('info', ctx.kind === 'incoming-call' ? `${who} is calling you in room “${target.room.roomName}”` : `New message from ${who} in room “${target.room.roomName}”`, {
      label: 'Switch room',
      run: async () => {
        if (app.calls.inCall && !(await confirmDialog({ title: 'Switch room?', message: 'This ends your current call.', confirmLabel: 'Switch', danger: true }))) return;
        go();
      },
    });
  };
  app.notifications.events.on('click', (ctx) => handleLaunchContext(ctx, 'click'));
  app.notifications.events.on('pushCall', (ctx) => handleLaunchContext(ctx, 'push'));
  app.notifications.events.on('pushChat', (ctx) => handleLaunchContext(ctx, 'push'));

  // If the server rejects our token (expired / revoked), show the sign-in screen.
  app.signaling.events.on('authFailed', () => {
    app.identity.clearAuth();
    app.signaling.stop();
    renderOnboarding(mount, app.config.serverUrl, (result) => {
      app.identity.setAuth(result.token, result.name, result.phone);
      void app.signaling.start();
    });
  });

  const launch = async () => {
    await startApp(app);
    let launchCtx = await app.pwa.consumeLaunchContext();
    if (launchCtx?.kind === 'incoming-call' && launchCtx.missed && launchCtx.action !== 'callback') launchCtx = null; // plain tap on a missed-call notification just opens the app
    log.info(`Launch context: ${launchCtx ? launchCtx.kind + '/' + launchCtx.action : 'none'}`);
    log.info(`Started as ${app.identity.displayName} (${app.identity.deviceId.slice(0, 8)})`);
    const saved = app.rooms.savedActive();
    const ctxRoom = launchCtx?.roomName ? validateRoomName(launchCtx.roomName) : null;
    if (saved && !prefill && (!launchCtx || !ctxRoom?.ok || ctxRoom.room.roomId === saved.roomId)) {
      // Already logged in to this room: go straight in – never show the room screen again.
      void directJoin(saved, launchCtx ?? undefined);
    } else if (launchCtx) handleLaunchContext(launchCtx, 'click');
    else if (saved && !prefill) {
      // The app was closed/reloaded while in a room → reopen it (same join path as the Join button).
      prefill = saved.roomName;
      showRoomScreen(undefined, undefined, true);
    } else showRoomScreen();
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
