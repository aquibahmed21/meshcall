import './styles/main.css';
import { createApp, joinRoom, leaveRoom, startApp } from './app';
import { CONFIG } from './config';
import { createLogger, logHub } from './core/logger';
import { renderOnboarding } from './ui/views/Onboarding';
import { renderRoomScreen } from './ui/views/RoomScreen';
import { validateRoomName } from './services/RoomService';
import type { CallLaunchContext } from './push/payloads';
import { UIManager } from './ui/UIManager';
import { collectDiagnostics } from './ui/views/DiagnosticsPanel';
import { probeIceServers } from './webrtc/IceServerProbe';
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
  };

  let ui: UIManager | null = null;
  // A notification click may carry the room of the call (?room=…) → prefill, never auto-join.
  const params = new URLSearchParams(location.search);
  let prefill = params.get('room') ?? undefined;
  /** Call we were told about by a notification but can only receive after joining its room. */
  let expectAfterJoin: CallLaunchContext | undefined;

  const showRoomScreen = (error?: string, info?: string) => {
    document.title = 'MeshCall – Join a room';
    renderRoomScreen(mount, {
      userName: app.identity.displayName,
      prefill,
      error,
      info,
      recent: app.rooms.recent(),
      onJoin: async (room) => {
        await joinRoom(app, room);
        prefill = undefined;
        if (expectAfterJoin) app.calls.expectCall(expectAfterJoin.callId, expectAfterJoin.callerName);
        expectAfterJoin = undefined;
        document.title = `${room.roomName} – MeshCall`;
        if (!ui) {
          ui = new UIManager(app, mount, {
            onLeaveRoom: () => {
              leaveRoom(app);
              showRoomScreen();
            },
          });
        } else {
          ui.attach(mount);
        }
      },
    });
  };

  /**
   * A call notification was clicked (or a call push arrived while the app was visible).
   * Recover the call WITHOUT auto-accepting it:
   *   same room          → the call rings (or will ring when the caller re-sends the invite)
   *   other room / none  → rooms are isolated: offer to switch (never silently), prefill the
   *                        room screen, and expect the call after joining
   */
  const handleCallContext = (ctx: CallLaunchContext) => {
    if (ctx.action === 'decline') return app.calls.declineFromNotification(ctx.callId);
    const target = ctx.roomName ? validateRoomName(ctx.roomName) : null;
    const current = app.rooms.current;
    if (current && (!target?.ok || target.room.roomId === current.roomId)) {
      app.calls.expectCall(ctx.callId, ctx.callerName);
      return;
    }
    if (!target?.ok) return;
    const who = ctx.callerName ?? 'Someone';
    const go = () => {
      if (current) leaveRoom(app);
      prefill = target.room.roomName;
      expectAfterJoin = ctx;
      showRoomScreen(undefined, `${who} is calling you in “${target.room.roomName}”. Join the room to answer.`);
    };
    if (!current || !ui) return go();
    ui.toast('info', `${who} is calling you in room “${target.room.roomName}”`, {
      label: 'Switch room',
      run: () => {
        if (app.calls.inCall && !confirm('Switching rooms ends your current call. Switch anyway?')) return;
        go();
      },
    });
  };
  app.notifications.events.on('click', (ctx) => handleCallContext(ctx));
  app.notifications.events.on('pushCall', (ctx) => handleCallContext(ctx));

  const launch = async () => {
    await startApp(app);
    const launchCtx = await app.pwa.consumeLaunchContext();
    log.info(`Started as ${app.identity.displayName} (${app.identity.deviceId.slice(0, 8)})`);
    if (launchCtx) handleCallContext(launchCtx);
    else showRoomScreen();
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
