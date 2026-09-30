import { afterEach, describe, expect, it, vi } from 'vitest';
import { uint8ArrayToUrlBase64, urlBase64ToUint8Array } from '../../src/push/base64url';
import { isCallLaunchContext, isIncomingCallPush } from '../../src/push/payloads';
import { PushBackendError, WebPushServerBackend } from '../../src/push/PushBackend';

const URL = 'https://push.example';
const KEY = 'BC_wKpFJExx0VHEtHsO6Eu2kYBONetj7erkZ2AH1yheGsGpMhZJcxy1uJcHOVTQ8oYTEYwSgaGDlY0c6tc96f2Y';

function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = handler(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('base64url', () => {
  it('decodes a real 65-byte uncompressed P-256 VAPID key', () => {
    const bytes = urlBase64ToUint8Array(KEY);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04); // uncompressed EC point
  });
  it('round-trips and tolerates padding', () => {
    expect(uint8ArrayToUrlBase64(urlBase64ToUint8Array(KEY))).toBe(KEY);
    expect([...urlBase64ToUint8Array('AQID')]).toEqual([1, 2, 3]);
    expect([...urlBase64ToUint8Array('AQ==')]).toEqual([1]);
    expect([...urlBase64ToUint8Array('_-8')]).toEqual([0xff, 0xef]);
  });
  it('rejects invalid input', () => {
    expect(() => urlBase64ToUint8Array('not base64!')).toThrow();
  });
});

describe('payload guards', () => {
  it('accepts a well-formed incoming-call push and rejects others', () => {
    const ok = { type: 'incoming-call', callId: 'c', roomId: 'r', roomName: 'R', callerId: 'a', callerName: 'A', callType: 'video', timestamp: 1, expiresAt: 2 };
    expect(isIncomingCallPush(ok)).toBe(true);
    expect(isIncomingCallPush({ ...ok, callType: 'fax' })).toBe(false);
    expect(isIncomingCallPush({ title: 'x', body: 'y' })).toBe(false);
    expect(isIncomingCallPush(null)).toBe(false);
  });
  it('validates notification launch contexts', () => {
    expect(isCallLaunchContext({ kind: 'incoming-call', action: 'open', callId: 'c', at: 1 })).toBe(true);
    expect(isCallLaunchContext({ kind: 'incoming-call', action: 'accept', callId: 'c' })).toBe(false); // no auto-accept action exists
  });
});

describe('WebPushServerBackend – existing API contract', () => {
  it('GET /vapid → publicKey', async () => {
    const calls = mockFetch(() => ({ status: 200, body: { publicKey: KEY } }));
    expect(await new WebPushServerBackend(URL).getVapidPublicKey()).toBe(KEY);
    expect(calls[0]).toMatchObject({ url: `${URL}/vapid`, method: 'GET' });
  });

  it('503 "VAPID not ready" surfaces as a backend error', async () => {
    mockFetch(() => ({ status: 503, body: { error: 'VAPID not ready' } }));
    await expect(new WebPushServerBackend(URL).getVapidPublicKey()).rejects.toThrow(/503 VAPID not ready/);
  });

  it('POST /subscribe sends the browser subscription JSON unchanged (201 created / 200 exists)', async () => {
    const sub = { endpoint: 'https://fcm.example/x', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } };
    const calls = mockFetch(() => ({ status: calls.length === 1 ? 201 : 200, body: { message: "ok" } }));
    const b = new WebPushServerBackend(URL);
    expect(await b.register(sub)).toBe('created');
    expect(await b.register(sub)).toBe('exists');
    expect(calls[0]!.body).toEqual(sub);
  });

  it('POST /unsubscribe {endpoint}: 404 means already gone (not an error)', async () => {
    const calls = mockFetch(() => ({ status: 404, body: { error: 'Subscription not found' } }));
    expect(await new WebPushServerBackend(URL).unregister('https://fcm.example/x')).toBe('not-found');
    expect(calls[0]).toMatchObject({ url: `${URL}/unsubscribe`, method: 'POST', body: { endpoint: 'https://fcm.example/x' } });
  });

  it('POST /isPushSubscribed {endpoint}', async () => {
    const calls = mockFetch(() => ({ status: 200, body: { isSubscribed: true } }));
    expect(await new WebPushServerBackend(URL).isRegistered('e')).toBe(true);
    expect(calls[0]!.body).toEqual({ endpoint: 'e' });
  });

  it('network/CORS failure → PushBackendError (never throws something unexpected)', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(new WebPushServerBackend(URL).isRegistered('e')).rejects.toBeInstanceOf(PushBackendError);
  });

  it('targeted delivery: POST /notify for ONE device, never /notifyAll', async () => {
    const calls = mockFetch(() => ({ status: 200, body: { successes: 1, failures: 0 } }));
    const b = new WebPushServerBackend(URL);
    expect(b.capabilities.targetedDelivery).toBe(true);
    const data = { type: 'incoming-call', callId: 'c', roomId: 'r', roomName: 'R', callerId: 'a', callerName: 'A', callType: 'audio', timestamp: 1, expiresAt: 2 } as const;
    await b.notifyDevice('device-bob-1234', { title: 't', body: 'b', data });
    expect(calls).toEqual([{ url: `${URL}/notify`, method: 'POST', body: { targetDeviceId: 'device-bob-1234', title: 't', body: 'b', data, ttl: 60 } }]);
  });

  it('404 from /notify → PushNotSubscribedError (recipient never enabled push)', async () => {
    mockFetch(() => ({ status: 404, body: { error: 'No push subscription for this device' } }));
    const { PushNotSubscribedError } = await import('../../src/push/PushBackend');
    await expect(
      new WebPushServerBackend(URL).notifyDevice('device-x-12345', { title: 't', body: 'b', data: { type: 'chat-message', messageId: 'm', senderId: 's', senderName: 'S', text: 'hi', roomId: 'r', roomName: 'R', timestamp: 1 } }),
    ).rejects.toBeInstanceOf(PushNotSubscribedError);
  });

  it('a server without /notify (HTML 404) → PushUnsupportedError, not "not subscribed"', async () => {
    vi.stubGlobal('fetch', async () => new Response('<pre>Cannot POST /notify</pre>', { status: 404 }));
    const { PushUnsupportedError } = await import('../../src/push/PushBackend');
    await expect(
      new WebPushServerBackend(URL).notifyDevice('device-x-12345', { title: 't', body: 'b', data: { type: 'chat-message', messageId: 'm', senderId: 's', senderName: 'S', text: 'hi', roomId: 'r', roomName: 'R', timestamp: 1 } }),
    ).rejects.toBeInstanceOf(PushUnsupportedError);
  });

  it('register sends the subscription unchanged plus this deviceId', async () => {
    const calls = mockFetch(() => ({ status: 201, body: {} }));
    const sub = { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } };
    expect(await new WebPushServerBackend(URL).register(sub, 'device-me-12345')).toBe('created');
    expect(calls[0]!.body).toEqual({ ...sub, deviceId: 'device-me-12345' });
  });
});

describe('PushNotificationService', async () => {
  vi.stubGlobal('window', {});
  const { PushNotificationService, redactEndpoint } = await import('../../src/services/PushNotificationService');
  const { CONFIG } = await import('../../src/config');

  it('incoming-call push goes to /notify for that device only (caller needs no subscription)', async () => {
    const calls = mockFetch(() => ({ status: 200, body: { successes: 1, failures: 0 } }));
    const svc = new PushNotificationService({ ...CONFIG, push: { serverUrl: URL, vapidPublicKey: '' } }, 'device-me-12345');
    const r = await svc.notifyIncomingCall('device-bob-1234', {
      type: 'incoming-call', callId: 'c', roomId: 'r', roomName: 'R', callerId: 'a', callerName: 'A', callType: 'audio', timestamp: 1, expiresAt: 2,
    });
    expect(r).toBe('accepted');
    expect(svc.canSendToUsers).toBe(true);
    expect(svc.canTarget).toBe(false); // THIS device is not subscribed – irrelevant for sending
    expect(calls.map((c) => c.url)).toEqual([`${URL}/notify`]); // in particular: no /notifyAll
  });

  it('recipient without a subscription → "not-subscribed"', async () => {
    mockFetch(() => ({ status: 404, body: { error: 'No push subscription for this device' } }));
    const svc = new PushNotificationService({ ...CONFIG, push: { serverUrl: URL, vapidPublicKey: '' } });
    expect(await svc.notifyIncomingCall('device-bob-1234', { type: 'incoming-call', callId: 'c', roomId: 'r', roomName: 'R', callerId: 'a', callerName: 'A', callType: 'video', timestamp: 1, expiresAt: 2 })).toBe('not-subscribed');
  });

  it('defaults to the existing push server', () => {
    expect(CONFIG.push.serverUrl).toMatch(/^https:\/\//);
  });

  it('redacts endpoints for display', () => {
    expect(redactEndpoint('https://fcm.googleapis.com/fcm/send/abcdefghijklmnop:APA91bSECRETSECRET12345678')).toBe('https://fcm.googleapis.com/…12345678');
  });
});
