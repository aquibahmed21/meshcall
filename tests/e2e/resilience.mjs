/**
 * Resilience scenarios (real ScaleDrone):
 *  1. Simultaneous calls (both users call each other at once) → no stuck state
 *  2. Offline → online (CDP network emulation) during a call → recovery, new ICE generation, P2P again
 *  3. Signaling socket forcibly re-created mid-call → media unaffected, call continues
 *  4. Hard page close of one peer → other side leaves "connected" (reconnecting → ended) – no permanent loading
 */
import { chromium } from 'playwright-core';

const ROOM = process.env.E2E_ROOM || `e2e-${Date.now().toString(36)}`;
/** Every page load asks for a room – enter the shared test room. */
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

const URL = process.env.E2E_URL || 'http://localhost:5173/';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: process.env.HEADLESS !== '0',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

async function user(name) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  // Count RTCPeerConnection constructions to catch runaway re-creation loops.
  await ctx.addInitScript(() => {
    const Orig = window.RTCPeerConnection;
    window.__pcCount = 0;
    window.RTCPeerConnection = function (...args) {
      window.__pcCount++;
      return new Orig(...args);
    };
    window.RTCPeerConnection.prototype = Orig.prototype;
  });
  const page = await ctx.newPage();
  if (process.env.DEBUG) page.on('console', (m) => /Recovery|re-creat|orphan|Creating peer|restart/i.test(m.text()) && console.log(`   (${name}) ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto(URL);
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  await enterRoom(page);
  await page.waitForFunction(() => window.__voip?.app.signaling.status === 'connected', null, { timeout: 30_000 });
  return { name, ctx, page, id: await page.evaluate(() => window.__voip.app.identity.deviceId) };
}
const peer0 = (u) => u.page.evaluate(() => window.__voip.diagnostics().call?.peers[0] ?? null);
const pcs = (u) => u.page.evaluate(() => window.__pcCount);
const status = (u) => u.page.evaluate(() => window.__voip.app.calls.state?.status ?? null);
const waitConnected = (u, timeout = 40_000) =>
  u.page.waitForFunction(() => window.__voip.diagnostics().call?.peers[0]?.connectionState === 'connected' && window.__voip.app.calls.state?.status === 'connected', null, { timeout });
const waitIdle = (u, timeout = 20_000) => u.page.waitForFunction(() => window.__voip.app.calls.state === null, null, { timeout });

try {
  const a = await user('Ann');
  const b = await user('Ben');
  await a.page.waitForFunction((id) => window.__voip.app.presence.status(id) === 'online', b.id, { timeout: 30_000 });
  await b.page.waitForFunction((id) => window.__voip.app.presence.status(id) === 'online', a.id, { timeout: 30_000 });

  // 1. both call each other at the same moment
  await Promise.all([
    a.page.evaluate((id) => window.__voip.app.calls.startDirectCall(id, 'audio'), b.id),
    b.page.evaluate((id) => window.__voip.app.calls.startDirectCall(id, 'audio'), a.id),
  ]);
  await a.page.waitForTimeout(3000);
  const s1 = [await status(a), await status(b)];
  check('Simultaneous calls resolve to "busy" for both (no deadlock / double ringing)', s1.every((s) => s === 'busy' || s === null), s1.join(' / '));
  await Promise.all([waitIdle(a), waitIdle(b)]);

  // Normal call for the remaining scenarios
  await a.page.evaluate((id) => window.__voip.app.calls.startDirectCall(id, 'video'), b.id);
  await b.page.waitForSelector('dialog.incoming button[aria-label=Accept]', { timeout: 20_000 });
  await b.page.click('dialog.incoming button[aria-label=Accept]');
  await Promise.all([waitConnected(a), waitConnected(b)]);
  const before = await peer0(a);

  console.log(`   PCs created so far: Ann ${await pcs(a)}, Ben ${await pcs(b)}`);
  // 2. offline → online on Ben. NOTE: browser offline emulation cuts HTTP/WebSocket (signaling)
  // and fires offline/online events, but it does NOT drop WebRTC's UDP media. So this verifies
  // the event-driven recovery path (ICE restart on "online"), not a real media outage.
  await b.ctx.setOffline(true);
  await b.page.waitForTimeout(8000);
  const during = [await status(a), await status(b)];
  const restartsBefore = (await peer0(b))?.iceRestarts ?? 0;
  await b.ctx.setOffline(false);
  try {
    await b.page.waitForFunction((n) => (window.__voip.diagnostics().call?.peers[0]?.iceRestarts ?? 0) > n, restartsBefore, { timeout: 15_000 });
    await Promise.all([waitConnected(a, 45_000), waitConnected(b, 45_000)]);
    const after = await peer0(b);
    check('Offline → online: ICE restart + call stays/recovers connected', true, `during=${during.join('/')}, Ben ICE restarts ${restartsBefore}→${after.iceRestarts}, path=${after.connectionType} ${after.selectedCandidate}`);
    check('Recovery re-selected a direct path', after.connectionType === 'P2P' || after.connectionType === 'STUN', after.selectedCandidate);
  } catch {
    check('Offline → online: call recovers', false, `during=${during.join('/')} now=${await status(a)}/${await status(b)} ${JSON.stringify(await peer0(a))}`);
  }

  // 3. force a fresh signaling socket mid-call
  await b.page.evaluate(() => window.__voip.app.signaling.reconnectNow('e2e'));
  await b.page.waitForFunction(() => window.__voip.app.signaling.status === 'connected', null, { timeout: 30_000 });
  await b.page.waitForTimeout(4000);
  check('Signaling reconnect mid-call keeps the call connected', (await status(a)) === 'connected' && (await status(b)) === 'connected');

  console.log(`   PCs created so far: Ann ${await pcs(a)}, Ben ${await pcs(b)}`);
  // 4. Ben's tab disappears without hangup
  await b.ctx.close();
  await a.page.waitForFunction(() => ['reconnecting', 'ended', 'failed', null].includes(window.__voip.app.calls.state?.status ?? null), null, { timeout: 30_000 });
  check('Peer vanishes → caller leaves "connected"', true, await status(a));
  await a.page.waitForFunction(() => window.__voip.app.calls.state === null || ['ended', 'failed'].includes(window.__voip.app.calls.state.status), null, { timeout: 90_000 });
  check('…and the call terminates (no permanent loading state)', true, (await status(a)) ?? 'idle');
  const created = await pcs(a);
  check('No runaway peer-connection re-creation', created < 20, `Ann created ${created} RTCPeerConnections in total`);
} catch (err) {
  check('Resilience run', false, err.message.split('\n')[0]);
} finally {
  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
