import { Emitter } from '../core/emitter';
import { createLogger, errorMessage } from '../core/logger';
import { isLaunchContext, type LaunchContext } from '../push/payloads';
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
  readonly events = new Emitter<{ click: LaunchContext; pushCall: LaunchContext; pushChat: LaunchContext }>();
  private registration: ServiceWorkerRegistration | null = null;

  static supported(): boolean {
    return typeof Notification !== 'undefined';
  }

  get permission(): NotificationPermission | 'unsupported' {
    return NotificationService.supported() ? Notification.permission : 'unsupported';
  }

  attach(registration: ServiceWorkerRegistration | null): void {
    this.registration = registration;
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
    if (this.permission !== 'granted' || (document.visibilityState === 'visible' && document.hasFocus())) return;
    const callType = info.callKind === 'group' ? 'group' : info.media;
    const where = info.roomName ? ` in ${info.roomName}` : '';
    const title = callType === 'group' ? 'Group Call Invitation' : callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';
    const body = callType === 'group' ? `${info.callerName} invites you${info.groupName ? ` to “${info.groupName}”` : ''}${where}` : `${info.callerName} is calling you${where}`;
    await this.show(title, {
      body,
      tag: `call-${info.callId}`,
      requireInteraction: true,
      data: { kind: 'incoming-call', callId: info.callId, roomId: info.roomId, roomName: info.roomName, callerId: info.callerId, callerName: info.callerName, callType },
      // The app is running, so it can decline over signaling. "Open" never auto-accepts.
      actions: [
        { action: 'open', title: 'Open MeshCall' },
        { action: 'decline', title: 'Decline' },
      ],
    } as NotificationOptions);
  }

  async showMissedCall(callId: string, callerName: string): Promise<void> {
    await this.close(`call-${callId}`);
    if (this.permission !== 'granted' || document.visibilityState === 'visible') return;
    await this.show('Missed call', { body: `You missed a call from ${callerName}`, tag: `missed-${callId}` });
  }

  /** New direct message while the tab is hidden/unfocused (local – no push server needed). */
  async showDirectMessage(info: { messageId: string; senderId: string; senderName: string; text: string; roomId: string; roomName: string }): Promise<void> {
    if (this.permission !== 'granted' || (document.visibilityState === 'visible' && document.hasFocus())) return;
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
    await this.show('MeshCall notifications work', { body: 'Incoming calls will look like this while MeshCall is in the background.', tag: 'test' });
  }

  async close(tag: string): Promise<void> {
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
