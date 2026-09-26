import './styles/main.css';
import { createApp, joinRoom, leaveRoom, startApp } from './app';
import { CONFIG } from './config';
import { createLogger, logHub } from './core/logger';
import { renderOnboarding } from './ui/views/Onboarding';
import { renderRoomScreen } from './ui/views/RoomScreen';
import { validateRoomName } from './services/RoomService';
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
  let answerAfterJoin: string | undefined;

  const showRoomScreen = (error?: string) => {
    document.title = 'MeshCall – Join a room';
    renderRoomScreen(mount, {
      userName: app.identity.displayName,
      prefill,
      error,
      recent: app.rooms.recent(),
      onJoin: async (room) => {
        await joinRoom(app, room);
        prefill = undefined;
        if (answerAfterJoin) app.calls.autoAnswer(answerAfterJoin); // user already pressed "Answer"
        answerAfterJoin = undefined;
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
   * A call notification/push for ANOTHER room than the one we are in (or while on the room
   * screen): rooms are isolated, so offer to switch – never switch silently.
   */
  const offerRoomSwitch = (roomName: string | undefined, callId: string | undefined, callerName: string | undefined, answer: boolean) => {
    if (!roomName) return;
    const v = validateRoomName(roomName);
    if (!v.ok) return;
    const current = app.rooms.current;
    if (current?.roomId === v.room.roomId) return; // same room → the normal in-app ringing handles it
    const who = callerName ?? 'Someone';
    const go = () => {
      if (current) leaveRoom(app);
      prefill = v.room.roomName;
      answerAfterJoin = answer ? callId : undefined;
      showRoomScreen(`${who} is calling you in “${v.room.roomName}”. Join the room to ${answer ? 'answer' : 'see the call'}.`);
    };
    if (!current || !ui) return go();
    ui.toast('info', `${who} is calling you in room “${v.room.roomName}”`, {
      label: 'Switch room',
      run: () => {
        if (app.calls.inCall && !confirm('Switching rooms ends your current call. Switch anyway?')) return;
        go();
      },
    });
  };
  app.pwa.events.on('message', (m) => {
    if (m.type !== 'push-call' || !m.data || typeof m.data !== 'object') return;
    const d = m.data as { roomName?: string; callId?: string; callerName?: string };
    offerRoomSwitch(d.roomName, d.callId, d.callerName, false);
  });
  app.notifications.events.on('action', (a) => {
    if (a.action !== 'dismiss') offerRoomSwitch(a.roomName, a.callId, undefined, a.action === 'answer');
  });

  const launch = async () => {
    await startApp(app);
    log.info(`Started as ${app.identity.displayName} (${app.identity.deviceId.slice(0, 8)})`);
    showRoomScreen();
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
