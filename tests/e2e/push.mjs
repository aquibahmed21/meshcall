/**
 * Web Push against the REAL push backend (https://web-push-3zaz.onrender.com).
 *
 * Runs from http://localhost:5173/meshcall/ – an origin the backend's CORS allows, served with the
 * GitHub Pages base path so the Service Worker scope (/meshcall/) is exercised:
 *     npx vite --base=/meshcall/ --port 5173
 *     npm run test:push
 *
 * It never calls /notifyAll (that would broadcast to every real subscriber). Push events are
 * injected into the Service Worker with the DevTools protocol, and every subscription created
 * here is removed from the server at the end.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const APP = process.env.E2E_URL || 'http://localhost:5173/meshcall/';
const ORIGIN = new URL(APP).origin;
const BACKEND = process.env.PUSH_SERVER || 'https://web-push-3zaz.onrender.com';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const RUN = Date.now().toString(36);
const ROOM = `Push ${RUN}`;
const OTHER = `Other ${RUN}`;
const results = [];
const created = new Set(); // endpoints to clean up
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const section = (t) => console.log(`\n── ${t}`);
const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const contexts = [];
async function profile(name, permissions = ['camera', 'microphone', 'notifications']) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), `meshcall-push-${name}-`)), {
    executablePath: CHROME,
    headless: process.env.HEADLESS !== '0',
    args,
    permissions,
  });
  contexts.push(ctx);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  page.on('pageerror', (e) => console.log(`   [${name} pageerror] ${e.message}`));
  return { ctx, page, name };
}
/** isPushSubscribed with a short retry window (shared, cold-starting server). */
const confirmed = async (endpoint, expected = true) => {
  for (let i = 0; i < 5; i++) {
    if ((await server('/isPushSubscribed', { endpoint })).isSubscribed === expected) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};
const server = async (path, body) => {
  const res = await fetch(`${BACKEND}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.json().catch(() => ({}));
};
async function onboard(page, name, room) {
  await page.goto(APP);
  await page.waitForSelector('#name', { timeout: 20_000 });
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  if (room) await enterRoom(page, room);
}
async function enterRoom(page, room) {
  await page.waitForSelector('#room-name', { timeout: 20_000 });
  if (room) await page.fill('#room-name', room);
  await page.click('.room-screen button[type=submit]');
  await page.waitForSelector('.room-chip strong', { timeout: 30_000 });
}
const status = (page) => page.evaluate(() => window.__voip.app.push.status);
const waitStatus = (page, s, timeout = 45_000) => page.waitForFunction((x) => window.__voip.app.push.status === x, s, { timeout }).then(() => true, () => false);
const endpointOf = (page) => page.evaluate(async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.endpoint ?? null);
async function swRegistrationId(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  const regs = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
  await cdp.send('ServiceWorker.enable');
  await page.waitForTimeout(400);
  const reg = regs.find((r) => r.scopeURL === APP && !r.isDeleted);
  return { cdp, id: reg?.registrationId };
}
const deliver = (cdp, registrationId, data) => cdp.send('ServiceWorker.deliverPushMessage', { origin: ORIGIN, registrationId, data: typeof data === 'string' ? data : JSON.stringify(data) });
async function notifications(ctx) {
  const sw = ctx.serviceWorkers().find((w) => w.url().startsWith(APP)) ?? (await ctx.waitForEvent('serviceworker', { timeout: 10_000 }));
  return sw.evaluate(async () => (await self.registration.getNotifications()).map((n) => ({ tag: n.tag, title: n.title, body: n.body, actions: (n.actions || []).map((a) => a.action) })));
}
/** Synthesise a notification click inside the SW (DevTools cannot click OS notifications). */
async function clickNotification(ctx, tag, action = '') {
  const sw = ctx.serviceWorkers().find((w) => w.url().startsWith(APP));
  return sw.evaluate(
    async ([t, a]) => {
      const n = (await self.registration.getNotifications({ tag: t }))[0];
      if (!n) return 'no-notification';
      self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n, action: a }));
      return 'clicked';
    },
    [tag, action],
  );
}
const callPush = (callId, roomName = ROOM, callType = 'video') => ({
  type: 'incoming-call',
  callId,
  roomId: roomName.toLowerCase().replace(/\s+/g, '-'),
  roomName,
  callerId: 'caller-device',
  callerName: 'Alice',
  callType,
  timestamp: Date.now(),
  expiresAt: Date.now() + 45_000,
});

try {
  const health = await fetch(`${BACKEND}/vapid`, { headers: { Origin: ORIGIN } });
  check('Push backend reachable, CORS allows this origin', health.ok && health.headers.get('access-control-allow-origin') === ORIGIN, `${health.status} ACAO=${health.headers.get('access-control-allow-origin')}`);

  // ═══════════════════════════ PERMISSION ═══════════════════════════════════
  section('Permission');
  const denier = await profile('denier', ['camera', 'microphone']);
  const setNotif = async (setting) => {
    const c = await denier.ctx.newCDPSession(denier.page);
    await c.send('Browser.setPermission', { permission: { name: 'notifications' }, setting, origin: ORIGIN });
  };
  await onboard(denier.page, 'Denier', null);
  await setNotif('prompt'); // true "default" state (headless otherwise reports denied)
  await denier.page.reload();
  await enterRoom(denier.page, ROOM);
  await denier.page.waitForFunction(() => window.__voip.app.push.status !== 'unsupported', null, { timeout: 15_000 }).catch(() => {});
  check(
    'Permission "default" → status "disabled", explicit "Enable Notifications" card (no automatic prompt)',
    (await denier.page.evaluate(() => Notification.permission)) === 'default' && (await status(denier.page)) === 'disabled' && !!(await denier.page.$('.enable-card button')),
    `${await denier.page.evaluate(() => Notification.permission)} / ${await status(denier.page)}`,
  );
  await denier.page.click('.enable-card button'); // prompt is dismissed/denied by headless Chrome
  await denier.page.waitForFunction(() => window.__voip.app.push.status !== 'connecting', null, { timeout: 10_000 });
  const afterPrompt = await status(denier.page);
  check('Prompt dismissed/denied → nothing subscribed, UI consistent', afterPrompt === 'disabled' || afterPrompt === 'denied', afterPrompt);
  await setNotif('denied');
  await denier.page.reload();
  await enterRoom(denier.page, ROOM);
  check('Denied → "Blocked by browser" + unblock instructions, no button to re-prompt', (await waitStatus(denier.page, 'denied', 10_000)) && !!(await denier.page.$('.enable-card.blocked')) && !(await denier.page.$('.enable-card button')));

  const bob = await profile('bob');
  await onboard(bob.page, 'Bob', ROOM);
  const scope = await bob.page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  check('Service Worker registered with the GitHub Pages scope', scope === APP, scope);
  check('Permission granted but not subscribed → "disabled"', (await waitStatus(bob.page, 'disabled', 15_000)));

  // ═══════════════════════════ SUBSCRIPTION ═════════════════════════════════
  section('Subscription (real backend)');
  await bob.page.click('.enable-card button');
  const enabled = await waitStatus(bob.page, 'enabled');
  let ep = await endpointOf(bob.page);
  if (ep) created.add(ep);
  check('New subscription: GET /vapid → subscribe → POST /subscribe', enabled && !!ep, await status(bob.page));
  check('Server confirms it (POST /isPushSubscribed)', await confirmed(ep), ep ? new URL(ep).origin : 'no endpoint');

  await bob.page.reload();
  await enterRoom(bob.page, ROOM);
  check('Existing subscription restored on startup (no prompt)', await waitStatus(bob.page, 'enabled'), `${await status(bob.page)} ${JSON.stringify((await bob.page.evaluate(() => window.__voip.app.push.diagnostics())).lastError)}`);
  check('Same endpoint reused – no duplicate subscription', (await endpointOf(bob.page)) === ep);

  await server('/unsubscribe', { endpoint: ep }); // server lost it (e.g. data reset)
  await bob.page.reload();
  await enterRoom(bob.page, ROOM);
  await waitStatus(bob.page, 'enabled');
  check('Subscription refresh: server no longer knew it → re-registered automatically', (await server('/isPushSubscribed', { endpoint: ep })).isSubscribed === true, `${await status(bob.page)} ${JSON.stringify((await bob.page.evaluate(() => window.__voip.app.push.diagnostics())).lastError)}`);

  await bob.page.evaluate(async () => (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe());
  await bob.page.reload();
  await enterRoom(bob.page, ROOM);
  await waitStatus(bob.page, 'enabled');
  const ep2 = await endpointOf(bob.page);
  if (ep2) created.add(ep2);
  check('Expired subscription (browser dropped it) → recreated and registered', !!ep2 && ep2 !== ep && (await server('/isPushSubscribed', { endpoint: ep2 })).isSubscribed === true);
  await server('/unsubscribe', { endpoint: ep }); // old endpoint: already invalid, keep the server clean
  ep = ep2;

  await bob.page.click('.topbar button[aria-label=Settings]');
  await bob.page.click('dialog button[role=switch]');
  await waitStatus(bob.page, 'disabled');
  check('Unsubscribe: POST /unsubscribe + subscription.unsubscribe()', (await endpointOf(bob.page)) === null && (await server('/isPushSubscribed', { endpoint: ep })).isSubscribed === false);
  await bob.page.click('dialog button[role=switch]');
  await waitStatus(bob.page, 'enabled');
  ep = await endpointOf(bob.page);
  created.add(ep);
  check('Resubscribe via the toggle', (await server('/isPushSubscribed', { endpoint: ep })).isSubscribed === true);
  check('Settings shows Incoming calls ON + Browser notifications Enabled', /Enabled/.test(await bob.page.textContent('dialog .notif-settings')));
  await bob.page.keyboard.press('Escape');

  // ═══════════════════════════ SERVICE WORKER PUSH ══════════════════════════
  section('Push events in the Service Worker');
  const { cdp, id: regId } = await swRegistrationId(bob.ctx, bob.page);
  await bob.page.goto('about:blank'); // app "closed": no MeshCall window in scope
  await deliver(cdp, regId, callPush('call-1'));
  await bob.page.waitForTimeout(800);
  let shown = await notifications(bob.ctx);
  const n1 = shown.find((n) => n.tag === 'call-call-1');
  check('incoming-call push → "Incoming Video Call · Alice is calling you in <room>"', !!n1 && n1.title === 'Incoming Video Call' && n1.body === `Alice is calling you in ${ROOM}`, n1 ? `${n1.title} | ${n1.body}` : JSON.stringify(shown));
  check('Notification offers "Open MeshCall" (no auto-accept action)', n1?.actions.join() === 'open');
  await deliver(cdp, regId, callPush('call-g', ROOM, 'group'));
  await bob.page.waitForTimeout(500);
  check('Group call push text', (await notifications(bob.ctx)).some((n) => n.title === 'Group Call Invitation'));
  await deliver(cdp, regId, '{not json');
  await deliver(cdp, regId, { title: 'Server says hi', body: 'notifyAll-style payload' });
  await deliver(cdp, regId, 'plain text push');
  await bob.page.waitForTimeout(800);
  shown = await notifications(bob.ctx);
  check('Malformed / notifyAll-style / text payloads never crash the worker', shown.some((n) => n.title === 'Server says hi') && shown.some((n) => n.body === 'plain text push'));
  await deliver(cdp, regId, callPush('call-2'));
  await bob.page.waitForTimeout(500);
  check('Worker still handles pushes after a malformed one', (await notifications(bob.ctx)).some((n) => n.tag === 'call-call-2'));

  // ═══════════════════════════ CLICK → RECOVERY ═════════════════════════════
  section('Notification click → call recovery (real call)');
  const alice = await profile('alice');
  await onboard(alice.page, 'Alice', ROOM);
  const aliceBackendCalls = [];
  alice.page.on('request', (r) => r.url().startsWith(BACKEND) && aliceBackendCalls.push(new URL(r.url()).pathname));
  // Bob's app is closed. Alice calls him; the push backend can't target, so nothing is pushed.
  const bobDevice = await (async () => {
    const p = await bob.ctx.newPage();
    await p.goto(APP);
    const id = await p.evaluate(() => JSON.parse(localStorage.getItem('voip.identity')).deviceId);
    await p.close();
    return id;
  })();
  await alice.page.waitForFunction((id) => window.__voip.app.presence.status(id) !== 'online', bobDevice, { timeout: 25_000 }).catch(() => {});
  await alice.page.evaluate((id) => window.__voip.app.calls.startDirectCall(id, 'video'), bobDevice);
  const callId = await alice.page.evaluate(() => window.__voip.app.calls.state.callId);
  await alice.page.waitForTimeout(3000);
  check('Calling a closed app never broadcasts (/notifyAll not requested)', !aliceBackendCalls.includes('/notifyAll'), aliceBackendCalls.join(',') || 'no backend calls');
  // Simulate the targeted push a capable backend would deliver, then the user's click.
  await deliver(cdp, regId, callPush(callId, ROOM, 'video'));
  await bob.page.waitForTimeout(700);
  const clickRes = await clickNotification(bob.ctx, `call-${callId}`, 'open');
  check('Click with no MeshCall window → context stored for launch (not in the URL)', clickRes === 'clicked');
  await bob.page.goto(APP); // what clients.openWindow() opens
  await bob.page.waitForSelector('#room-name');
  check('App launched from notification: room screen prefilled, explains the call', (await bob.page.inputValue('#room-name')) === ROOM && /Alice is calling you/.test(await bob.page.textContent('.room-info')));
  check('URL carries no call data', !/callId|action|room=/.test(bob.page.url()), bob.page.url());
  await bob.page.click('.room-screen button[type=submit]');
  const rings = await bob.page.waitForSelector('dialog.incoming button[aria-label=Accept]', { timeout: 30_000 }).then(() => true, () => false);
  check('After joining (ScaleDrone reconnect), the call is recovered as Accept/Reject – not auto-accepted', rings && (await bob.page.evaluate(() => window.__voip.app.calls.state?.status)) === 'ringing');
  if (rings) {
    await bob.page.click('dialog.incoming button[aria-label=Accept]');
    await alice.page.waitForFunction(() => window.__voip.diagnostics().call?.peers[0]?.connectionState === 'connected', null, { timeout: 40_000 });
    check('Accept → WebRTC call connects', true);
    await alice.page.evaluate(() => window.__voip.app.calls.hangup());
    await bob.page.waitForFunction(() => window.__voip.app.calls.state === null, null, { timeout: 20_000 });
  }

  // ═══════════════════════ PRIVATE MESSAGE → OFFLINE USER ═══════════════════
  section('Private message to an offline user + chat notification click');
  await bob.page.goto('about:blank'); // Bob's app closed
  await alice.page.waitForFunction((id) => window.__voip.app.presence.status(id) !== 'online', bobDevice, { timeout: 30_000 }).catch(() => {});
  aliceBackendCalls.length = 0;
  await alice.page.evaluate((id) => window.__voip.app.dms.send(id, 'See you at 5'), bobDevice);
  await alice.page.waitForTimeout(1500);
  const queued = await alice.page.evaluate((id) => window.__voip.app.dms.conversation(id).messages.at(-1), bobDevice);
  check('Offline recipient: message queued, not "Delivered"', queued.status === 'queued', `${queued.status} – ${queued.statusDetail}`);
  check('Private message never uses /notifyAll', !aliceBackendCalls.includes('/notifyAll'), aliceBackendCalls.join(',') || 'no backend calls');
  // What a backend with targeted delivery would send to Bob's device only:
  await deliver(cdp, regId, { title: 'New message', body: 'x', data: { type: 'chat-message', messageId: queued.messageId, senderId: queued.senderId, senderName: 'Alice', text: 'See you at 5', roomId: queued.roomId, roomName: ROOM, timestamp: queued.timestamp } });
  await bob.page.waitForTimeout(800);
  const chatN = (await notifications(bob.ctx)).find((n) => n.tag === `dm-${queued.senderId}`);
  check('chat-message push → "New message from Alice" (tag per sender)', chatN?.title === 'New message from Alice', chatN ? `${chatN.title} | ${chatN.body}` : 'none');
  check('Chat notification click (app closed) → context stored', (await clickNotification(bob.ctx, `dm-${queued.senderId}`)) === 'clicked');
  await bob.page.goto(APP);
  await bob.page.waitForSelector('#room-name');
  check('Launched: room prefilled, URL carries no message data', (await bob.page.inputValue('#room-name')) === ROOM && !/See|messageId|room=/.test(bob.page.url()), bob.page.url());
  await bob.page.click('.room-screen button[type=submit]');
  const opened = await bob.page.waitForSelector(`.dm-drawer:not([hidden]) .msg.highlight[data-id="${queued.messageId}"]`, { timeout: 30_000 }).then(() => true, () => false);
  check('After joining: queued message delivered via ScaleDrone, conversation open + highlighted', opened);
  const delivered = await alice.page.waitForFunction((id) => window.__voip.app.dms.conversation(id).messages.at(-1).status === 'delivered', bobDevice, { timeout: 20_000 }).then(() => true, () => false);
  check('Sender sees "Delivered" only after the recipient app acknowledged it', delivered);
  check('Chat notification cleared when the conversation opened', !(await notifications(bob.ctx)).some((n) => n.tag === `dm-${queued.senderId}`));
  // App visible → chat push is handed to the page (no system notification)
  await deliver(cdp, regId, { data: { type: 'chat-message', messageId: 'm-vis', senderId: queued.senderId, senderName: 'Alice', text: 'hi', roomId: queued.roomId, roomName: ROOM, timestamp: Date.now() } });
  await bob.page.waitForTimeout(800);
  check('App visible → no system notification for a chat push', !(await notifications(bob.ctx)).some((n) => n.tag === `dm-${queued.senderId}`));
  await bob.page.evaluate(() => document.querySelector('.dm-drawer button[aria-label="Close conversation"]')?.click());

  // App open (visible, same room): an incoming-call push must NOT create a duplicate notification.
  await deliver(cdp, regId, callPush('dup-1'));
  await bob.page.waitForTimeout(800);
  check('App visible → no duplicate system notification for a call push', !(await notifications(bob.ctx)).some((n) => n.tag === 'call-dup-1'));

  // App open in ANOTHER room + click → offer to switch (rooms are isolated).
  await bob.page.click('.room-chip button[aria-label="Leave room"]');
  await enterRoom(bob.page, OTHER);
  await deliver(cdp, regId, callPush('x-room', ROOM));
  const offered = await bob.page.waitForSelector('.toast.has-action button', { timeout: 10_000 }).then(() => true, () => false);
  check('Push for another room while open → "Switch room" offer, no silent switch', offered && (await bob.page.evaluate(() => window.__voip.app.rooms.current.roomName)) === OTHER);

  // In-app background notification (app running): Decline action rejects the real call.
  await bob.page.click('.room-chip button[aria-label="Leave room"]');
  await enterRoom(bob.page, ROOM);
  await alice.page.waitForFunction((id) => window.__voip.app.presence.status(id) === 'online', bobDevice, { timeout: 25_000 });
  await alice.page.evaluate((id) => window.__voip.app.calls.startDirectCall(id, 'audio'), bobDevice);
  await bob.page.waitForSelector('dialog.incoming', { timeout: 20_000 });
  const cid = await bob.page.evaluate(() => window.__voip.app.calls.state.callId);
  const hidden = await bob.page.evaluate(() => document.visibilityState !== 'visible' || !document.hasFocus());
  if (hidden) {
    await bob.page.waitForTimeout(700);
    const inApp = (await notifications(bob.ctx)).find((n) => n.tag === `call-${cid}`);
    check('Tab not focused → local call notification (no push server needed) with Open/Decline', inApp?.actions.join() === 'open,decline', inApp ? `${inApp.title} | ${inApp.body}` : 'none');
    await clickNotification(bob.ctx, `call-${cid}`, 'decline');
    const rejected = await alice.page.waitForFunction(() => window.__voip.app.calls.state?.status === 'rejected', null, { timeout: 15_000 }).then(() => true, () => false);
    check('Notification "Decline" rejects the call through the app', rejected);
  } else {
    check('Tab focused → in-app dialog only, no duplicate system notification', !(await notifications(bob.ctx)).some((n) => n.tag === `call-${cid}`));
    await bob.page.click('dialog.incoming button[aria-label=Decline]');
  }
  await Promise.all([alice, bob].map((u) => u.page.waitForFunction(() => window.__voip.app.calls.state === null, null, { timeout: 20_000 }).catch(() => {})));

  // ═══════════════════════════ FAILURES ═════════════════════════════════════
  section('Failure handling');
  const carol = await profile('carol');
  await carol.ctx.route(`${BACKEND}/**`, (r) => r.abort('connectionrefused'));
  await onboard(carol.page, 'Carol', ROOM);
  await carol.page.click('.enable-card button');
  check('Push server unavailable → "Unavailable" + retry, no crash', await waitStatus(carol.page, 'unavailable', 20_000));
  check('…signaling/presence unaffected', (await carol.page.evaluate(() => window.__voip.app.signaling.status)) === 'connected');
  await carol.ctx.unroute(`${BACKEND}/**`);
  await carol.ctx.route(`${BACKEND}/vapid`, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"VAPID not ready"}', headers: { 'access-control-allow-origin': ORIGIN } }));
  await carol.page.click('.enable-card button');
  await waitStatus(carol.page, 'unavailable', 20_000);
  const diag = await carol.page.evaluate(() => window.__voip.app.push.diagnostics());
  check('VAPID endpoint error surfaced in diagnostics', /503/.test(diag.lastError ?? ''), diag.lastError);
  await carol.ctx.unroute(`${BACKEND}/vapid`);
  await carol.ctx.route(`${BACKEND}/vapid`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"publicKey":"x"}', headers: { 'access-control-allow-origin': ORIGIN } }));
  await carol.page.click('.enable-card button');
  const bad = await waitStatus(carol.page, 'unavailable', 20_000);
  check('Invalid VAPID key rejected (not cached, no broken subscription)', bad && /invalid VAPID/.test((await carol.page.evaluate(() => window.__voip.app.push.diagnostics())).lastError ?? ''));
  // Real CORS: the backend only allows its configured origins; the browser must block others.
  const foreign = await carol.ctx.newPage();
  await foreign.goto('https://example.com/');
  const corsBlocked = await foreign.evaluate(async (b) => fetch(`${b}/vapid`).then(() => false, (e) => e instanceof TypeError), BACKEND);
  await foreign.close();
  check('CORS: a foreign origin is blocked by the browser (not bypassed by the app)', corsBlocked);
  await carol.ctx.unroute(`${BACKEND}/vapid`);
  await carol.page.click('.enable-card button');
  const recovered = await waitStatus(carol.page, 'enabled');
  const cep = await endpointOf(carol.page);
  if (cep) created.add(cep);
  check('Retry after the backend recovers → Enabled', recovered, `${await status(carol.page)} ${JSON.stringify((await carol.page.evaluate(() => window.__voip.app.push.diagnostics())).lastError)}`);
  await carol.page.click('.topbar button[aria-label=Diagnostics]');
  await carol.page.waitForTimeout(1500);
  const dtext = await carol.page.textContent('.diagnostics');
  check('Diagnostics panel: push section, endpoint redacted, no keys', /Push Notifications/.test(dtext) && /Targeted delivery/.test(dtext) && !/p256dh|auth"/.test(dtext) && !dtext.includes(cep ?? '###'));
} catch (err) {
  check('Push run', false, `${err.message.split('\n')[0]} @ ${(err.stack ?? '').split('\n').find((l) => l.includes('push.mjs')) ?? ''}`);
} finally {
  // Close the apps first (a running app re-registers its subscription – by design), then leave
  // the shared production push server clean and verify it.
  for (const c of contexts) await c.close().catch(() => {});
  const eps = [...created].filter(Boolean);
  for (const ep of eps) await server('/unsubscribe', { endpoint: ep }).catch(() => {});
  const left = [];
  for (const ep of eps) if (!(await confirmed(ep, false))) left.push(ep);
  console.log(`\n   cleanup: ${eps.length} test subscription(s) removed from the push server${left.length ? ` (${left.length} REMAIN!)` : ', verified'}`);
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
