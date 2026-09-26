import { withTimeout } from '../core/async';
import { Emitter } from '../core/emitter';
import { createLogger, errorMessage } from '../core/logger';
import type { AppConfig } from '../config';
import type { InvitePayload } from '../types/signaling';
import type { IdentityService } from './IdentityService';
import { PwaService } from './PwaService';

const log = createLogger('Push');

export type PushStatus =
  | 'unsupported'
  | 'insecure'
  /** iOS/iPadOS: Web Push only exists inside the Home Screen app. */
  | 'install-required'
  | 'not-configured'
  | 'available'
  | 'denied'
  | 'subscribed'
  | 'error';

export interface CallPushPayload extends InvitePayload {
  type: 'call-invite';
  callId: string;
  callerId: string;
  callerName: string;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Web Push for incoming calls while the app is closed.
 *
 * Browsers cannot send Web Push directly (the VAPID private key must stay secret and push
 * services do not allow CORS), so a tiny relay server is required: server/push-server.mjs.
 *   callee: SW registration → pushManager.subscribe(VAPID) → POST /subscribe {deviceId, sub}
 *   caller: POST /notify {toDeviceId, payload} → relay → push service → callee's Service Worker
 *
 * A Service Worker can only show a notification; it can NOT hold a WebRTC call. The call is
 * negotiated after the user opens/focuses the app from the notification.
 */
export class PushNotificationService {
  readonly events = new Emitter<{ status: PushStatus }>();
  private _status: PushStatus = 'unsupported';
  private registration: ServiceWorkerRegistration | null = null;
  private vapidKey: string;

  constructor(
    private readonly config: AppConfig,
    private readonly identity: IdentityService,
  ) {
    this.vapidKey = config.push.vapidPublicKey;
  }

  get status(): PushStatus {
    return this._status;
  }

  get canSend(): boolean {
    return !!this.config.push.serverUrl;
  }

  async init(registration: ServiceWorkerRegistration | null): Promise<void> {
    this.registration = registration;
    if (!window.isSecureContext) return this.setStatus('insecure');
    if (!('PushManager' in window) && PwaService.isIos() && !PwaService.isStandalone()) return this.setStatus('install-required');
    if (!registration || !('PushManager' in window)) return this.setStatus('unsupported');
    if (!this.config.push.serverUrl) return this.setStatus('not-configured');
    if (Notification.permission === 'denied') return this.setStatus('denied');
    try {
      const existing = await registration.pushManager.getSubscription();
      if (existing && Notification.permission === 'granted') {
        await this.register(existing); // refresh deviceId ↔ subscription mapping
        return this.setStatus('subscribed');
      }
    } catch (err) {
      log.warn('Could not restore push subscription', errorMessage(err));
    }
    this.setStatus('available');
  }

  /** Must be called from a user gesture (permission prompt). */
  async enable(): Promise<boolean> {
    if (!this.registration || !this.config.push.serverUrl) return false;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        this.setStatus(perm === 'denied' ? 'denied' : 'available');
        return false;
      }
      const key = await this.getVapidKey();
      const sub =
        (await this.registration.pushManager.getSubscription()) ??
        (await this.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
      await this.register(sub);
      this.setStatus('subscribed');
      log.info('Push notifications enabled');
      return true;
    } catch (err) {
      log.error('Enabling push failed', errorMessage(err));
      this.setStatus('error');
      return false;
    }
  }

  /** Browser rotated/expired the subscription (pushsubscriptionchange) → subscribe again. */
  async resubscribe(): Promise<void> {
    if (this._status !== 'subscribed' || !this.registration) return;
    try {
      const key = await this.getVapidKey();
      const sub =
        (await this.registration.pushManager.getSubscription()) ??
        (await this.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
      await this.register(sub);
      log.info('Push subscription renewed');
    } catch (err) {
      log.warn('Renewing push subscription failed', errorMessage(err));
      this.setStatus('error');
    }
  }

  /** Turn off offline call notifications (browser + relay). */
  async disable(): Promise<void> {
    try {
      const sub = await this.registration?.pushManager.getSubscription();
      await sub?.unsubscribe();
      if (this.config.push.serverUrl) {
        await withTimeout(
          fetch(`${this.config.push.serverUrl}/unsubscribe`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ deviceId: this.identity.deviceId }),
          }),
          6_000,
          'push unsubscribe',
        );
      }
      log.info('Push notifications disabled');
    } catch (err) {
      log.warn('Disabling push failed', errorMessage(err));
    }
    this.setStatus('available');
  }

  /** Ask the relay to wake the callee. Resolves false when the callee has no subscription. */
  async notifyCall(toDeviceId: string, payload: CallPushPayload): Promise<boolean> {
    if (!this.config.push.serverUrl) return false;
    try {
      const res = await withTimeout(
        fetch(`${this.config.push.serverUrl}/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ toDeviceId, payload }),
        }),
        6_000,
        'push notify',
      );
      if (res.ok) log.info('Push sent to offline callee');
      else log.info(`Push not delivered (${res.status})`);
      return res.ok;
    } catch (err) {
      log.warn('Push relay unreachable', errorMessage(err));
      return false;
    }
  }

  private async getVapidKey(): Promise<string> {
    if (this.vapidKey) return this.vapidKey;
    const res = await withTimeout(fetch(`${this.config.push.serverUrl}/vapid-public-key`), 6_000, 'vapid key');
    if (!res.ok) throw new Error(`VAPID key request failed (${res.status})`);
    this.vapidKey = ((await res.json()) as { publicKey: string }).publicKey;
    return this.vapidKey;
  }

  private async register(sub: PushSubscription): Promise<void> {
    const res = await withTimeout(
      fetch(`${this.config.push.serverUrl}/subscribe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: this.identity.deviceId, name: this.identity.displayName, subscription: sub.toJSON() }),
      }),
      6_000,
      'push subscribe',
    );
    if (!res.ok) throw new Error(`Subscribe failed (${res.status})`);
  }

  private setStatus(s: PushStatus): void {
    this._status = s;
    this.events.emit('status', s);
  }
}
