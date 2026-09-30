import { withTimeout } from '../core/async';
import type { TargetedPushPayload } from './payloads';

/**
 * Adapter for the push server's HTTP API. MeshCall talks to the backend ONLY through this
 * interface, so adding targeted delivery later means a new adapter – not changes in calls/UI.
 */
export interface PushBackend {
  readonly url: string;
  readonly capabilities: {
    /** Can deliver a notification to ONE specific device (required for incoming calls). */
    targetedDelivery: boolean;
    /** Has a broadcast-to-all endpoint (only ever used for a developer test). */
    broadcast: boolean;
  };
  getVapidPublicKey(): Promise<string>;
  /** Register the browser-generated subscription (sent exactly as PushSubscription.toJSON()). */
  register(subscription: PushSubscriptionJSON): Promise<'created' | 'exists'>;
  unregister(endpoint: string): Promise<'removed' | 'not-found'>;
  isRegistered(endpoint: string): Promise<boolean>;
  /**
   * Targeted delivery to ONE device (calls, private messages). Resolves when the backend ACCEPTED
   * the request – that is not proof of delivery. Throws PushUnsupportedError if unsupported.
   */
  notifyDevice(targetDeviceId: string, notification: { title: string; body: string; data: TargetedPushPayload }): Promise<void>;
  /** Broadcast to EVERY subscriber – never used for calls; development test only. */
  notifyAll(title: string, body: string): Promise<{ successes: number; failures: number }>;
}

export class PushBackendError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PushBackendError';
  }
}

export class PushUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushUnsupportedError';
  }
}

const TIMEOUT_MS = 15_000; // Render free instances cold-start slowly

/**
 * The existing backend (https://web-push-3zaz.onrender.com):
 *   GET  /vapid              → { publicKey }
 *   POST /subscribe          ← PushSubscription JSON            → 201 created | 200 already
 *   POST /unsubscribe        ← { endpoint }                     → 200 | 404
 *   POST /isPushSubscribed   ← { endpoint }                     → { isSubscribed }
 *   POST /notifyAll          ← { title, body, initiator? }      → broadcast to ALL subscribers
 *
 * It stores subscriptions without any user/device association and has no targeted send, so
 * `targetedDelivery` is false: incoming calls are NOT pushed (never broadcast a call).
 */
export class WebPushServerBackend implements PushBackend {
  readonly capabilities = { targetedDelivery: false, broadcast: true } as const;

  constructor(readonly url: string) {}

  async getVapidPublicKey(): Promise<string> {
    const body = await this.request<{ publicKey?: string }>('GET', '/vapid');
    if (!body.publicKey || typeof body.publicKey !== 'string') throw new PushBackendError('VAPID key missing in /vapid response');
    return body.publicKey;
  }

  async register(subscription: PushSubscriptionJSON): Promise<'created' | 'exists'> {
    const { status } = await this.requestRaw('POST', '/subscribe', subscription);
    return status === 201 ? 'created' : 'exists';
  }

  async unregister(endpoint: string): Promise<'removed' | 'not-found'> {
    const { status } = await this.requestRaw('POST', '/unsubscribe', { endpoint }, [404]);
    return status === 404 ? 'not-found' : 'removed';
  }

  async isRegistered(endpoint: string): Promise<boolean> {
    const body = await this.request<{ isSubscribed?: boolean }>('POST', '/isPushSubscribed', { endpoint });
    return body.isSubscribed === true;
  }

  async notifyDevice(): Promise<void> {
    throw new PushUnsupportedError('The push server has no per-device endpoint (only /notifyAll) – targeted call notifications are unavailable');
  }

  async notifyAll(title: string, body: string): Promise<{ successes: number; failures: number }> {
    const res = await this.request<{ successes?: number; failures?: number }>('POST', '/notifyAll', { title, body });
    return { successes: res.successes ?? 0, failures: res.failures ?? 0 };
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const { json } = await this.requestRaw(method, path, body);
    return json as T;
  }

  private async requestRaw(method: 'GET' | 'POST', path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await withTimeout(
        fetch(`${this.url}${path}`, {
          method,
          headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'omit',
        }),
        TIMEOUT_MS,
        `push server ${path}`,
      );
    } catch (err) {
      // Network failure, timeout or a CORS rejection (the browser hides which one).
      throw new PushBackendError(`Push server unreachable (${path}): ${(err as Error).message}`);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* empty/non-JSON body */
    }
    if (!res.ok && !okStatuses.includes(res.status)) {
      const msg = (json as { error?: string } | null)?.error ?? res.statusText;
      throw new PushBackendError(`Push server ${path} → ${res.status} ${msg}`, res.status);
    }
    return { status: res.status, json };
  }
}
