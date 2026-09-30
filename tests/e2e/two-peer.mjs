/**
 * End-to-end smoke test against the REAL ScaleDrone channel and STUN/TURN servers.
 * Each browser context has isolated storage = a separate device.
 *
 *   npm run dev          (in another terminal)
 *   npm run test:e2e     (E2E_URL, CHROME_PATH, HEADLESS=0 to watch)
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
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const results = [];
const skipped = [];
const log = (...a) => console.log('•', ...a);

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADLESS !== '0',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

async function user(name) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto(URL);
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  await enterRoom(page);
  await page.waitForFunction(() => window.__voip?.app.signaling.status === 'connected', null, { timeout: 30_000 });
  const id = await page.evaluate(() => window.__voip.app.identity.deviceId);
  return { name, ctx, page, id };
}

const diag = (u) => u.page.evaluate(() => window.__voip.diagnostics());
const setTestMode = (u, mode) => u.page.evaluate((m) => window.__voip.app.settings.update({ iceTestMode: m }), mode);

async function waitPeers(u, count, predicate = 'connected', timeout = 40_000) {
  try {
    await u.page.waitForFunction(
      ([n, pred]) => {
        const d = window.__voip.diagnostics();
        const peers = d.call?.peers ?? [];
        const ok = peers.filter((p) => p.connectionState === 'connected' && (pred === 'connected' || p.connectionType === pred));
        return ok.length >= n;
      },
      [count, predicate],
      { timeout },
    );
  } catch (err) {
    const d = await u.page.evaluate(() => {
      const c = window.__voip.app.calls.state;
      return { status: c?.status, kind: c?.kind, peers: (window.__voip.diagnostics().call?.peers ?? []).map((p) => `${p.peer}:${p.connectionState ?? 'no-pc'}`) };
    });
    throw new Error(`${u.name} expected ${count} ${predicate} peers – ${JSON.stringify(d)}`);
  }
}

async function waitOnline(u, other) {
  await u.page.waitForFunction((id) => window.__voip.app.presence.status(id) === 'online', other.id, { timeout: 30_000 });
}

async function callAndAccept(caller, callee, media = 'video') {
  await caller.page.evaluate(([id, m]) => window.__voip.app.calls.startDirectCall(id, m), [callee.id, media]);
  await callee.page.waitForSelector('dialog.incoming button[aria-label=Accept]', { timeout: 20_000 });
  await callee.page.click('dialog.incoming button[aria-label=Accept]');
}

async function waitIdle(u, timeout = 15_000) {
  await u.page.waitForFunction(() => window.__voip.app.calls.state === null, null, { timeout });
}

async function mediaFlowing(u) {
  const a = await diag(u);
  await u.page.waitForTimeout(2500);
  const b = await diag(u);
  const pa = a.call?.peers[0];
  const pb = b.call?.peers[0];
  return (pb?.bytesReceived ?? 0) > (pa?.bytesReceived ?? 0);
}

try {
  const alice = await user('Alice');
  const bob = await user('Bob');
  log('Alice', alice.id.slice(0, 8), 'Bob', bob.id.slice(0, 8));
  await waitOnline(alice, bob);
  await waitOnline(bob, alice);
  check('Presence: both online', true);

  // 1:1 video, P2P first
  const t0 = Date.now();
  await callAndAccept(alice, bob, 'video');
  await waitPeers(alice, 1);
  await waitPeers(bob, 1);
  await alice.page.waitForFunction(() => !!window.__voip.diagnostics().call?.peers[0]?.connectionType, null, { timeout: 10_000 });
  let d = await diag(alice);
  check('1:1 video connected', true, `${Date.now() - t0} ms`);
  check('Direct P2P selected (host → host) on same machine', d.call.peers[0].connectionType === 'P2P', `${d.call.peers[0].selectedCandidate} ${d.call.peers[0].transport}`);
  check('Media flows (bytes increasing)', await mediaFlowing(bob));
  const firstGen = d.call.peers[0].generation;

  // Network change → ICE restart → still direct
  await alice.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await alice.page.waitForFunction(() => (window.__voip.diagnostics().call?.peers[0]?.iceRestarts ?? 0) >= 1, null, { timeout: 10_000 });
  await alice.page.waitForTimeout(3000);
  d = await diag(alice);
  check('Network change triggers ICE restart and stays connected', d.call.peers[0].connectionState === 'connected', `restarts=${d.call.peers[0].iceRestarts} path=${d.call.peers[0].connectionType}`);

  // Rejoin: Bob reloads → fresh peer connection, P2P again
  await bob.page.reload();
  await enterRoom(bob.page);
  await bob.page.waitForSelector('.banner button.primary', { timeout: 10_000 });
  await bob.page.click('.banner button.primary');
  await waitPeers(bob, 1);
  await waitPeers(alice, 1);
  await alice.page.waitForFunction((g) => (window.__voip.diagnostics().call?.peers[0]?.generation ?? -1) > g && !!window.__voip.diagnostics().call.peers[0].connectionType, firstGen, { timeout: 15_000 });
  d = await diag(alice);
  check('Rejoin creates a NEW peer connection', d.call.peers[0].generation > firstGen, `generation ${firstGen} → ${d.call.peers[0].generation}`);
  check('Rejoin tries direct P2P again', d.call.peers[0].connectionType === 'P2P', d.call.peers[0].selectedCandidate);

  // Hangup cleans up both sides
  await alice.page.evaluate(() => window.__voip.app.calls.hangup());
  await waitIdle(alice);
  await waitIdle(bob);
  const clean = await Promise.all(
    [alice, bob].map((u) => u.page.evaluate(() => !window.__voip.app.media.isActive && window.__voip.app.calls.session === null)),
  );
  check('Hangup releases camera/mic and peer connections on both sides', clean.every(Boolean));

  // Reject
  await alice.page.evaluate((id) => window.__voip.app.calls.startDirectCall(id, 'audio'), bob.id);
  await bob.page.waitForSelector('dialog.incoming button[aria-label=Decline]', { timeout: 20_000 });
  await bob.page.click('dialog.incoming button[aria-label=Decline]');
  await alice.page.waitForFunction(() => window.__voip.app.calls.state?.status === 'rejected', null, { timeout: 10_000 });
  check('Reject → caller sees "rejected"', true);
  await waitIdle(alice);
  await waitIdle(bob);

  // STUN/TURN health of the configured servers
  const probe = await alice.page.evaluate(() => window.__voip.probeIceServers());
  for (const r of probe) console.log(`   probe ${r.status === 'success' ? 'OK  ' : 'FAIL'} ${r.url} ${r.status === 'success' ? `${r.candidateType} ${r.address ?? ''}` : `${r.error} ${r.errors.join('; ')}`}`);
  const turnUsable = probe.some((r) => r.type === 'turn' && r.status === 'success');
  check('At least one STUN server reachable (srflx discovered)', probe.some((r) => r.type === 'stun' && r.status === 'success'));

  // TURN relay (test mode) – proves the relay fallback works
  if (!turnUsable) {
    skipped.push('TURN relay checks – configured TURN server did not allocate (see probe above)');
    console.log('⚠️  SKIPPED TURN relay checks: configured TURN server unusable from this network');
  } else {
  await setTestMode(alice, 'relay-only');
  await setTestMode(bob, 'relay-only');
  await callAndAccept(alice, bob, 'audio');
  try {
    await waitPeers(alice, 1, 'TURN', 30_000);
    d = await diag(alice);
    check('TURN relay works (forced relay test mode)', true, `${d.call.peers[0].selectedCandidate} ${d.call.peers[0].transport}/${d.call.peers[0].relayProtocol ?? ''}`);
    const srv = d.call.peers[0].server;
    check('Connection path reported as "turn" from the selected pair', d.call.peers[0].connectionPath === 'turn');
    check('TURN server identified (or honestly reported unknown)', srv?.role === 'turn' && (srv.url ? d.iceServers.some((u) => srv.url.split('?')[0] === u.split('?')[0]) : srv.source === 'unknown'), `${srv?.url ?? '(not exposed)'} via ${srv?.source}`);
    check('Media flows through TURN', await mediaFlowing(bob));
  } catch {
    d = await diag(alice);
    check('TURN relay works (forced relay test mode)', false, JSON.stringify(d.call?.peers?.[0] ?? {}));
  }
  await alice.page.evaluate(() => window.__voip.app.calls.hangup());
  await waitIdle(alice);
  await waitIdle(bob);
  await setTestMode(alice, 'normal');
  await setTestMode(bob, 'normal');
  }

  // Normal mode after TURN: P2P is tried again (TURN not remembered)
  await callAndAccept(alice, bob, 'audio');
  await waitPeers(alice, 1);
  await alice.page.waitForFunction(() => !!window.__voip.diagnostics().call?.peers[0]?.connectionType, null, { timeout: 10_000 });
  d = await diag(alice);
  check('Next call after a TURN call goes direct again', d.call.peers[0].connectionType === 'P2P', d.call.peers[0].selectedCandidate);
  await alice.page.evaluate(() => window.__voip.app.calls.hangup());
  await waitIdle(alice);
  await waitIdle(bob);

  // Group mesh of 3
  const carol = await user('Carol');
  await waitOnline(alice, carol);
  await alice.page.evaluate(([b, c]) => window.__voip.app.groups.create([b, c], 'video', 'Standup'), [bob.id, carol.id]);
  for (const u of [bob, carol]) {
    await u.page.waitForSelector('dialog.incoming button[aria-label=Accept]', { timeout: 20_000 });
    await u.page.click('dialog.incoming button[aria-label=Accept]');
  }
  await Promise.all([alice, bob, carol].map((u) => waitPeers(u, 2)));
  check('Group: full mesh (each of 3 has 2 connected peers)', true);
  const tiles = await alice.page.$$eval('.video-stage .tile', (t) => t.length);
  check('Group: 3 video tiles rendered', tiles === 3, `${tiles} tiles`);

  await carol.page.evaluate(() => window.__voip.app.calls.hangup());
  await alice.page.waitForFunction(() => window.__voip.diagnostics().call?.peers.length === 1, null, { timeout: 15_000 });
  d = await diag(alice);
  check('Group: participant leave closes only its connection', d.call.peers[0].connectionState === 'connected' && d.call.peers.length === 1);

  // Carol rejoins the running group by reloading? She hung up, so she re-joins via a new invite
  await alice.page.evaluate((c) => window.__voip.app.groups.addParticipant(c), carol.id);
  await carol.page.waitForSelector('dialog.incoming button[aria-label=Accept]', { timeout: 20_000 });
  await carol.page.click('dialog.incoming button[aria-label=Accept]');
  await Promise.all([alice, bob, carol].map((u) => waitPeers(u, 2)));
  check('Group: participant rejoin reconnects to everyone', true);
  await Promise.all([alice, bob, carol].map((u) => u.page.evaluate(() => window.__voip.app.calls.hangup())));

  // Live stream: Alice broadcasts, Bob + Carol watch
  await Promise.all([alice, bob, carol].map((u) => waitIdle(u)));
  await alice.page.evaluate(() => window.__voip.app.live.goLive('E2E stream'));
  for (const u of [bob, carol]) {
    await u.page.waitForFunction(() => window.__voip.app.live.list().length > 0, null, { timeout: 20_000 });
    await u.page.evaluate(() => window.__voip.app.live.join(window.__voip.app.live.list()[0].streamId));
  }
  await waitPeers(alice, 2);
  await waitPeers(bob, 1);
  const bobPeers = (await diag(bob)).call.peers.length;
  check('Live: broadcaster has 2 viewers, viewers only connect to broadcaster', bobPeers === 1);
  check('Live: viewer receives media', await mediaFlowing(bob));
  await alice.page.evaluate(() => window.__voip.app.calls.hangup());
  await bob.page.waitForFunction(() => ['ended', null].includes(window.__voip.app.calls.state?.status ?? null), null, { timeout: 15_000 });
  check('Live: viewers see stream ended', true);
} catch (err) {
  check('E2E run', false, err.message.split('\n')[0] + ' @ ' + (err.stack.split('\n').find((l) => l.includes('two-peer.mjs')) ?? ''));
} finally {
  await browser.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed${skipped.length ? `, ${skipped.length} skipped:\n  - ${skipped.join('\n  - ')}` : ''}`);
  process.exit(failed ? 1 : 0);
}
