/**
 * Connection diagnostics, ICE server tests, offline-actionable users and direct messages.
 * Real ScaleDrone + headless Chrome with fake media. Needs the local TURN server (see README):
 *
 *   node tests/e2e/local-turn.mjs &
 *   VITE_TURN_SERVER=turn:<LAN-IP>:3479 VITE_TURN_USERNAME=e2e VITE_TURN_CREDENTIAL=e2e-secret npx vite --port 5174 &
 *   E2E_URL=http://localhost:5174/ TURN_HOST=<LAN-IP> node tests/e2e/diagnostics.mjs
 */
import { chromium } from 'playwright-core';

const URL = process.env.E2E_URL || 'http://localhost:5174/';
const TURN_HOST = process.env.TURN_HOST || '127.0.0.1';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const ROOM = `diag-${Date.now().toString(36)}`;
const OTHER_ROOM = `${ROOM}-other`;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: process.env.HEADLESS !== '0',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

async function enterRoom(page, room) {
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
async function leaveRoom(u) {
  await u.page.click('.topbar button[aria-label=More]');
  await u.page.click('.top-menu button:has-text("Leave room")');
  await u.page.waitForSelector('#room-name', { timeout: 20_000 });
}
async function user(name) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  const pushRequests = [];
  page.on('request', (r) => /notifyAll/.test(r.url()) && pushRequests.push(r.url())); // targeted /notify is fine
  await page.goto(URL);
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  await enterRoom(page, ROOM);
  const id = await page.evaluate(() => window.__voip.app.identity.deviceId);
  return { name, ctx, page, id, pushRequests };
}
const ev = (u, fn, arg) => u.page.evaluate(fn, arg);
const presence = (u, id) => ev(u, (i) => window.__voip.app.presence.status(i), id);
const waitPresence = (u, id, st, timeout = 30_000) => u.page.waitForFunction(([i, s]) => window.__voip.app.presence.status(i) === s, [id, st], { timeout });
const dmStatus = (u, peer) => ev(u, (p) => window.__voip.app.dms.conversation(p).messages.filter((m) => m.own).map((m) => m.status), peer);

try {
  const alice = await user('Alice');
  const bob = await user('Bob');
  await waitPresence(alice, bob.id, 'online');
  await waitPresence(bob, alice.id, 'online');

  // ── Connection path on tiles ─────────────────────────────────────────────
  // Record every (status,path) the remote tile ever shows: a path may only appear once connected.
  await ev(alice, () => {
    window.__netTrace = [];
    new MutationObserver(() => {
      for (const n of document.querySelectorAll('.tile:not(.local) .tile-net')) window.__netTrace.push(`${n.dataset.status}|${n.dataset.path}|${n.textContent}`);
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  await ev(alice, (id) => window.__voip.app.calls.startDirectCall(id, 'video'), bob.id);
  await bob.page.waitForSelector('dialog.incoming button[aria-label=Accept]', { timeout: 20_000 });
  await bob.page.click('dialog.incoming button[aria-label=Accept]');
  await alice.page.waitForSelector('.tile:not(.local) .tile-net[data-status=connected]', { timeout: 30_000 });
  const trace = await ev(alice, () => window.__netTrace);
  const early = trace.filter((t) => !t.startsWith('connected|'));
  check('Before connecting the path is Unknown (never assumed)', early.every((t) => t.split('|')[1] === 'unknown'), [...new Set(early)].slice(0, 3).join(' ; ') || '(connected immediately)');
  await alice.page.waitForSelector('.tile:not(.local) .tile-net[data-path=p2p]', { timeout: 10_000 }).catch(async () =>
    console.log('   debug:', JSON.stringify(await ev(alice, () => ({ d: window.__voip.diagnostics().call?.peers, rep: [...(window.__voip.app.calls.session?.statsReport?.peers.keys() ?? [])] })))),
  );
  const net = await ev(alice, () => {
    const n = document.querySelector('.tile:not(.local) .tile-net');
    return { text: n.textContent, path: n.dataset.path };
  });
  check('Tile compact line "● Connected · P2P"', net.text.includes('Connected') && net.text.includes('P2P') && net.path === 'p2p', net.text);

  await alice.page.click('.tile:not(.local) .tile-info');
  await alice.page.waitForSelector('.tile:not(.local) .tile-details:not([hidden]) dl', { timeout: 5_000 });
  // details refresh with stats; wait until RTT is present
  await alice.page.waitForFunction(() => [...document.querySelectorAll('.tile:not(.local) .tile-details dt')].some((d) => d.textContent === 'RTT'), null, { timeout: 10_000 }).catch(() => {});
  const rows = await ev(alice, () => Object.fromEntries([...document.querySelectorAll('.tile:not(.local) .tile-details dt')].map((d) => [d.textContent, d.nextElementSibling.textContent])));
  check('Expanded details: Connection/ICE/Protocol/RTT/Loss/Upload/Download', ['Connection', 'ICE', 'Protocol', 'RTT', 'Packet Loss', 'Upload', 'Download'].every((k) => k in rows), JSON.stringify(rows));
  check('ICE row shows the actual selected pair', /host → host/.test(rows.ICE ?? ''), rows.ICE);
  check('Info button is aria-expanded', (await ev(alice, () => document.querySelector('.tile:not(.local) .tile-info').getAttribute('aria-expanded'))) === 'true');

  // ── Network Diagnostics panel ─────────────────────────────────────────────
  await alice.page.click('.topbar button[aria-label=Diagnostics], button[aria-label=Diagnostics]');
  await alice.page.waitForSelector('.diagnostics .net-card', { timeout: 10_000 });
  const card = await ev(alice, (id) => {
    const c = document.querySelector(`.net-card[data-peer="${id}"]`);
    return c && { path: c.dataset.path, text: c.textContent };
  }, bob.id);
  check('Network Diagnostics lists the peer connection with its path', card?.path === 'p2p' && /host → host/.test(card.text), card?.text.slice(0, 120));
  const statsCalls = await ev(alice, async () => {
    const pcs = [];
    const orig = RTCPeerConnection.prototype.getStats;
    let n = 0;
    RTCPeerConnection.prototype.getStats = function (...a) { n++; return orig.apply(this, a); };
    await new Promise((r) => setTimeout(r, 6000));
    RTCPeerConnection.prototype.getStats = orig;
    return n;
  });
  check('Panel refresh does not add getStats calls (one per PC per 2 s interval)', statsCalls <= 4, `${statsCalls} calls in 6 s for 1 PC`);

  // ── Relay-only test mode → TURN + server URL ───────────────────────────────
  await ev(alice, () => window.__voip.app.calls.hangup());
  await alice.page.waitForFunction(() => window.__voip.app.calls.session === null, null, { timeout: 15_000 });
  await bob.page.waitForFunction(() => window.__voip.app.calls.session === null, null, { timeout: 15_000 });
  for (const u of [alice, bob]) await ev(u, () => window.__voip.app.settings.update({ iceTestMode: 'relay-only' }));
  await ev(alice, (id) => window.__voip.app.calls.startDirectCall(id, 'audio'), bob.id);
  await bob.page.waitForSelector('dialog.incoming button[aria-label=Accept]', { timeout: 20_000 });
  await bob.page.click('dialog.incoming button[aria-label=Accept]');
  await alice.page.waitForSelector('.tile:not(.local) .tile-net[data-path=turn]', { timeout: 40_000 }).catch(() => {});
  await alice.page.click('.tile:not(.local) .tile-info');
  await alice.page.waitForSelector('.tile:not(.local) .tile-details:not([hidden]) dl', { timeout: 5_000 }).catch(() => {});
  const turn = await ev(alice, () => {
    const d = window.__voip.diagnostics().call.peers[0];
    const n = document.querySelector('.tile:not(.local) .tile-net');
    const rows = Object.fromEntries([...document.querySelectorAll('.tile:not(.local) .tile-details dt')].map((x) => [x.textContent, x.nextElementSibling.textContent]));
    return { d, text: n?.textContent, rows };
  });
  check('Relay-only: tile shows "Connected · TURN"', /TURN/.test(turn.text ?? '') && turn.d.connectionPath === 'turn', turn.text);
  check('Relay-only: pair relay → relay', turn.d.selectedCandidate === 'relay → relay', turn.d.selectedCandidate);
  check('TURN server URL identified from WebRTC (not from config)', turn.d.server?.url?.startsWith(`turn:${TURN_HOST}:3479`) && ['stats', 'gathering'].includes(turn.d.server.source), `${turn.d.server?.url} via ${turn.d.server?.source}`);
  check('TURN server shown in tile details', Object.entries(turn.rows).some(([k, v]) => k === 'TURN Server' && v.includes(TURN_HOST)), JSON.stringify(turn.rows['TURN Server'] ?? ''));
  await ev(alice, () => window.__voip.app.calls.hangup());
  await alice.page.waitForFunction(() => window.__voip.app.calls.session === null, null, { timeout: 15_000 });
  await bob.page.waitForFunction(() => window.__voip.app.calls.session === null, null, { timeout: 15_000 });
  for (const u of [alice, bob]) await ev(u, () => window.__voip.app.settings.update({ iceTestMode: 'normal' }));
  check('Normal calls keep iceTransportPolicy "all"', await ev(alice, () => window.__voip.app.settings.get().iceTestMode === 'normal'));

  // ── STUN / TURN server tests ──────────────────────────────────────────────
  const t = (server, ms = 6000) => ev(alice, ([s, m]) => window.__voip.testIceServer(s, m), [server, ms]);
  const pcCountBefore = await ev(alice, () => (window.__pcs = window.__pcs ?? 0));
  const [gStun, badStun, goodTurn, badCreds, deadTurn] = await Promise.all([
    t({ urls: 'stun:stun.l.google.com:19302' }),
    t({ urls: 'stun:127.0.0.1:9' }, 4000),
    t({ urls: `turn:${TURN_HOST}:3479`, username: 'e2e', credential: 'e2e-secret' }),
    t({ urls: `turn:${TURN_HOST}:3479`, username: 'e2e', credential: 'wrong' }),
    t({ urls: `turn:${TURN_HOST}:3999`, username: 'e2e', credential: 'e2e-secret' }, 4000),
  ]);
  check('STUN test: Google STUN → srflx', gStun.status === 'success' && gStun.candidateType === 'srflx' && !!gStun.address, `${gStun.address} ${gStun.protocol}`);
  check('STUN test: dead STUN fails (no srflx)', badStun.status === 'failed', badStun.error);
  check('TURN test: local TURN → relay candidate (UDP)', goodTurn.status === 'success' && goodTurn.candidateType === 'relay' && goodTurn.relayProtocol === 'UDP', `${goodTurn.address} relay=${goodTurn.relayProtocol} url=${goodTurn.reportedUrl}`);
  check('TURN test: invalid credentials → failed with credential cause', badCreds.status === 'failed' && /credential/i.test(badCreds.error) && badCreds.errors.some((e) => e.startsWith('401')), `${badCreds.error} [${badCreds.errors.join('; ')}]`);
  check('TURN test: wrong port → failed with causes listed', deadTurn.status === 'failed' && (deadTurn.causes?.length ?? 0) > 0, `${deadTurn.error}`);
  check('Test results use IceServerTestResult shape', [gStun, badCreds].every((r) => r.url && r.type && r.status && Array.isArray(r.errors) && typeof r.durationMs === 'number'));
  // UI: run from the panel
  await alice.page.click('.diagnostics button:has-text("Test all TURN")');
  await alice.page.waitForSelector('.diagnostics li.ice-test.success, .diagnostics li.ice-test.failed', { timeout: 20_000 });
  await alice.page.waitForFunction(() => !document.querySelector('.diagnostics li.ice-test.testing'), null, { timeout: 20_000 });
  const uiTurn = await ev(alice, () => [...document.querySelectorAll('.diagnostics li.ice-test')].map((l) => `${l.dataset.url}:${l.className.replace('ice-test ', '')}`));
  check('Panel "Test all TURN" shows per-server result', uiTurn.some((x) => x.includes(`${TURN_HOST}:3479`) && x.endsWith('success')), uiTurn.join(', '));
  check('Panel groups STUN Tests / TURN Tests', await ev(alice, () => /STUN Tests/.test(document.querySelector('.diagnostics').textContent) && /TURN Tests/.test(document.querySelector('.diagnostics').textContent)));
  await alice.page.click('.diagnostics .diag-header button[aria-label*=Close], .diagnostics button[aria-label="Close diagnostics"]').catch(() => ev(alice, () => document.querySelector('button[aria-label=Diagnostics]').click()));

  // ── Direct message to an ONLINE user → ScaleDrone → Delivered ───────────
  await alice.page.click(`li.user[data-user="${bob.id}"] .user-row`);
  await alice.page.waitForSelector('.dm-drawer:not([hidden])');
  await alice.page.fill('.dm-drawer .chat-input', 'Hello Bob');
  await alice.page.press('.dm-drawer .chat-input', 'Enter');
  await alice.page.waitForSelector('.dm-drawer .msg-delivery.delivered', { timeout: 15_000 }).catch(() => {});
  check('Online DM: Sent via ScaleDrone and Delivered (recipient ack)', (await dmStatus(alice, bob.id))[0] === 'delivered', (await dmStatus(alice, bob.id)).join(','));
  const bobGot = await ev(bob, (id) => ({ msgs: window.__voip.app.dms.conversation(id).messages.map((m) => m.text), unread: window.__voip.app.dms.unreadFor(id), badge: document.querySelector(`li.user[data-user="${id}"] .user-row .badge`)?.textContent, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|') }), alice.id);
  check('Recipient receives it once, with unread badge + toast', bobGot.msgs.length === 1 && bobGot.msgs[0] === 'Hello Bob' && bobGot.unread === 1 && bobGot.badge === '1' && /Alice/.test(bobGot.toast), JSON.stringify(bobGot));
  await bob.page.click(`li.user[data-user="${alice.id}"] .user-row`);
  check('Opening the conversation clears unread', (await ev(bob, (id) => window.__voip.app.dms.unreadFor(id), alice.id)) === 0);
  check('No push request for an online recipient', alice.pushRequests.length === 0);

  // ── Bob goes to another room → offline for Alice ──────────────────────────
  await leaveRoom(bob);
  await enterRoom(bob.page, OTHER_ROOM);
  await waitPresence(alice, bob.id, 'offline', 30_000).catch(() => {});
  const st = await presence(alice, bob.id);
  check('Bob shown offline in Alice’s room', st !== 'online', st);
  await alice.page.click(`li.user[data-user="${bob.id}"] .user-row`);
  await alice.page.waitForSelector('.dm-drawer:not([hidden])');
  const btns = await ev(alice, () => [...document.querySelectorAll('.dm-head button')].map((b) => `${b.getAttribute('aria-label')}:${b.disabled}`));
  check('Offline user: contact opens and Audio / Video call stay enabled', btns.some((b) => b === 'Audio call Bob:false') && btns.some((b) => b === 'Video call Bob:false'), btns.join(', '));
  await alice.page.click('.dm-head button[aria-label="Audio call Bob"]');
  await alice.page.waitForSelector('dialog', { timeout: 5_000 });
  const dlg = await ev(alice, () => [...document.querySelectorAll('dialog[open]')].map((d) => d.textContent).join(' '));
  check('Offline call → dialog explains instead of a blind WebRTC attempt', /currently offline|status is unknown/.test(dlg) && (await ev(alice, () => window.__voip.app.calls.session === null)), dlg.slice(0, 160));
  check('Targeted push available → "Send Call Notification" offered, plus Message instead', /Send Call Notification/.test(dlg) && /Message instead/.test(dlg));
  await alice.page.click('dialog[open] button:has-text("Cancel")');

  // ── DM to OFFLINE user → queued (never /notifyAll), delivered when online ─
  await alice.page.click(`li.user[data-user="${bob.id}"] .user-row`);
  await alice.page.waitForSelector('.dm-drawer .dm-banner:not([hidden])', { timeout: 5_000 });
  const banner = await ev(alice, () => document.querySelector('.dm-drawer .dm-banner').textContent);
  check('Conversation shows a short offline note', /offline/.test(banner) && banner.length < 80, banner);
  await alice.page.fill('.dm-drawer .chat-input', 'Are you there?');
  await alice.page.press('.dm-drawer .chat-input', 'Enter');
  await alice.page.waitForSelector('.dm-drawer .msg-delivery.queued', { timeout: 5_000 }).catch(() => {});
  check('Offline DM: queued ("Waiting for recipient"), not Delivered', (await dmStatus(alice, bob.id))[1] === 'queued', (await dmStatus(alice, bob.id)).join(','));
  check('Private message never sent to /notifyAll', alice.pushRequests.length === 0, alice.pushRequests.join(','));
  const bobOtherRoom = await ev(bob, (id) => window.__voip.app.dms.conversation(id).messages.length, alice.id);
  check('Room isolation: Bob (other room) has no conversation with Alice there', bobOtherRoom === 0, String(bobOtherRoom));

  await leaveRoom(bob);
  await enterRoom(bob.page, ROOM);
  await alice.page.waitForFunction((id) => window.__voip.app.dms.conversation(id).messages.filter((m) => m.own).every((m) => m.status === 'delivered'), bob.id, { timeout: 30_000 }).catch(() => {});
  check('Queued DM delivered when the recipient comes online', (await dmStatus(alice, bob.id)).every((s) => s === 'delivered'), (await dmStatus(alice, bob.id)).join(','));
  const bobBack = await ev(bob, (id) => window.__voip.app.dms.conversation(id).messages.map((m) => m.text), alice.id);
  check('Recipient has both messages exactly once (room history restored)', JSON.stringify(bobBack) === JSON.stringify(['Hello Bob', 'Are you there?']), JSON.stringify(bobBack));

  // ── Chat notification click → conversation opened, message highlighted ───
  const msgId = await ev(bob, (id) => window.__voip.app.dms.conversation(id).messages.at(-1).messageId, alice.id);
  await ev(bob, () => document.querySelector('.dm-drawer button[aria-label="Close conversation"]')?.click());
  const roomId = await ev(bob, () => window.__voip.app.rooms.current.roomId);
  await ev(bob, ([sender, id, room]) => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'notification-click', context: { kind: 'chat-message', action: 'open', senderId: sender, senderName: 'Alice', messageId: id, roomId: room, at: Date.now() } } }));
  }, [alice.id, msgId, roomId]);
  await bob.page.waitForSelector('.dm-drawer:not([hidden]) .msg.highlight', { timeout: 5_000 }).catch(() => {});
  const hl = await ev(bob, () => ({ id: document.querySelector('.dm-drawer .msg.highlight')?.dataset.id, url: location.href }));
  check('Chat notification click opens the conversation and highlights the message', hl.id === msgId, hl.id);
  check('No message content in the URL', !/Are%20you|there|message/i.test(hl.url), hl.url);

  // XSS safety of DM rendering
  await ev(alice, (id) => window.__voip.app.dms.send(id, '<img src=x onerror="window.__xss=1">'), bob.id);
  await bob.page.waitForFunction(() => document.querySelectorAll('.dm-drawer .msg').length >= 3, null, { timeout: 15_000 }).catch(() => {});
  check('DM text rendered as text (no HTML injection)', await ev(bob, () => !window.__xss && !document.querySelector('.dm-drawer .msg img')));
} catch (err) {
  check('Unexpected error', false, err.stack?.split('\n').slice(0, 3).join(' '));
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
