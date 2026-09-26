import { Emitter } from '../core/emitter';
import { createLogger, errorMessage } from '../core/logger';
import { isCallLaunchContext, type CallLaunchContext } from '../push/payloads';
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
  readonly events = new Emitter<{ click: CallLaunchContext; pushCall: CallLaunchContext }>();
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
      if (!d || !isCallLaunchContext(d.context)) return;
      if (d.type === 'notification-click') {
        log.info(`Call notification clicked (${d.context.action})`);
        this.events.emit('click', d.context);
      } else if (d.type === 'push-call') {
        this.events.emit('pushCall', d.context);
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
