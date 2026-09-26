import { GroupCallManager } from './calls/GroupCallManager';
import { CallManager } from './calls/CallManager';
import { LiveStreamManager } from './calls/LiveStreamManager';
import { CONFIG, type AppConfig } from './config';
import { DeviceManager } from './media/DeviceManager';
import { MediaManager } from './media/MediaManager';
import { IdentityService } from './services/IdentityService';
import { NetworkMonitor } from './services/NetworkMonitor';
import { NotificationService } from './services/NotificationService';
import { PresenceService } from './services/PresenceService';
import { PushNotificationService, registerServiceWorker } from './services/PushNotificationService';
import { SettingsService } from './services/SettingsService';
import { SignalingService } from './services/SignalingService';
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
}

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
  const live = new LiveStreamManager(calls, signaling, identity, config);
  return { config, identity, settings, signaling, presence, network, media, devices, webrtc, notifications, push, calls, groups, live };
}

/** Start services once the user has a display name. */
export async function startApp(app: AppContext): Promise<void> {
  app.network.start();
  app.presence.start();
  app.calls.init();
  app.live.start();
  app.push.events.on('status', (s) => app.presence.setPushEnabled(s === 'subscribed'));
  const registration = await registerServiceWorker();
  app.notifications.attach(registration);
  void app.push.init(registration);
  void app.devices.start();
  await app.signaling.start();
}
