/*
 * Service Worker – incoming-call notifications.
 *
 * What it CAN do: receive a Web Push while the app is closed/backgrounded, show an
 * "Incoming call" notification with Answer / Dismiss, and open or focus the app.
 * What it CANNOT do: run WebRTC. Service Workers have no RTCPeerConnection and are killed
 * when idle, so the call itself is negotiated by the page after the user opens it:
 *   push → notification → click → app opens/focuses → signaling → WebRTC negotiation → call
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'MeshCall', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(handlePush(data));
});

async function handlePush(data) {
  if (data.type !== 'call-invite') {
    return self.registration.showNotification(data.title || 'MeshCall', { body: data.body || '', icon: '/icon.svg' });
  }
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // A visible app already receives the invite over signaling and rings in-page.
  if (windows.some((c) => c.visibilityState === 'visible')) return;

  const expired = typeof data.expiresAt === 'number' && Date.now() > data.expiresAt + 60000;
  if (expired) {
    return self.registration.showNotification('Missed call', {
      body: `You missed a call from ${data.callerName || 'someone'}`,
      tag: `missed-${data.callId}`,
      icon: '/icon.svg',
    });
  }
  const video = data.media === 'video';
  const title = data.callKind === 'group' ? 'Group call invitation' : `Incoming ${video ? 'Video' : 'Audio'} Call`;
  const body = data.callKind === 'group' ? `${data.callerName} invites you to a group call` : `${data.callerName} is calling you`;
  return self.registration.showNotification(title, {
    body,
    tag: `call-${data.callId}`,
    renotify: true,
    requireInteraction: true,
    icon: '/icon.svg',
    badge: '/icon.svg',
    vibrate: [400, 200, 400, 200, 400],
    data: { type: 'call', callId: data.callId },
    actions: [
      { action: 'answer', title: 'Answer' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action || 'open';
  const callId = (event.notification.data && event.notification.data.callId) || undefined;
  event.waitUntil(onClick(action, callId));
});

async function onClick(action, callId) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const message = { type: 'notification-action', action, callId };
  if (action === 'dismiss') {
    windows.forEach((c) => c.postMessage(message));
    return;
  }
  if (windows.length) {
    const target = windows.find((c) => c.focused) || windows[0];
    try {
      await target.focus();
    } catch {
      /* focus can fail without user activation */
    }
    target.postMessage(message);
    return;
  }
  const url = new URL('/', self.location.origin);
  if (action === 'answer' && callId) {
    url.searchParams.set('action', 'answer');
    url.searchParams.set('callId', callId);
  }
  await self.clients.openWindow(url.href);
}
