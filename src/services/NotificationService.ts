import { Emitter } from '../core/emitter';
import { createLogger, errorMessage } from '../core/logger';
import type { CallKind, MediaKind } from '../types/signaling';

const log = createLogger('Notify');

export interface NotificationActionEvent {
  action: 'answer' | 'dismiss' | 'open';
  callId?: string;
}

/**
 * System notifications while the app is open but backgrounded, plus the bridge that receives
 * notification clicks from the Service Worker (postMessage). Uses
 * ServiceWorkerRegistration.showNotification because `new Notification()` throws on Android.
 */
export class NotificationService {
  readonly events = new Emitter<{ action: NotificationActionEvent }>();
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
      const d = e.data as { type?: string; action?: NotificationActionEvent['action']; callId?: string } | undefined;
      if (d?.type === 'notification-action' && d.action) {
        log.info(`Notification action "${d.action}"`);
        this.events.emit('action', { action: d.action, callId: d.callId });
      }
    });
  }

  async requestPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (!NotificationService.supported()) return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    try {
      return await Notification.requestPermission();
    } catch (err) {
      log.warn('Notification permission request failed', errorMessage(err));
      return Notification.permission;
    }
  }

  async showIncomingCall(info: { callId: string; callerName: string; media: MediaKind; callKind: CallKind; groupName?: string }): Promise<void> {
    if (this.permission !== 'granted' || document.visibilityState === 'visible') return;
    const title = info.callKind === 'group' ? `Group ${info.media} call` : `Incoming ${info.media === 'video' ? 'Video' : 'Audio'} Call`;
    const body = info.callKind === 'group' ? `${info.callerName} invites you${info.groupName ? ` to “${info.groupName}”` : ''}` : `${info.callerName} is calling you`;
    await this.show(title, {
      body,
      tag: `call-${info.callId}`,
      requireInteraction: true,
      data: { type: 'call', callId: info.callId },
      actions: [
        { action: 'answer', title: 'Answer' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
    } as NotificationOptions);
  }

  async showMissedCall(callId: string, callerName: string): Promise<void> {
    await this.close(`call-${callId}`);
    if (this.permission !== 'granted' || document.visibilityState === 'visible') return;
    await this.show('Missed call', { body: `You missed a call from ${callerName}`, tag: `missed-${callId}` });
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
      const opts = { icon: '/icon.svg', badge: '/icon.svg', ...options };
      if (this.registration) await this.registration.showNotification(title, opts);
      else new Notification(title, opts);
    } catch (err) {
      log.warn('Showing notification failed', errorMessage(err));
    }
  }
}
