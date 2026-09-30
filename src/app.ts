import { GroupCallManager } from './calls/GroupCallManager';
import { CallManager } from './calls/CallManager';
import { isTerminal } from './calls/CallStateMachine';
import { LiveStreamManager } from './calls/LiveStreamManager';
import { CONFIG, type AppConfig } from './config';
import { DeviceManager } from './media/DeviceManager';
import { MediaManager } from './media/MediaManager';
import { ChatService } from './services/ChatService';
import { DirectMessageService } from './services/DirectMessageService';
import { RoomService, type RoomContext } from './services/RoomService';
import { IdentityService } from './services/IdentityService';
import { NetworkMonitor } from './services/NetworkMonitor';
import { NotificationService } from './services/NotificationService';
import { PresenceService } from './services/PresenceService';
import { PushNotificationService } from './services/PushNotificationService';
import { PwaService } from './services/PwaService';
import { SettingsService } from './services/SettingsService';
import { SignalingService } from './services/SignalingService';
import { withTimeout } from './core/async';
import { createLogger } from './core/logger';
import { WebRTCManager } from './webrtc/WebRTCManager';

/** Composition root – every service is created once here and injected explicitly. */
export interface AppContext {
  config: AppConfig;
  identity: IdentityService;
  settings: SettingsService;
  signaling: SignalingService;
  presence: PresenceService;
  network: NetworkMonitor;
  media: MediaManager;
  devices: DeviceManager;
  webrtc: WebRTCManager;
  notifications: NotificationService;
  push: PushNotificationService;
  calls: CallManager;
  groups: GroupCallManager;
  live: LiveStreamManager;
  chat: ChatService;
  rooms: RoomService;
  pwa: PwaService;
  dms: DirectMessageService;
}

const log = createLogger('Room');
const JOIN_TIMEOUT_MS = 15_000;

export function createApp(): AppContext {
  const config = CONFIG;
  const identity = new IdentityService();
  const settings = new SettingsService();
  const signaling = new SignalingService(identity, config);
  const presence = new PresenceService(signaling, identity, config);
  const network = new NetworkMonitor();
  const media = new MediaManager(settings);
  const devices = new DeviceManager(settings, media);
  const webrtc = new WebRTCManager(config, settings);
  const notifications = new NotificationService();
  const push = new PushNotificationService(config);
  const calls = new CallManager({ identity, signaling, presence, media, settings, webrtc, network, notifications, push, config });
  const groups = new GroupCallManager(calls, identity);
  const live = new LiveStreamManager(calls, signaling, identity, presence, config, push);
  const chat = new ChatService(signaling, identity);
  const rooms = new RoomService();
  const pwa = new PwaService();
  pwa.listenForInstall(); // as early as possible – beforeinstallprompt can fire right after load
  const dms = new DirectMessageService(signaling, identity, presence, push);
  return { dms, pwa, config, identity, settings, signaling, presence, network, media, devices, webrtc, notifications, push, calls, groups, live, chat, rooms };
}

/**
 * Start room-independent services once the user has a display name: network monitor, chat
 * wiring, Service Worker/push, devices and the ScaleDrone connection. Nothing room-specific.
 */
export async function startApp(app: AppContext): Promise<void> {
  app.network.start();
  app.chat.start();
  // Chat is scoped to the call's mesh room: live while the call is connecting/connected/
  // reconnecting (a WebRTC outage does NOT clear it), cleared once the call has ended.
  app.calls.events.on('state', (s) => {
    if (s && (s.status === 'connecting' || s.status === 'connected' || s.status === 'reconnecting')) app.chat.bind(s.callId);
    else if (!s || isTerminal(s.status)) app.chat.unbind();
  });
  // Advertise "reachable while closed" only if the backend can deliver to THIS device.
  app.push.events.on('status', () => app.presence.setPushEnabled(app.push.canTarget));
  const registration = await app.pwa.register();
  app.notifications.attach(registration);
  void app.push.initialize(registration);
  app.pwa.events.on('message', (m) => {
    if (m.type === 'push-subscription-change') void app.push.refreshSubscription();
  });
  window.addEventListener('online', () => void app.push.refreshSubscription());
  // Installing on iOS unlocks Web Push – re-evaluate when that happens.
  app.pwa.events.on('install', (s) => s === 'installed' && void app.push.initialize(app.pwa.registration));
  void app.devices.start();
  void app.signaling.start();
}

export class RoomJoinError extends Error {}

/**
 * Room lifecycle – join:
 *   scope signaling to the room → room presence (observable lobby) → room inbox (calls)
 *   → live-stream discovery → wait for the member list (= joined) with a timeout.
 * On failure everything is rolled back so no stale subscription survives.
 */
export async function joinRoom(app: AppContext, room: RoomContext): Promise<void> {
  if (app.rooms.current) leaveRoom(app);
  log.info(`Joining room "${room.roomName}"`);
  app.signaling.setRoom(room);
  const joined = app.presence.start(room);
  app.calls.start();
  app.live.start();
  app.dms.start(room);
  app.rooms.set(room);
  try {
    await withTimeout(joined, JOIN_TIMEOUT_MS, 'room join');
    log.info(`Joined room "${room.roomName}"`);
    app.rooms.saveActive(room); // reopened automatically on the next launch
  } catch {
    const sig = app.signaling.status;
    leaveRoom(app);
    throw new RoomJoinError(
      sig === 'unavailable' ? 'ScaleDrone signaling is unavailable – check your connection and try again' : 'Unable to join the room – signaling did not respond in time',
    );
  }
}

/**
 * Room lifecycle – leave: end call/stream (closes peer connections, stops media, leaves the mesh
 * room), stop live discovery, leave presence, drop the room scope. Order matters: the call ends
 * while signaling is still scoped so the hang-up/leave messages reach the room.
 */
export function leaveRoom(app: AppContext): void {
  const room = app.rooms.current;
  if (!room) return;
  log.info(`Leaving room "${room.roomName}"`);
  app.calls.stop();
  app.live.stop();
  app.dms.stop();
  app.chat.unbind();
  app.presence.stop();
  app.media.release();
  app.signaling.setRoom(null);
  app.rooms.set(null);
}
