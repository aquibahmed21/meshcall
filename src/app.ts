import { GroupCallManager } from './calls/GroupCallManager';
import { CallManager } from './calls/CallManager';
import { isTerminal } from './calls/CallStateMachine';
import { LiveStreamManager } from './calls/LiveStreamManager';
import { CONFIG, type AppConfig } from './config';
import { DeviceManager } from './media/DeviceManager';
import { MediaManager } from './media/MediaManager';
import { ChatService } from './services/ChatService';
import { RoomService, type RoomContext } from './services/RoomService';
import { IdentityService } from './services/IdentityService';
import { NetworkMonitor } from './services/NetworkMonitor';
import { NotificationService } from './services/NotificationService';
import { PresenceService } from './services/PresenceService';
import { PushNotificationService, registerServiceWorker } from './services/PushNotificationService';
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
  const push = new PushNotificationService(config, identity);
  const calls = new CallManager({ identity, signaling, presence, media, settings, webrtc, network, notifications, push, config });
  const groups = new GroupCallManager(calls, identity);
  const live = new LiveStreamManager(calls, signaling, identity, presence, config);
  const chat = new ChatService(signaling, identity);
  const rooms = new RoomService();
  return { config, identity, settings, signaling, presence, network, media, devices, webrtc, notifications, push, calls, groups, live, chat, rooms };
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
  app.push.events.on('status', (s) => app.presence.setPushEnabled(s === 'subscribed'));
  const registration = await registerServiceWorker();
  app.notifications.attach(registration);
  void app.push.init(registration);
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
  app.rooms.set(room);
  try {
    await withTimeout(joined, JOIN_TIMEOUT_MS, 'room join');
    log.info(`Joined room "${room.roomName}"`);
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
  app.chat.unbind();
  app.presence.stop();
  app.media.release();
  app.signaling.setRoom(null);
  app.rooms.set(null);
}
