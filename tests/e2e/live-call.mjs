/**
 * Streamer calls participants into a live stream.
 *   online  → ringing invitation (dialog + ringtone) → Watch → joins as a normal viewer
 *   offline → targeted push only (never /notifyAll); rung as soon as they come online
 *   SW      → "Live Stream Invitation" notification text for a live incoming-call push
 *
 *   npm run dev   then   node tests/e2e/live-call.mjs
 */
import { chromium } from 'playwright-core';

const URL = process.env.E2E_URL || 'http://localhost:5173/';
const ROOM = `live-call-${Date.now().toString(36)}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
// Count ringtone tones (oscillators started) per page.
const countTones = () => {
  window.__tones = 0;
  const orig = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (...a) {
    window.__tones++;
    return orig.apply(this, a);
  };
};
async function enterRoom(page, room = ROOM) {
  // Reload/relaunch reopens the last active room automatically – nothing to enter then.
  const want = typeof room === 'string' ? room.replace(/\s+/g, ' ').trim() : undefined;
  await page.waitForFunction(
    (r) => (!!r && window.__voip?.app.rooms.current?.roomName === r && window.__voip.app.signaling.status === 'connected') || !!document.querySelector('#room-name:not([disabled])'),
    want,
    { timeout: 30_000 },
  );
  if (want && (await page.evaluate((r) => window.__voip?.app.rooms.current?.roomName === r, want))) return;
  await page.fill('#room-name', room);
  await page.click('.room-screen button[type=submit]');
  await page.waitForFunction(() => !!window.__voip?.app.rooms.current && window.__voip.app.signaling.status === 'connected', null, { timeout: 30_000 });
}
async function user(name) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(countTones);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  const backend = [];
  page.on('request', (r) => /notifyAll|\/notify\b/.test(r.url()) && backend.push(r.url()));
  await page.goto(URL);
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  await enterRoom(page);
  return { name, ctx, page, backend, id: await page.evaluate(() => window.__voip.app.identity.deviceId) };
}
const ev = (u, fn, a) => u.page.evaluate(fn, a);
const tones = (u) => ev(u, () => window.__tones);

try {
  const host = await user('Host');
  const bob = await user('Bob');
  const carol = await user('Carol');
  for (const u of [bob, carol]) await host.page.waitForFunction((id) => window.__voip.app.presence.status(id) === 'online', u.id, { timeout: 30_000 });

  // Carol leaves → offline for the host
  await carol.page.click('.room-chip button[aria-label="Leave room"]');
  await carol.page.waitForSelector('#room-name');
  await host.page.waitForFunction((id) => window.__voip.app.presence.status(id) !== 'online', carol.id, { timeout: 30_000 });

  // Host goes live for a selected audience (nobody yet)
  await ev(host, () => window.__voip.app.live.goLive('Demo', { mode: 'selected', viewerIds: [] }));
  await host.page.waitForFunction(() => !!window.__voip.app.live.state?.streamId, null, { timeout: 20_000 });

  // ── online participant: host uses the normal Call button ──
  const t0 = await tones(bob);
  await host.page.click(`li.user[data-user="${bob.id}"] button[aria-label="Audio call Bob"]`);
  await bob.page.waitForSelector('dialog.live-ring[open]', { timeout: 15_000 });
  const dlg = await ev(bob, () => document.querySelector('dialog.live-ring[open]').textContent);
  check('Online: incoming live-call UI shown', /Host is calling you to watch the live stream “Demo”/.test(dlg), dlg.slice(0, 90));
  await bob.page.waitForTimeout(3000);
  const t1 = await tones(bob);
  check('Online: ringtone plays (repeating) while ringing', t1 - t0 >= 4, `${t1 - t0} tones in ~3 s`);
  check('Host toast "Calling Bob into the stream"', /Calling Bob into the stream/.test(await ev(host, () => document.querySelector('.toasts').textContent)));
  check('Host call button did not start a separate WebRTC call', await ev(host, () => window.__voip.app.calls.state.kind === 'live'));
  await bob.page.click('dialog.live-ring[open] button:has-text("Watch")');
  await bob.page.waitForTimeout(300);
  const tAnswer = await tones(bob);
  await bob.page.waitForTimeout(2800); // > one ring interval (2.5 s)
  check('Ringtone stops when answered', (await tones(bob)) === tAnswer, `${(await tones(bob)) - tAnswer} tones after answering`);
  const joined = await host.page.waitForFunction((id) => window.__voip.diagnostics().call?.peers.some((p) => p.deviceId === id && p.connectionState === 'connected'), bob.id, { timeout: 30_000 }).then(() => true, () => false);
  check('Answer → Bob joins as a normal viewer (existing live path)', joined && (await ev(bob, () => window.__voip.app.calls.state?.kind === 'live' && window.__voip.app.calls.state.role === 'viewer')));

  // ── offline participant ──
  await host.page.click(`li.user[data-user="${carol.id}"] button[aria-label="Audio call Carol"]`);
  await host.page.waitForTimeout(1500);
  const toast = await ev(host, () => document.querySelector('.toasts').textContent);
  check('Offline: host told the truth (no targeted push available)', /Carol is offline/.test(toast) && /rung as soon as they come online/.test(toast), toast.slice(-140));
  check('Offline: nothing broadcast (/notifyAll never requested)', host.backend.length === 0, host.backend.join(','));
  check('Offline: Carol added to the audience', await ev(host, (id) => window.__voip.app.live.isAllowed(id), carol.id));
  const ct0 = await tones(carol);
  await enterRoom(carol.page); // comes back online (e.g. after opening the notification)
  const rang = await carol.page.waitForSelector('dialog.live-ring[open]', { timeout: 30_000 }).then(() => true, () => false);
  await carol.page.waitForTimeout(1500);
  check('Offline → online: Carol gets the ringing invitation', rang && (await tones(carol)) > ct0);
  await carol.page.click('dialog.live-ring[open] button:has-text("Not now")');
  const c1 = await tones(carol);
  await carol.page.waitForTimeout(2600);
  check('Dismiss stops the ringtone', (await tones(carol)) === c1);

  // ── Service Worker: live incoming-call push text (synthetic push inside the SW) ──
  const sw = carol.ctx.serviceWorkers()[0] ?? (await carol.ctx.waitForEvent('serviceworker', { timeout: 10_000 }));
  await carol.ctx.grantPermissions(['notifications']);
  await carol.page.goto('about:blank'); // no visible client → the SW must notify
  const n = await sw.evaluate(async () => {
    const data = JSON.stringify({ type: 'incoming-call', callId: 'live-x', roomId: 'r', roomName: 'Eng', callerId: 'h', callerName: 'Host', callType: 'live', title: 'Demo', timestamp: Date.now(), expiresAt: Date.now() + 45000 });
    const e = new PushEvent('push', { data });
    self.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 800));
    const [x] = await self.registration.getNotifications({ tag: 'call-live-x' });
    return x && { title: x.title, body: x.body, icon: x.icon, badge: x.badge };
  });
  check('SW: "Live Stream Invitation" notification for a live push', n?.title === 'Live Stream Invitation' && /Host invites you to watch “Demo” in Eng/.test(n.body), n ? `${n.title} | ${n.body}` : 'none');
  check('SW: notification uses the MeshCall icon + monochrome badge', /icons\/icon-192\.png$/.test(n?.icon ?? '') && /icons\/badge-96\.png$/.test(n?.badge ?? ''), `${n?.badge}`);
} catch (err) {
  check('Run', false, err.stack?.split('\n').slice(0, 2).join(' '));
} finally {
  await browser.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
