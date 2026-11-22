import { Emitter } from '../core/emitter';
import { createLogger, errorMessage } from '../core/logger';
import { isLaunchContext, type LaunchContext } from '../push/payloads';
import { isNative, native } from '../native/native';
import type { CallKind, MediaKind } from '../types/signaling';

const log = createLogger('Notify');


/**
 * System notifications while the app is open but backgrounded, plus the bridge that receives
 * notification clicks from the Service Worker (postMessage). Uses
 * ServiceWorkerRegistration.showNotification because `new Notification()` throws on Android.
 */
export class NotificationService {
  /**
   * `click`: a call notification was clicked (from the Service Worker, or the launch context left
   * by it when it had to open the app). `pushCall`: a call push arrived while the app was visible.
   */
  readonly events = new Emitter<{ missed: { callerId: string; callerName: string; media: string }; click: LaunchContext; pushCall: LaunchContext; pushChat: LaunchContext }>();
  private registration: ServiceWorkerRegistration | null = null;

  static supported(): boolean {
    return isNative || typeof Notification !== 'undefined';
  }

  get permission(): NotificationPermission | 'unsupported' {
    if (isNative) return native.notificationPermission;
    return NotificationService.supported() ? Notification.permission : 'unsupported';
  }

  /** The app is on screen and focused → the in-app UI handles it, no system notification. */
  private get onScreen(): boolean {
    return isNative ? native.foreground : document.visibilityState === 'visible' && document.hasFocus();
  }

  attach(registration: ServiceWorkerRegistration | null): void {
    this.registration = registration;
    if (isNative) {
      native.events.on('action', ({ action, context }) => {
        if (!context) return;
        log.info(`${context.kind} notification ${action}`);
        this.events.emit('click', context.kind === 'incoming-call' ? { ...context, action: action === 'reply' ? 'open' : action } : context);
      });
      native.actionsReady();
      return;
    }
    navigator.serviceWorker?.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { type?: string; context?: unknown } | undefined;
      if (!d || !isLaunchContext(d.context)) return;
      if (d.type === 'notification-click') {
        log.info(`${d.context.kind} notification clicked (${d.context.action})`);
        this.events.emit('click', d.context);
      } else if (d.type === 'push-call') {
        this.events.emit('pushCall', d.context);
      } else if (d.type === 'push-chat') {
        this.events.emit('pushChat', d.context);
      }
    });
  }

  /**
   * App open but hidden/unfocused (tab in background): local notification through the Service
   * Worker – no push server involved. Not shown while the page is visible (the in-app dialog
   * handles it → no duplicate).
   */
  async showIncomingCall(info: {
    callId: string;
    callerId: string;
    callerName: string;
    media: MediaKind;
    callKind: CallKind;
    groupName?: string;
    roomId?: string;
    roomName?: string;
  }): Promise<void> {
    if (this.permission !== 'granted' || this.onScreen) return;
    const callType = info.callKind === 'group' || info.callKind === 'live' ? info.callKind : info.media;
    const where = info.roomName ? ` in ${info.roomName}` : '';
    const title = callType === 'live' ? 'Live Stream Invitation' : callType === 'group' ? 'Group Call Invitation' : callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';
    const body =
      callType === 'live'
        ? `${info.callerName} invites you to watch${info.groupName ? ` “${info.groupName}”` : ' a live stream'}${where}`
        : callType === 'group'
          ? `${info.callerName} invites you${info.groupName ? ` to “${info.groupName}”` : ''}${where}`
          : `${info.callerName} is calling you${where}`;
    if (isNative) {
      const data = { kind: 'incoming-call', callId: info.callId, roomId: info.roomId, roomName: info.roomName, callerId: info.callerId, callerName: info.callerName, callType, at: Date.now() };
      return native.show({ tag: `call-${info.callId}`, title, body, kind: callType === 'live' ? 'live' : 'call', data: { ...data, action: 'open' }, timeoutMs: 60_000 });
    }
    await this.show(title, {
      body,
      tag: `call-${info.callId}`,
      requireInteraction: true,
      data: { kind: 'incoming-call', callId: info.callId, roomId: info.roomId, roomName: info.roomName, callerId: info.callerId, callerName: info.callerName, callType },
      // The app is running, so it can decline over signaling. "Open" never auto-accepts.
      actions:
        callType === 'live'
          ? [{ action: 'open', title: 'Open MeshCall' }]
          : [
              { action: 'open', title: 'Open MeshCall' },
              { action: 'decline', title: 'Decline' },
            ],
    } as NotificationOptions);
  }

  async showMissedCall(callId: string, callerName: string, info?: { callerId: string; media: string; roomId?: string; roomName?: string }): Promise<void> {
    await this.close(`call-${callId}`);
    // Always visible somewhere: in-app toast when the app is on screen or notifications are off.
    if (info && (this.permission !== 'granted' || this.onScreen)) this.events.emit('missed', { callerId: info.callerId, callerName, media: info.media });
    if (this.permission !== 'granted') return;
    // Android: always post it – the activity can be "on screen" only because the call lit up the
    // lock screen, and a missed call must still be waiting in the notification shade afterwards.
    if (this.onScreen && !isNative) return;
    if (isNative) {
      // "Call back" action: opens the app and rings them again (never auto-joins another room silently).
      return native.show({
        tag: `missed-${callId}`,
        title: 'Missed call',
        body: callerName,
        kind: 'missed',
        data: info ? { kind: 'incoming-call', action: 'callback', missed: true, callId, callerId: info.callerId, callerName, callType: info.media, roomId: info.roomId, roomName: info.roomName, at: Date.now() } : {},
      });
    }
    await this.show('Missed call', { body: `You missed a call from ${callerName}`, tag: `missed-${callId}` });
  }

  /** New direct message while the tab is hidden/unfocused (local – no push server needed). */
  async showDirectMessage(info: { messageId: string; senderId: string; senderName: string; text: string; roomId: string; roomName: string }): Promise<void> {
    if (this.permission !== 'granted' || this.onScreen) return;
    if (isNative) {
      return native.show({ tag: `dm-${info.senderId}`, title: `New message from ${info.senderName}`, body: info.text.slice(0, 200), kind: 'message', data: { kind: 'chat-message', action: 'open', senderId: info.senderId, senderName: info.senderName, messageId: info.messageId, roomId: info.roomId, roomName: info.roomName, at: Date.now() } });
    }
    await this.show(`New message from ${info.senderName}`, {
      body: info.text.slice(0, 200),
      tag: `dm-${info.senderId}`,
      renotify: true,
      data: { kind: 'chat-message', senderId: info.senderId, senderName: info.senderName, messageId: info.messageId, roomId: info.roomId, roomName: info.roomName },
    } as NotificationOptions);
  }

  /** Settings → "Send a test notification" (verifies permission + Service Worker display). */
  async showTest(): Promise<void> {
    if (this.permission !== 'granted') return;
    if (isNative) return native.show({ tag: 'test', title: 'MeshCall notifications work', body: 'Incoming calls will look like this while MeshCall is in the background.', kind: 'message', data: {} });
    await this.show('MeshCall notifications work', { body: 'Incoming calls will look like this while MeshCall is in the background.', tag: 'test' });
  }

  async close(tag: string): Promise<void> {
    if (isNative) return native.cancel(tag);
    try {
      const list = (await this.registration?.getNotifications({ tag })) ?? [];
      list.forEach((n) => n.close());
    } catch {
      /* ignore */
    }
  }

  private async show(title: string, options: NotificationOptions): Promise<void> {
    try {
      const base = import.meta.env.BASE_URL;
      const opts = { icon: `${base}icons/icon-192.png`, badge: `${base}icons/badge-96.png`, data: { kind: 'system' }, ...options };
      if (this.registration) await this.registration.showNotification(title, opts);
      else new Notification(title, opts);
    } catch (err) {
      log.warn('Showing notification failed', errorMessage(err));
    }
  }
}
