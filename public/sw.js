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
/*
 * Payload shapes (parsed defensively – a malformed push must never break the worker, and with
 * userVisibleOnly every push must still show SOMETHING):
 *   { type: 'incoming-call', callId, roomId, roomName, callerId, callerName, callType, expiresAt }
 *   { title, body } | { notification: { title, body } }   (e.g. the push server's /notifyAll)
 *   plain text
 */
const LAUNCH_CACHE = 'launch-context-v1'; // not "meshcall-" prefixed → survives release clean-up
const LAUNCH_KEY = () => appUrl('__launch-context');

self.addEventListener('push', (event) => {
  event.waitUntil(
    handlePush(parsePush(event)).catch(() =>
      self.registration.showNotification('MeshCall', { body: 'You have a new notification.', icon: ICON, badge: BADGE }),
    ),
  );
});

function parsePush(event) {
  if (!event.data) return { kind: 'system' };
  let json = null;
  try {
    json = event.data.json();
  } catch {
    const text = safeText(event);
    return { kind: 'system', body: text.slice(0, 300) };
  }
  if (json && typeof json === 'object') {
    if (json.type === 'incoming-call' && typeof json.callId === 'string' && typeof json.callerName === 'string') {
      return { kind: 'incoming-call', ...json };
    }
    // Targeted-push envelope { title, body, data: { type: … } } → unwrap typed data
    const typed = json.data && typeof json.data === 'object' ? json.data : null;
    if (typed && typed.type === 'incoming-call' && typeof typed.callId === 'string') return { kind: 'incoming-call', ...typed };
    const chat = json.type === 'chat-message' ? json : typed && typed.type === 'chat-message' ? typed : null;
    if (chat && typeof chat.senderId === 'string' && typeof chat.senderName === 'string') {
      return { kind: 'chat-message', ...chat, text: typeof chat.text === 'string' ? chat.text.slice(0, 200) : '' };
    }
    const n = json.notification && typeof json.notification === 'object' ? json.notification : json;
    return {
      kind: 'system',
      title: typeof n.title === 'string' ? n.title.slice(0, 120) : undefined,
      body: typeof n.body === 'string' ? n.body.slice(0, 300) : undefined,
    };
  }
  return { kind: 'system', body: String(json).slice(0, 300) };
}

function safeText(event) {
  try {
    return event.data.text();
  } catch {
    return '';
  }
}

async function handlePush(p) {
  if (p.kind === 'chat-message') return handleChatPush(p);
  if (p.kind !== 'incoming-call') {
    return self.registration.showNotification(p.title || 'MeshCall', { body: p.body || '', icon: ICON, badge: BADGE, data: { kind: 'system' } });
  }
  const windows = await appWindows();
  const visible = windows.filter((c) => c.visibilityState === 'visible');
  if (visible.length) {
    // The app is on screen and rings in-page (no duplicate system notification). An app that is
    // open in ANOTHER room gets the context so it can offer to switch.
    visible.forEach((c) => c.postMessage({ type: 'push-call', context: toContext(p, 'open') }));
    return;
  }
  const where = p.roomName ? ` in ${p.roomName}` : '';
  if (typeof p.expiresAt === 'number' && Date.now() > p.expiresAt + 60000) {
    return self.registration.showNotification('Missed call', {
      body: `You missed a call from ${p.callerName}${where}`,
      tag: `missed-${p.callId}`,
      icon: ICON,
      badge: BADGE,
      data: { kind: 'system' },
    });
  }
  const title = p.callType === 'live' ? 'Live Stream Invitation' : p.callType === 'group' ? 'Group Call Invitation' : p.callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';
  const body =
    p.callType === 'live'
      ? `${p.callerName} invites you to watch${p.title ? ` “${p.title}”` : ' a live stream'}${where}`
      : p.callType === 'group'
        ? `${p.callerName} invites you to a group call${where}`
        : `${p.callerName} is calling you${where}`;
  const options = {
    body,
    tag: `call-${p.callId}`,
    renotify: true,
    requireInteraction: true,
    silent: false,
    icon: ICON,
    badge: BADGE,
    vibrate: RING_VIBRATION,
    timestamp: Date.now(),
    data: { kind: 'incoming-call', callId: p.callId, roomId: p.roomId, roomName: p.roomName, callerId: p.callerId, callerName: p.callerName, callType: p.callType },
    // The app is closed: "Open" is the only meaningful action (declining needs the app).
    actions: [{ action: 'open', title: 'Open MeshCall' }],
  };
  await self.registration.showNotification(title, options);
  return ringUntilHandled(p, title, options, where);
}

/*
 * "Ringing" for a closed app. A Service Worker cannot play audio and browsers ignore custom
 * notification sounds, so the call notification is re-shown (renotify) every few seconds: each
 * time the device plays its notification sound and vibrates again – like a ringtone – until the
 * user opens/dismisses it, the app comes to the foreground (it then rings in-page), or the call
 * expires (→ "Missed call"). Runs inside the push event's waitUntil (well below the browser limit).
 */
const RING_INTERVAL_MS = 4000;
const MAX_RING_MS = 45000;
const RING_VIBRATION = [600, 300, 600, 300, 600];

async function ringUntilHandled(p, title, options, where) {
  const tag = options.tag;
  const expires = typeof p.expiresAt === 'number' ? p.expiresAt : Date.now() + MAX_RING_MS;
  const until = Math.min(expires, Date.now() + MAX_RING_MS);
  const ringing = async () => (await self.registration.getNotifications({ tag })).length > 0;
  while (Date.now() + RING_INTERVAL_MS < until) {
    await new Promise((r) => setTimeout(r, RING_INTERVAL_MS));
    if (!(await ringing())) return; // opened or dismissed → stop ringing
    if ((await appWindows()).some((c) => c.visibilityState === 'visible')) return; // the app rings in-page now
    await self.registration.showNotification(title, { ...options, timestamp: Date.now() });
  }
  if (!(await ringing())) return;
  // Rang out without anyone touching it → missed call.
  (await self.registration.getNotifications({ tag })).forEach((n) => n.close());
  await self.registration.showNotification('Missed call', {
    body: `You missed a call from ${p.callerName}${where}`,
    tag: `missed-${p.callId}`,
    icon: ICON,
    badge: BADGE,
    data: { kind: 'system' },
  });
}

async function handleChatPush(p) {
  const context = { kind: 'chat-message', action: 'open', senderId: p.senderId, senderName: p.senderName, messageId: p.messageId, roomId: p.roomId, roomName: p.roomName, at: Date.now() };
  const visible = (await appWindows()).filter((c) => c.visibilityState === 'visible');
  if (visible.length) {
    visible.forEach((c) => c.postMessage({ type: 'push-chat', context })); // in-app UI shows it
    return;
  }
  return self.registration.showNotification(`New message from ${p.senderName}`, {
    body: p.text || '',
    tag: `dm-${p.senderId}`,
    renotify: true,
    icon: ICON,
    badge: BADGE,
    timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
    data: { kind: 'chat-message', senderId: p.senderId, senderName: p.senderName, messageId: p.messageId, roomId: p.roomId, roomName: p.roomName },
  });
}

function toContext(d, action) {
  if (d.kind === 'chat-message') {
    return { kind: 'chat-message', action: 'open', senderId: d.senderId, senderName: d.senderName, messageId: d.messageId, roomId: d.roomId, roomName: d.roomName, at: Date.now() };
  }
  return {
    kind: 'incoming-call',
    action,
    callId: d.callId,
    roomId: d.roomId,
    roomName: d.roomName,
    callerId: d.callerId,
    callerName: d.callerName,
    callType: d.callType,
    at: Date.now(),
  };
}

async function appWindows() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.filter((c) => c.url.startsWith(self.registration.scope));
}

// Browser rotated/expired the subscription → tell open pages so they register the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(appWindows().then((ws) => ws.forEach((c) => c.postMessage({ type: 'push-subscription-change' }))));
});

/*
 * Click: close → focus an existing MeshCall window and postMessage the call context, or open
 * MeshCall and leave the context in a short-lived Cache entry the app reads once on start-up.
 * No call data goes into the URL. The app shows the normal Accept/Reject UI – nothing is
 * auto-accepted.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action === 'decline' ? 'decline' : 'open';
  event.waitUntil(onClick(data, action).catch(() => self.clients.openWindow(appUrl('./'))));
});

async function onClick(data, action) {
  const windows = await appWindows();
  const context =
    data.kind === 'incoming-call' && typeof data.callId === 'string'
      ? toContext(data, action)
      : data.kind === 'chat-message' && typeof data.senderId === 'string'
        ? toContext(data, 'open')
        : null;
  if (windows.length) {
    const target = windows.find((c) => c.focused) || windows.find((c) => c.visibilityState === 'visible') || windows[0];
    if (action !== 'decline') {
      try {
        await target.focus();
      } catch {
        /* focus can be refused without user activation */
      }
    }
    if (context) target.postMessage({ type: 'notification-click', context });
    return;
  }
  if (!context || action === 'decline') {
    if (!context) await self.clients.openWindow(appUrl('./'));
    return; // app closed + "decline": the caller's invite simply times out
  }
  const cache = await caches.open(LAUNCH_CACHE);
  await cache.put(LAUNCH_KEY(), new Response(JSON.stringify(context), { headers: { 'content-type': 'application/json' } }));
  await self.clients.openWindow(appUrl('./'));
}

self.addEventListener('notificationclose', (event) => {
  const data = event.notification.data || {};
  if (data.kind !== 'incoming-call') return;
  // Dismissing is not declining: the call keeps ringing in the app until answered/rejected.
  event.waitUntil(appWindows().then((ws) => ws.forEach((c) => c.postMessage({ type: 'notification-closed', callId: data.callId }))));
});
