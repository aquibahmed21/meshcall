/*
 * MeshCall Service Worker
 *
 *  1. App shell / offline – precaches the exact files of this build (list injected at build time)
 *     so the installed app opens instantly and even offline (it then shows "signaling unavailable"
 *     until the network is back – calls obviously need the network).
 *  2. Updates – every build has a new BUILD_ID, so the browser installs the new worker in the
 *     background. It WAITS (never interrupts a running call) until the page asks it to take over
 *     ("A new version is available → Reload").
 *  3. Push – incoming-call notifications while the app is closed/backgrounded.
 *     A Service Worker cannot hold a WebRTC call: it only shows the notification; the call is
 *     negotiated by the page after the user opens/focuses the app.
 *
 * In `vite dev` the placeholders are not replaced → pass-through mode (no caching, HMR intact).
 */
const BUILD_ID = '__BUILD_ID__';
const PRECACHE = /*__PRECACHE__*/ [];
const DEV = BUILD_ID === '__BUILD_' + 'ID__';
const CACHE = `meshcall-${BUILD_ID}`;
const RUNTIME = 'meshcall-runtime';

// Resolve app URLs against the SW scope so the app also works from a sub-path (GitHub Pages).
const appUrl = (path) => new URL(path, self.registration.scope).href;
const ICON = appUrl('icons/icon-192.png');
const BADGE = appUrl('icons/badge-96.png');

// ── lifecycle ───────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (!DEV) {
        const cache = await caches.open(CACHE);
        await cache.addAll(PRECACHE.map(appUrl));
      }
      // First install: take control immediately. Updates wait for the page's go-ahead.
      if (!self.registration.active || DEV) await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('meshcall-') && key !== CACHE && key !== RUNTIME) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'skip-waiting') self.skipWaiting();
  if (data.type === 'get-version' && event.source) event.source.postMessage({ type: 'version', buildId: BUILD_ID });
});

// ── fetch: network-first pages, cache-first hashed assets ────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (DEV || req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return; // CDN, signaling, push relay…

  if (req.mode === 'navigate') {
    event.respondWith(networkFirstPage(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

async function networkFirstPage(req) {
  try {
    const res = await fetchWithTimeout(req, 4000);
    if (res.ok) (await caches.open(CACHE)).put(appUrl('index.html'), res.clone());
    return res;
  } catch {
    const cached = (await caches.match(appUrl('index.html'), { ignoreVary: true })) || (await caches.match(appUrl('./'), { ignoreVary: true }));
    return cached || offlinePage();
  }
}

async function cacheFirst(req) {
  // ignoreVary: module scripts are CORS requests (Origin header) and servers send `Vary: Origin` /
  // `Vary: Accept-Encoding`; precached files are content-hashed, so the variant never matters.
  const cached = await caches.match(req, { ignoreVary: true });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') (await caches.open(RUNTIME)).put(req, res.clone());
    return res;
  } catch {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

function fetchWithTimeout(req, ms) {
  return Promise.race([fetch(req), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

function offlinePage() {
  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>MeshCall – offline</title>
     <body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0f1419;color:#e8eef4;font-family:system-ui;text-align:center">
     <div><div style="font-size:3rem;color:#3b9eff">◉</div><h1>You're offline</h1><p>MeshCall needs a network connection for calls.</p>
     <button onclick="location.reload()" style="font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#3b9eff;color:#fff">Try again</button></div>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

// ── push ────────────────────────────────────────────────────────────────────
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
    return self.registration.showNotification(data.title || 'MeshCall', { body: data.body || '', icon: ICON, badge: BADGE });
  }
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const visible = windows.filter((c) => c.visibilityState === 'visible');
  if (visible.length) {
    // The app is on screen: it rings in-page if it is in the caller's room. Tell it anyway, so
    // an app that is open in ANOTHER room (or on the room screen) can offer to switch.
    visible.forEach((c) => c.postMessage({ type: 'push-call', data }));
    return;
  }

  const expired = typeof data.expiresAt === 'number' && Date.now() > data.expiresAt + 60000;
  if (expired) {
    return self.registration.showNotification('Missed call', {
      body: `You missed a call from ${data.callerName || 'someone'}${data.roomName ? ` · ${data.roomName}` : ''}`,
      tag: `missed-${data.callId}`,
      icon: ICON,
      badge: BADGE,
    });
  }
  const video = data.media === 'video';
  const title = data.callKind === 'group' ? 'Group call invitation' : `Incoming ${video ? 'Video' : 'Audio'} Call`;
  const who = data.callKind === 'group' ? `${data.callerName} invites you to a group call` : `${data.callerName} is calling you`;
  return self.registration.showNotification(title, {
    body: data.roomName ? `${who}\nRoom: ${data.roomName}` : who,
    tag: `call-${data.callId}`,
    renotify: true,
    requireInteraction: true,
    icon: ICON,
    badge: BADGE,
    vibrate: [400, 200, 400, 200, 400],
    timestamp: Date.now(),
    data: { type: 'call', callId: data.callId, roomName: data.roomName },
    actions: [
      { action: 'answer', title: 'Answer' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  });
}

// Browser rotated/expired the subscription → tell open pages so they re-register it.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => ws.forEach((c) => c.postMessage({ type: 'push-subscription-change' }))),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action || 'open';
  const callId = (event.notification.data && event.notification.data.callId) || undefined;
  const roomName = (event.notification.data && event.notification.data.roomName) || undefined;
  event.waitUntil(onClick(action, callId, roomName));
});

async function onClick(action, callId, roomName) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const message = { type: 'notification-action', action, callId, roomName };
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
  const url = new URL(appUrl('./'));
  // The app always asks for the room first; the room name is only used to prefill that screen.
  if (roomName) url.searchParams.set('room', roomName);
  if (action === 'answer' && callId) {
    url.searchParams.set('action', 'answer');
    url.searchParams.set('callId', callId);
  }
  await self.clients.openWindow(url.href);
}
