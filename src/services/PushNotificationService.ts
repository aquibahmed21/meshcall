import { Emitter } from '../core/emitter';
import { createLogger, errorMessage } from '../core/logger';
import { storage } from '../core/storage';
import type { AppConfig } from '../config';
import { uint8ArrayToUrlBase64, urlBase64ToUint8Array } from '../push/base64url';
import type { ChatMessagePush, IncomingCallPush, TargetedPushPayload } from '../push/payloads';
import { PushNotSubscribedError, PushUnsupportedError, WebPushServerBackend, type PushBackend } from '../push/PushBackend';
import { PwaService } from './PwaService';

const log = createLogger('Push');
const PREF_KEY = 'voip.push.wanted';
const LAST_REG_KEY = 'voip.push.lastRegistration';

/**
 * UI-facing state.
 *   enabled     → browser subscription exists AND the push server knows it
 *   disabled    → supported, not subscribed (user can enable)
 *   connecting  → talking to the push server / browser push service
 *   denied      → notifications blocked in browser settings (never re-prompted)
 *   unavailable → push server unreachable / VAPID unavailable (retryable)
 *   unsupported / insecure / install-required / not-configured → cannot be used here
 */
export type PushStatus =
  | 'unsupported'
  | 'insecure'
  | 'install-required'
  | 'not-configured'
  | 'disabled'
  | 'connecting'
  | 'enabled'
  | 'denied'
  | 'unavailable'
  | 'error';

export const PUSH_STATUS_LABEL: Record<PushStatus, string> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  connecting: 'Connecting…',
  denied: 'Blocked by browser',
  unavailable: 'Unavailable (push server not reachable)',
  unsupported: 'Unavailable (not supported by this browser)',
  insecure: 'Unavailable (requires HTTPS)',
  'install-required': 'Unavailable until installed to the Home Screen',
  'not-configured': 'Unavailable (no push server configured)',
  error: 'Error – see log',
};

/**
 * 'accepted'    – the push server accepted the request (NOT a delivery confirmation)
 * 'unsupported' – the backend cannot target a single device → nothing was sent
 * 'failed'      – the request failed
 */
/**
 *  accepted       – the push server accepted it for the recipient's device(s) (not proof of delivery)
 *  not-subscribed – the recipient never enabled notifications, so there is nothing to push to
 *  unsupported    – the backend cannot target one device
 *  failed         – network/server error
 */
export type NotifyResult = 'accepted' | 'not-subscribed' | 'unsupported' | 'failed';

export interface PushDiagnostics {
  browserSupport: boolean;
  permission: NotificationPermission | 'unsupported';
  serviceWorker: string;
  status: PushStatus;
  subscription: 'active' | 'none';
  serverVerified: boolean | null;
  endpoint: string | null;
  pushServer: string;
  targetedDelivery: boolean;
  lastRegistration: number | null;
  lastError: string | null;
}

/**
 * Web Push integration with the EXISTING push backend (see PushBackend.ts for its contract).
 *
 *   initialize → (SW ready) getSubscription → verify with /isPushSubscribed → re-register if needed
 *   subscribe  → (user gesture) permission → GET /vapid → pushManager.subscribe → POST /subscribe
 *   unsubscribe → POST /unsubscribe {endpoint} → subscription.unsubscribe()
 *
 * The browser (pushManager.getSubscription) is the source of truth; localStorage only remembers
 * that the user WANTED push, so an expired/rotated subscription is silently recreated.
 *
 * Incoming calls: `notifyIncomingCall` requires targeted delivery. The current backend only
 * offers /notifyAll, so it returns 'unsupported' – a call is NEVER broadcast to all subscribers.
 * Background-tab notifications do not need the backend (NotificationService + Service Worker).
 *
 * Nothing here can affect WebRTC/ScaleDrone: every method catches its own errors.
 */
export class PushNotificationService {
  readonly events = new Emitter<{ status: PushStatus }>();
  private readonly backend: PushBackend | null;
  private registration: ServiceWorkerRegistration | null = null;
  private _status: PushStatus = 'unsupported';
  private vapidKey: string | null;
  private readonly configuredKey: boolean;
  private serverVerified: boolean | null = null;
  private lastError: string | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;

  constructor(
    config: AppConfig,
    /** This device's MeshCall id – lets the server deliver pushes to this device only. */
    private readonly deviceId?: string,
  ) {
    this.backend = config.push.serverUrl ? new WebPushServerBackend(config.push.serverUrl) : null;
    this.vapidKey = config.push.vapidPublicKey || null;
    this.configuredKey = !!config.push.vapidPublicKey;
  }

  get status(): PushStatus {
    return this._status;
  }

  /** Whether THIS device can be reached by a targeted push (backend targeting + our subscription). */
  get canTarget(): boolean {
    return !!this.backend?.capabilities.targetedDelivery && this._status === 'enabled';
  }

  get serverUrl(): string {
    return this.backend?.url ?? '';
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async initialize(registration: ServiceWorkerRegistration | null): Promise<void> {
    this.registration = registration;
    const blocked = this.environmentStatus();
    if (blocked) return this.setStatus(blocked);
    if (Notification.permission === 'denied') return this.setStatus('denied');
    await this.refreshSubscription();
  }

  /**
   * Startup / pushsubscriptionchange / "back online":
   *   subscription exists → make sure the server has it (register again if not)
   *   no subscription but the user wanted push and permission is granted → recreate it
   */
  refreshSubscription(): Promise<void> {
    return this.exclusive(async () => {
      if (this.environmentStatus() || !this.registration || !this.backend) return;
      if (Notification.permission === 'denied') return this.setStatus('denied');
      let sub = await this.getSubscription();
      if (!sub && storage.get(PREF_KEY, false) && Notification.permission === 'granted') {
        log.info('Push subscription missing/expired – recreating it');
        sub = await this.createSubscription().catch((err) => this.fail(err, 'unavailable'));
        if (!sub) return;
      }
      if (!sub) return this.setStatus('disabled');
      this.setStatus('connecting');
      try {
        // A subscription created for a different VAPID key (server rotated keys) can't receive.
        if (!(await this.keyMatches(sub))) {
          log.info('Push server VAPID key changed – re-subscribing');
          await sub.unsubscribe().catch(() => undefined);
          sub = await this.createSubscription();
        }
        // Idempotent: re-registers a subscription the server lost and (re)attaches this device's
        // id, so subscriptions created before targeted delivery existed become reachable too.
        const result = await this.backend.register(sub.toJSON(), this.deviceId);
        this.serverVerified = true;
        if (result === 'created') {
          this.markRegistered();
          log.info('Push subscription re-registered with the server');
        }
        storage.set(PREF_KEY, true);
        this.lastError = null;
        this.retryAttempt = 0;
        this.setStatus('enabled');
      } catch (err) {
        this.fail(err, 'unavailable');
        this.scheduleRetry();
      }
    });
  }

  /** Transient backend failures (cold start, network blip) during an automatic refresh. */
  private scheduleRetry(): void {
    const delays = [5_000, 20_000, 60_000];
    if (this.retryTimer || this.retryAttempt >= delays.length) return;
    const delay = delays[this.retryAttempt++]!;
    log.info(`Retrying push registration in ${delay / 1000} s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.refreshSubscription();
    }, delay);
  }

  // ── API ───────────────────────────────────────────────────────────────────

  getPermissionState(): NotificationPermission | 'unsupported' {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  }

  /** Only ever call from a user gesture. Never re-prompts once denied. */
  async requestPermission(): Promise<boolean> {
    if (typeof Notification === 'undefined') return false;
    if (Notification.permission !== 'default') return Notification.permission === 'granted';
    try {
      return (await Notification.requestPermission()) === 'granted';
    } catch (err) {
      log.warn('Notification permission request failed', errorMessage(err));
      return false;
    }
  }

  async getSubscription(): Promise<PushSubscription | null> {
    try {
      return (await this.registration?.pushManager.getSubscription()) ?? null;
    } catch {
      return null;
    }
  }

  /** "Enable notifications" button: permission → subscription → server registration. */
  subscribe(): Promise<PushSubscription | null> {
    return this.exclusive(async () => {
      const blocked = this.environmentStatus();
      if (blocked || !this.registration || !this.backend) {
        this.setStatus(blocked ?? 'unsupported');
        return null;
      }
      const granted = await this.requestPermission();
      if (!granted) {
        this.setStatus(Notification.permission === 'denied' ? 'denied' : 'disabled');
        return null;
      }
      this.setStatus('connecting');
      try {
        let sub = await this.getSubscription();
        if (sub && !(await this.keyMatches(sub))) {
          await sub.unsubscribe().catch(() => undefined);
          sub = null;
        }
        sub ??= await this.createSubscription();
        const result = await this.backend.register(sub.toJSON(), this.deviceId);
        this.serverVerified = true;
        this.markRegistered();
        storage.set(PREF_KEY, true);
        this.lastError = null;
        log.info(`Push enabled (${result === 'created' ? 'new subscription' : 'already registered'})`);
        this.setStatus('enabled');
        return sub;
      } catch (err) {
        this.fail(err, 'unavailable');
        return null;
      }
    });
  }

  /** "Turn off": tell the server first, then drop the browser subscription. */
  unsubscribe(): Promise<boolean> {
    return this.exclusive(async () => {
      storage.set(PREF_KEY, false);
      const sub = await this.getSubscription();
      if (!sub) {
        this.setStatus(this.environmentStatus() ?? 'disabled');
        return true;
      }
      let serverOk = true;
      try {
        await this.backend?.unregister(sub.endpoint); // 404 = already gone → fine
      } catch (err) {
        serverOk = false; // still remove locally; the server prunes dead endpoints (404/410) itself
        this.lastError = errorMessage(err);
        log.warn('Push server unsubscribe failed – removing the browser subscription anyway', this.lastError);
      }
      try {
        await sub.unsubscribe();
      } catch (err) {
        log.warn('Browser unsubscribe failed', errorMessage(err));
        return false;
      }
      this.serverVerified = false;
      log.info('Push disabled');
      this.setStatus('disabled');
      return serverOk;
    });
  }

  /** Browser subscription exists AND the server confirms it. */
  async isSubscribed(): Promise<boolean> {
    const sub = await this.getSubscription();
    if (!sub || !this.backend) return false;
    try {
      this.serverVerified = await this.backend.isRegistered(sub.endpoint);
      return this.serverVerified;
    } catch (err) {
      this.lastError = errorMessage(err);
      return false;
    }
  }

  /**
   * Send a notification to ONE user/device. This is the only path for calls and private messages;
   * it never falls back to /notifyAll.
   */
  async sendToUser(targetDeviceId: string, notification: { title: string; body: string; data: TargetedPushPayload }): Promise<NotifyResult> {
    if (!this.backend?.capabilities.targetedDelivery) return 'unsupported';
    try {
      await this.backend.notifyDevice(targetDeviceId, notification);
      return 'accepted';
    } catch (err) {
      if (err instanceof PushUnsupportedError) return 'unsupported';
      if (err instanceof PushNotSubscribedError) return 'not-subscribed';
      log.warn('Targeted push failed', errorMessage(err));
      return 'failed';
    }
  }

  notifyIncomingCall(targetDeviceId: string, payload: IncomingCallPush): Promise<NotifyResult> {
    const what =
      payload.callType === 'live'
        ? `invites you to watch ${payload.title ? `“${payload.title}”` : 'a live stream'}`
        : payload.callType === 'group'
          ? 'invites you to a group call'
          : `is calling you (${payload.callType})`;
    return this.sendToUser(targetDeviceId, { title: `${payload.callerName} ${what}`, body: `Room: ${payload.roomName}`, data: payload });
  }

  notifyChatMessage(targetDeviceId: string, payload: ChatMessagePush): Promise<NotifyResult> {
    return this.sendToUser(targetDeviceId, { title: `New message from ${payload.senderName}`, body: payload.text.slice(0, 200), data: payload });
  }

  /** Whether push can deliver to a SPECIFIC user at all (backend capability + our own setup). */
  get canSendToUsers(): boolean {
    return !!this.backend?.capabilities.targetedDelivery;
  }

  /** DEVELOPMENT ONLY: POST /notifyAll – reaches EVERY subscriber of the push server. */
  async broadcastTest(): Promise<string> {
    if (!import.meta.env.DEV) throw new Error('Broadcast test is only available in development builds');
    if (!this.backend) return 'No push server configured';
    const r = await this.backend.notifyAll('MeshCall Test', 'Push notifications are working.');
    return `Sent to ${r.successes} subscriber(s), ${r.failures} failed`;
  }

  async diagnostics(): Promise<PushDiagnostics> {
    const sub = await this.getSubscription();
    const sw = this.registration?.active?.state ?? (this.registration ? 'registered' : 'none');
    return {
      browserSupport: 'PushManager' in window && 'serviceWorker' in navigator && typeof Notification !== 'undefined',
      permission: this.getPermissionState(),
      serviceWorker: sw,
      status: this._status,
      subscription: sub ? 'active' : 'none',
      serverVerified: sub ? this.serverVerified : null,
      endpoint: sub ? redactEndpoint(sub.endpoint) : null,
      pushServer: this.backend?.url ?? '(none)',
      targetedDelivery: !!this.backend?.capabilities.targetedDelivery,
      lastRegistration: storage.get<number | null>(LAST_REG_KEY, null),
      lastError: this.lastError,
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private environmentStatus(): PushStatus | null {
    if (!window.isSecureContext) return 'insecure';
    if (!('PushManager' in window) && PwaService.isIos() && !PwaService.isStandalone()) return 'install-required';
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return 'unsupported';
    if (!this.registration) return 'unsupported';
    if (!this.backend) return 'not-configured';
    return null;
  }

  private async getVapidKey(): Promise<string> {
    if (this.vapidKey) return this.vapidKey;
    const key = await this.backend!.getVapidPublicKey();
    // Must be an uncompressed P-256 public key (65 bytes, 0x04 prefix) – never cache garbage.
    let bytes: Uint8Array;
    try {
      bytes = urlBase64ToUint8Array(key);
    } catch {
      throw new Error('Push server returned an invalid VAPID public key');
    }
    if (bytes.length !== 65 || bytes[0] !== 0x04) throw new Error('Push server returned an invalid VAPID public key');
    this.vapidKey = key;
    return key;
  }

  private async createSubscription(): Promise<PushSubscription> {
    const key = await this.getVapidKey();
    return this.registration!.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) });
  }

  private async keyMatches(sub: PushSubscription): Promise<boolean> {
    const current = sub.options?.applicationServerKey;
    if (!current) return true; // browser doesn't expose it – assume fine
    try {
      return uint8ArrayToUrlBase64(current) === (await this.getVapidKey()).replace(/=+$/, '');
    } catch {
      return true; // can't verify while the server is unreachable – keep the subscription
    }
  }

  private markRegistered(): void {
    storage.set(LAST_REG_KEY, Date.now());
  }

  private fail(err: unknown, status: PushStatus): null {
    if (!this.configuredKey) this.vapidKey = null; // re-fetch next time (server may have rotated keys)
    this.lastError = errorMessage(err);
    log.warn(`Push: ${this.lastError}`);
    this.setStatus(status);
    return null;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  private setStatus(s: PushStatus): void {
    if (this._status === s) return;
    this._status = s;
    this.events.emit('status', s);
  }
}

/** Show where a subscription points without exposing the full capability URL. */
export function redactEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    const tail = u.pathname.slice(-8);
    return `${u.origin}/…${tail}`;
  } catch {
    return '(invalid endpoint)';
  }
}
