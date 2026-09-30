import './styles/main.css';
import { createApp, joinRoom, leaveRoom, startApp } from './app';
import { CONFIG } from './config';
import { createLogger, logHub } from './core/logger';
import { renderOnboarding } from './ui/views/Onboarding';
import { renderRoomScreen } from './ui/views/RoomScreen';
import { validateRoomName } from './services/RoomService';
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
        prefill = undefined;
        const ctx = pendingContext;
        pendingContext = undefined;
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
        if (ctx?.kind === 'incoming-call' && ctx.callType !== 'live') app.calls.expectCall(ctx.callId, ctx.callerName);
        else if (ctx?.kind === 'chat-message') ui.openConversation(ctx.senderId, ctx.messageId);
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
    if (ctx.kind === 'incoming-call' && ctx.action === 'decline') return app.calls.declineFromNotification(ctx.callId);
    const target = ctx.roomName ? validateRoomName(ctx.roomName) : null;
    const current = app.rooms.current;
    const sameRoom = !!current && (!target?.ok || target.room.roomId === current.roomId);
    const apply = () => {
      if (ctx.kind === 'incoming-call') {
        // Live stream invitation: the streamer rings us again as soon as we are online in the room.
        if (ctx.callType !== 'live') app.calls.expectCall(ctx.callId, ctx.callerName);
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
      showRoomScreen(undefined, info);
    };
    if (!current || !ui) return go();
    ui.toast('info', ctx.kind === 'incoming-call' ? `${who} is calling you in room “${target.room.roomName}”` : `New message from ${who} in room “${target.room.roomName}”`, {
      label: 'Switch room',
      run: () => {
        if (app.calls.inCall && !confirm('Switching rooms ends your current call. Switch anyway?')) return;
        go();
      },
    });
  };
  app.notifications.events.on('click', (ctx) => handleLaunchContext(ctx, 'click'));
  app.notifications.events.on('pushCall', (ctx) => handleLaunchContext(ctx, 'push'));
  app.notifications.events.on('pushChat', (ctx) => handleLaunchContext(ctx, 'push'));

  const launch = async () => {
    await startApp(app);
    const launchCtx = await app.pwa.consumeLaunchContext();
    log.info(`Started as ${app.identity.displayName} (${app.identity.deviceId.slice(0, 8)})`);
    const saved = app.rooms.savedActive();
    if (launchCtx) handleLaunchContext(launchCtx, 'click');
    else if (saved && !prefill) {
      // The app was closed/reloaded while in a room → reopen it (same join path as the Join button).
      prefill = saved.roomName;
      showRoomScreen(undefined, undefined, true);
    } else showRoomScreen();
  };

  if (!app.identity.isRegistered) {
    renderOnboarding(mount, (name) => {
      app.identity.setDisplayName(name);
      void launch();
    });
  } else {
    await launch();
  }
}

void boot();
