/**
 * Rooms · call layouts · 1:1 → group conversion · live-stream audience control.
 * Real ScaleDrone, headless Chrome with fake media.   npm run dev  then  npm run test:rooms
 */
import { chromium } from 'playwright-core';

const URL = process.env.E2E_URL || 'http://localhost:5173/';
const OUT = new globalThis.URL('./artifacts/', import.meta.url).pathname;
const RUN = Date.now().toString(36);
const ROOM = `Team ${RUN}`;
const ROOM_B = `Other ${RUN}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const section = (t) => console.log(`\n── ${t}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
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
async function user(name, room = ROOM, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto(URL);
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  if (room) await enterRoom(page, room);
  return { name, ctx, page, id: await page.evaluate(() => window.__voip.app.identity.deviceId) };
}
const ev = (u, fn, arg) => u.page.evaluate(fn, arg);
const diag = (u) => ev(u, () => window.__voip.diagnostics());
const peersOf = async (u) => (await diag(u)).call?.peers ?? [];
const status = (u) => ev(u, () => window.__voip.app.calls.state?.status ?? null);
const waitOnline = (u, other) => u.page.waitForFunction((id) => window.__voip.app.presence.status(id) === 'online', other.id, { timeout: 30_000 });
const waitIdle = (u) => u.page.waitForFunction(() => window.__voip.app.calls.state === null, null, { timeout: 20_000 });
async function waitConnected(u, n, timeout = 40_000) {
  try {
    await u.page.waitForFunction((k) => (window.__voip.diagnostics().call?.peers ?? []).filter((p) => p.connectionState === 'connected').length >= k, n, { timeout });
  } catch {
    throw new Error(`${u.name} expected ${n} connected peers: ${JSON.stringify((await peersOf(u)).map((p) => `${p.peer}:${p.connectionState}`))}`);
  }
}
async function accept(u) {
  await u.page.waitForSelector('dialog.incoming button[aria-label=Accept]', { timeout: 20_000 });
  await u.page.click('dialog.incoming button[aria-label=Accept]');
}
const toasts = (u) => u.page.$$eval('.toast', (t) => t.map((x) => x.textContent));
const waitToast = (u, re, timeout = 15_000) =>
  u.page.waitForFunction((src) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent)), re.source, { timeout }).then(() => true, () => false);
const noOverflow = (u) => ev(u, () => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
const inViewport = (u, sel) =>
  ev(u, (s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return !!r && r.width > 0 && r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1;
  }, sel);
const subscriptions = (u) => ev(u, () => [...window.__voip.app.signaling['rooms'].keys()]);
async function setLayout(u, id) {
  const inline = await ev(u, () => !!document.querySelector('[data-ctrl=layout]')?.offsetParent);
  if (inline) await u.page.click('[data-ctrl=layout]');
  else {
    await u.page.click('[data-ctrl=more]');
    await u.page.click('[data-ctrl=menu-layout]');
  }
  await u.page.click(`.layout-option[data-layout=${id}]`);
  await u.page.waitForFunction((l) => document.querySelector('.video-stage')?.dataset.layout === l || document.querySelectorAll('.video-stage .tile').length <= 1, id, { timeout: 5_000 });
}
const bytesIn = async (u, peer) => (await peersOf(u)).find((p) => p.peer === peer)?.bytesReceived ?? 0;

try {
  // ═════════════════════════════════════ ROOMS ═════════════════════════════════════
  section('Rooms');
  const alice = await user('Alice', null);
  await alice.page.waitForSelector('#room-name', { timeout: 20_000 });
  check('First load always asks for a room', await ev(alice, () => !!document.querySelector('#room-name') && window.__voip.app.rooms.current === null));
  await alice.page.fill('#room-name', 'bad/name');
  const invalid = await ev(alice, () => ({ err: document.querySelector('#room-error').textContent, disabled: document.querySelector('.room-screen button[type=submit]').disabled }));
  check('Invalid room name rejected (message + Join disabled)', invalid.disabled && invalid.err.length > 0, invalid.err);
  await alice.page.fill('#room-name', '   ');
  check('Empty room name cannot join', await ev(alice, () => document.querySelector('.room-screen button[type=submit]').disabled));
  await enterRoom(alice.page, `  ${ROOM.replace(' ', '   ')}  `); // messy spacing → same normalised room
  await alice.page.waitForSelector('.room-chip strong', { timeout: 10_000 });
  check('Room shown in UI (name normalised)', (await ev(alice, () => document.querySelector('.room-chip strong')?.textContent)) === ROOM);

  const bob = await user('Bob');
  const zara = await user('Zara', ROOM_B);
  await waitOnline(alice, bob);
  await zara.page.waitForTimeout(2000);
  check('Same room: users see each other', (await ev(bob, () => window.__voip.app.presence.list().map((u) => u.name))).includes('Alice'));
  check('Room isolation: other room invisible', !(await ev(alice, () => window.__voip.app.presence.list().map((u) => u.name))).includes('Zara') && !(await ev(zara, () => window.__voip.app.presence.list().map((u) => u.name))).some((n) => n === 'Alice' || n === 'Bob'));
  check('Room subscriptions = lobby + inbox only', (await subscriptions(alice)).length === 2, (await subscriptions(alice)).join(', '));

  // Cross-room: Zara (room B) calls Alice by deviceId, and forges a message straight into Alice's room inbox.
  await ev(zara, (id) => window.__voip.app.calls.startDirectCall(id, 'audio'), alice.id);
  const aliceKey = await ev(alice, () => window.__voip.app.rooms.current.roomKey);
  await ev(zara, ([id, key]) => {
    const s = window.__voip.app.signaling;
    s['drone'].publish({
      room: `inbox-${key}-${id}`,
      message: { v: 2, messageType: 'call-invite', messageId: crypto.randomUUID(), timestamp: Date.now(), senderId: window.__voip.app.identity.deviceId, senderSessionId: 'forged', senderName: 'Zara', receiverId: id, roomId: 'some-other-room', callId: crypto.randomUUID(), peerId: 'x', payload: { callKind: 'direct', media: 'audio', hostId: 'x', expiresAt: Date.now() + 60000 } },
    });
  }, [alice.id, aliceKey]);
  await alice.page.waitForTimeout(4000);
  check('Cross-room call/signaling never reaches the other room', !(await alice.page.$('dialog.incoming')) && (await status(alice)) === null);
  await zara.page.waitForFunction(() => ['failed', null].includes(window.__voip.app.calls.state?.status ?? null), null, { timeout: 15_000 });
  check('Caller in the other room sees "offline"', true);

  await bob.page.reload();
  check('Refresh reopens the active room automatically', await bob.page.waitForFunction((r) => window.__voip?.app.rooms.current?.roomName === r && window.__voip.app.signaling.status === 'connected', ROOM, { timeout: 30_000 }).then(() => true, () => false));

  await alice.page.click('.room-chip button[aria-label="Leave room"]');
  await alice.page.waitForSelector('#room-name');
  check('Leave room → room screen, no stale subscriptions/state', (await subscriptions(alice)).length === 0 && (await ev(alice, () => window.__voip.app.presence.list().length === 0 && window.__voip.app.rooms.current === null)));
  await bob.page.waitForFunction((id) => window.__voip.app.presence.status(id) === 'offline', alice.id, { timeout: 20_000 }).then(() => check('Others see the leaver offline', true), () => check('Others see the leaver offline', false));
  await enterRoom(alice.page, ROOM_B);
  await alice.page.waitForTimeout(2500);
  const inB = await ev(alice, () => window.__voip.app.presence.list().filter((u) => u.status === 'online').map((u) => u.name));
  check('Join a different room: only that room\'s users', inB.includes('Zara') && !inB.includes('Bob'), inB.join(','));
  await alice.page.click('.room-chip button[aria-label="Leave room"]');
  await enterRoom(alice.page, ROOM);
  await waitOnline(alice, bob);

  // ═════════════════════════ LAYOUTS + 1:1 → GROUP ═════════════════════════════
  section('Layouts and 1:1 → group');
  const carol = await user('Carol');
  const dave = await user('Dave');
  const eve = await user('Eve');
  const frank = await user('Frank');
  for (const u of [bob, carol, dave, eve, frank]) await waitOnline(alice, u);

  await ev(alice, (id) => window.__voip.app.calls.startDirectCall(id, 'video'), bob.id);
  await accept(bob);
  await Promise.all([waitConnected(alice, 1), waitConnected(bob, 1)]);
  await alice.page.waitForFunction(() => document.querySelector('.tile:not(.local)')?.classList.contains('has-video'), null, { timeout: 15_000 });
  const pcBefore = (await peersOf(alice))[0].pcId;
  await ev(alice, () => document.querySelectorAll('video').forEach((v, i) => (v.__tag = `v${i}`)));
  for (const l of ['speaker', 'spotlight', 'sidebar', 'filmstrip', 'grid']) {
    const b0 = await bytesIn(alice, 'Bob');
    await setLayout(alice, l);
    await alice.page.waitForTimeout(2200);
    const same = await ev(alice, () => [...document.querySelectorAll('video')].every((v) => !!v.__tag));
    const p = (await peersOf(alice))[0];
    check(`Layout "${l}" (2 people): UI-only – same RTCPeerConnection & <video>, media flowing`, p.pcId === pcBefore && same && (await bytesIn(alice, 'Bob')) > b0);
  }

  await setLayout(alice, 'speaker');
  await alice.page.click('[data-ctrl=invite]');
  await alice.page.waitForSelector(`dialog input[data-user="${carol.id}"]`);
  await alice.page.check(`dialog input[data-user="${carol.id}"]`);
  await alice.page.click('dialog .modal-actions .btn.primary');
  await accept(carol);
  await Promise.all([waitConnected(alice, 2), waitConnected(bob, 2), waitConnected(carol, 2)]);
  const afterAdd = await peersOf(alice);
  check('1:1 → group: full mesh (A↔B, A↔C, B↔C)', true);
  check('Existing A↔B connection kept (same pcId, not renegotiated from scratch)', afterAdd.find((p) => p.peer === 'Bob')?.pcId === pcBefore);
  check('Call converted to group on both original participants', (await ev(alice, () => window.__voip.app.calls.state.kind)) === 'group' && (await ev(bob, () => window.__voip.app.calls.state.kind)) === 'group');
  for (const u of [alice, carol]) await u.page.waitForFunction(() => window.__voip.diagnostics().call.peers.every((p) => p.connectionType), null, { timeout: 10_000 });
  check('New participant links follow P2P-first (host → host)', (await peersOf(carol)).every((p) => p.connectionType === 'P2P'), (await peersOf(carol)).map((p) => p.selectedCandidate).join(', '));

  check('Duplicate participant ignored', (await ev(alice, (id) => window.__voip.app.calls.addParticipants([id]), carol.id)).length === 0 && (await waitToast(alice, /already in the call/)));

  await ev(alice, (id) => window.__voip.app.calls.addParticipants([id]), dave.id);
  await dave.page.waitForSelector('dialog.incoming button[aria-label=Decline]', { timeout: 20_000 });
  await dave.page.click('dialog.incoming button[aria-label=Decline]');
  check('Participant rejects invitation → inviter informed, call unaffected', (await waitToast(alice, /Dave declined/)) && (await peersOf(alice)).length === 2);

  await frank.page.click('.room-chip button[aria-label="Leave room"]');
  await alice.page.waitForFunction((id) => window.__voip.app.presence.status(id) === 'offline', frank.id, { timeout: 20_000 });
  await ev(alice, (id) => window.__voip.app.calls.addParticipants([id]), frank.id);
  check('Offline participant → "appears to be offline"', await waitToast(alice, /Frank appears to be offline/, 15_000));

  const callId = await ev(alice, () => window.__voip.app.calls.state.callId);
  await ev(eve, ([cid, me]) => {
    const s = window.__voip.app.signaling;
    s.broadcast(`mesh-${cid}`, 'call-participants-added', { participantIds: [me] }, { callId: cid });
    s.broadcast(`mesh-${cid}`, 'mesh-join', { role: 'participant', callKind: 'group', media: { audioMuted: false, videoMuted: false, screenSharing: false } }, { callId: cid });
  }, [callId, eve.id]);
  await alice.page.waitForTimeout(4000);
  const leaked = (await Promise.all([alice, bob, carol].map((u) => ev(u, (id) => window.__voip.app.calls.state.participants.has(id), eve.id)))).some(Boolean);
  check('Non-participant cannot add itself / join uninvited (no peer connection)', !leaked);

  // Grow to 5 participants: Eve and Dave (legitimately) join.
  await ev(alice, (ids) => window.__voip.app.calls.addParticipants(ids), [eve.id]);
  await accept(eve);
  await ev(bob, (id) => window.__voip.app.calls.addParticipants([id]), dave.id); // any participant may add
  await accept(dave);
  await Promise.all([alice, bob, carol, dave, eve].map((u) => waitConnected(u, 4, 60_000)));
  check('5 participants in a full mesh (each has 4 links; added by different participants)', true);

  for (const [label, vp] of [['desktop', { width: 1440, height: 900 }], ['tablet', { width: 820, height: 1180 }], ['mobile', { width: 390, height: 844 }]]) {
    await alice.page.setViewportSize(vp);
    for (const l of ['grid', 'speaker', 'spotlight', 'sidebar', 'filmstrip']) {
      await setLayout(alice, l);
      await alice.page.waitForTimeout(250);
      const shape = await ev(alice, () => ({
        main: document.querySelectorAll('.lay-main .tile').length,
        strip: document.querySelectorAll('.lay-strip .tile').length,
        dir: getComputedStyle(document.querySelector('.lay-strip')).flexDirection,
      }));
      const okShape = l === 'grid' ? shape.main === 5 && shape.strip === 0 : shape.main === 1 && shape.strip === 4;
      const okSidebar = l !== 'sidebar' || (label === 'mobile' ? shape.dir === 'row' : shape.dir === 'column');
      const ok = okShape && okSidebar && (await noOverflow(alice)) && (await inViewport(alice, '.lay-main .tile')) && (await inViewport(alice, '[data-ctrl=end]'));
      check(`${label} · ${l} (5 people): layout, no h-scroll, main video + controls visible`, ok, JSON.stringify(shape));
      if (l === 'sidebar' || l === 'speaker') await alice.page.screenshot({ path: `${OUT}layout-${label}-${l}.png` });
    }
  }
  await alice.page.setViewportSize({ width: 1440, height: 900 });
  await setLayout(alice, 'speaker');
  // Chrome's fake microphone is a short beep once per second, so give detection a few seconds.
  await alice.page.waitForFunction(() => !!window.__voip.app.calls.session?.activeSpeaker, null, { timeout: 15_000 }).catch(() => {});
  const speakers = [];
  for (let i = 0; i < 16; i++) {
    speakers.push(await ev(alice, () => window.__voip.app.calls.session?.activeSpeaker ?? null));
    await alice.page.waitForTimeout(250);
  }
  const switches = speakers.filter((s, i) => i && s !== speakers[i - 1]).length;
  check('Active speaker detected from WebRTC audio levels, no rapid flipping', speakers.some(Boolean) && switches <= 2, `speakers=${[...new Set(speakers)].length} switches=${switches}`);
  const stripId = await ev(alice, () => document.querySelector('.lay-strip .tile:not(.local)')?.dataset.id);
  await alice.page.click(`.lay-strip .tile[data-id="${stripId}"]`);
  await alice.page.waitForTimeout(1500);
  check('Manual spotlight (pin) overrides the active speaker', (await ev(alice, () => document.querySelector('.lay-main .tile')?.dataset.id)) === stripId);
  await alice.page.click(`.lay-main .tile[data-id="${stripId}"]`); // click again → unpin

  await ev(carol, () => window.__voip.app.calls.hangup());
  await alice.page.waitForFunction(() => window.__voip.diagnostics().call.peers.length === 3, null, { timeout: 15_000 });
  check('Participant leaves: only their links close', (await peersOf(alice)).every((p) => p.connectionState === 'connected') && (await peersOf(bob)).length === 3);
  const eveGen = (await peersOf(alice)).find((p) => p.peer === 'Eve').generation;
  await eve.page.reload();
  await enterRoom(eve.page, ROOM);
  await eve.page.click('.banner button.primary');
  await waitConnected(eve, 3, 60_000);
  await alice.page.waitForFunction((g) => (window.__voip.diagnostics().call.peers.find((p) => p.peer === 'Eve')?.generation ?? -1) > g && window.__voip.diagnostics().call.peers.find((p) => p.peer === 'Eve').connectionType, eveGen, { timeout: 20_000 });
  check('Participant rejoins → fresh peer connection, P2P again', (await peersOf(alice)).find((p) => p.peer === 'Eve').connectionType === 'P2P');
  await Promise.all([alice, bob, dave, eve].map((u) => ev(u, () => window.__voip.app.calls.hangup())));
  await Promise.all([alice, bob, carol, dave, eve].map(waitIdle));

  // ═══════════════════════════════ LIVE AUDIENCE ═══════════════════════════════
  section('Live stream audience');
  await alice.page.click('.sidebar-actions button:nth-child(2)'); // Go live
  await alice.page.fill('dialog input[type=text]', 'Town hall');
  await alice.page.click('dialog .modal-actions .btn.primary');
  for (const u of [bob, carol]) {
    await u.page.waitForSelector('.stream-list .stream button:not([disabled])', { timeout: 20_000 });
    await u.page.click('.stream-list .stream button');
  }
  await waitConnected(alice, 2);
  await alice.page.click('[data-ctrl=people]');
  await alice.page.waitForTimeout(4500);
  const aud = await ev(alice, () => ({
    total: document.querySelector('.upload-total strong')?.textContent,
    rows: [...document.querySelectorAll('.audience-list li')].map((li) => `${li.querySelector('.grow').firstChild.textContent}|${li.dataset.status}|${li.querySelector('.viewer-rate')?.textContent ?? ''}`),
  }));
  check('Everyone mode: all room viewers stream', aud.rows.filter((r) => r.includes('|streaming|')).length === 2, aud.rows.join(' ; '));
  check('Streamer sees measured upload per viewer + total', /bps/.test(aud.total ?? '') && aud.rows.filter((r) => /bps/.test(r.split('|')[2])).length === 2, `total=${aud.total}`);
  await alice.page.screenshot({ path: `${OUT}live-audience-desktop.png` });
  await ev(alice, () => window.__voip.app.calls.hangup());
  await bob.page.waitForFunction(() => ['ended', null].includes(window.__voip.app.calls.state?.status ?? null), null, { timeout: 15_000 });
  check('Streamer stops → viewers see stream ended', true);
  await Promise.all([alice, bob, carol].map(waitIdle));

  await ev(alice, (id) => window.__voip.app.live.goLive('Private', { mode: 'selected', viewerIds: [id] }), bob.id);
  await bob.page.waitForSelector('dialog .btn.primary', { timeout: 20_000 });
  check('Selected viewer is invited', (await ev(bob, () => document.querySelector('dialog .incoming-text')?.textContent ?? '')).includes('Private'));
  await bob.page.click('dialog .btn.primary'); // Watch
  await waitConnected(alice, 1);
  const streamId = await ev(alice, () => window.__voip.app.calls.state.callId);
  await carol.page.waitForTimeout(1500);
  check('Unselected user does not see the private stream', (await ev(carol, () => window.__voip.app.live.list().length)) === 0);
  await ev(carol, ([sid, host]) => window.__voip.app.calls.joinLive(sid, { deviceId: host, name: 'Alice' }, 'x'), [streamId, alice.id]);
  await carol.page.waitForFunction(() => ['failed', null].includes(window.__voip.app.calls.state?.status ?? null), null, { timeout: 15_000 }).catch(() => {});
  const carolIn = (await peersOf(alice)).some((p) => p.peer === 'Carol');
  check('Unselected user forcing a join is refused – no media connection', !carolIn && (await ev(carol, () => window.__voip.app.calls.state?.status ?? null)) !== 'connected');
  await Promise.all([waitIdle(carol)]);

  const bobPc = (await peersOf(alice)).find((p) => p.peer === 'Bob').pcId;
  await alice.page.click('[data-ctrl=audience]');
  await alice.page.check(`dialog input[data-user="${carol.id}"]`);
  await alice.page.click('dialog .modal-actions .btn.primary'); // Update Audience
  await carol.page.waitForSelector('dialog .btn.primary', { timeout: 20_000 });
  await carol.page.click('dialog .btn.primary');
  await waitConnected(alice, 2);
  await carol.page.waitForFunction(() => !!window.__voip.diagnostics().call?.peers[0]?.connectionType, null, { timeout: 10_000 });
  check('Viewer added during stream connects (P2P) without touching others', (await peersOf(alice)).find((p) => p.peer === 'Bob').pcId === bobPc && (await peersOf(carol))[0]?.connectionType === 'P2P');

  const carolPc = (await peersOf(alice)).find((p) => p.peer === 'Carol').pcId;
  await ev(alice, (id) => window.__voip.app.live.updateAudience('selected', [id]), carol.id);
  await bob.page.waitForFunction(() => /removed/i.test(window.__voip.app.calls.state?.statusDetail ?? '') || window.__voip.app.calls.state === null, null, { timeout: 15_000 });
  await alice.page.waitForTimeout(1000);
  const afterRemove = await peersOf(alice);
  check('Removed viewer stops receiving (connection closed); others untouched', !afterRemove.some((p) => p.peer === 'Bob') && afterRemove.find((p) => p.peer === 'Carol')?.pcId === carolPc);
  await waitIdle(bob);
  await ev(bob, ([sid, host]) => window.__voip.app.calls.joinLive(sid, { deviceId: host, name: 'Alice' }, 'x'), [streamId, alice.id]);
  await bob.page.waitForTimeout(5000);
  check('Removed viewer reconnecting is refused', !(await peersOf(alice)).some((p) => p.peer === 'Bob'));
  const stViewer = await ev(alice, () => [...(window.__voip.app.live.state?.viewers.values() ?? [])].map((v) => `${v.name}:${v.status}:${v.allowed}`));
  check('Viewer state model (allowed / streaming / not selected)', stViewer.includes('Carol:streaming:true') && stViewer.includes('Bob:not-selected:false'), stViewer.join(', '));

  const carolGen = (await peersOf(alice)).find((p) => p.peer === 'Carol').generation;
  await carol.page.reload();
  await enterRoom(carol.page, ROOM);
  // live-viewer-left is sent on page unload (best effort); ICE consent expiry is the fallback.
  await alice.page.waitForFunction((id) => window.__voip.app.live.state?.viewers.get(id)?.status !== 'streaming', carol.id, { timeout: 15_000 }).catch(() => {});
  const whileGone = await ev(alice, (id) => window.__voip.app.live.state?.viewers.get(id)?.status, carol.id);
  await carol.page.waitForSelector('.stream-list .stream button:not([disabled])', { timeout: 25_000 });
  await carol.page.click('.stream-list .stream button');
  await alice.page.waitForFunction(([g]) => { const p = window.__voip.diagnostics().call.peers.find((x) => x.peer === 'Carol'); return p && p.connectionState === 'connected' && p.generation > g && !!p.connectionType; }, [carolGen], { timeout: 30_000 });
  check('Viewer disconnect is reflected promptly (not "streaming")', whileGone !== 'streaming', `state while gone: ${whileGone}`);
  check('Viewer reconnects → re-authorised, fresh P2P connection', (await peersOf(alice)).find((p) => p.peer === 'Carol').connectionType === 'P2P');

  await alice.page.setViewportSize({ width: 390, height: 844 });
  await alice.page.click('[data-ctrl=more]');
  await alice.page.click('[data-ctrl=menu-audience]'); // "Manage" in the More menu
  await alice.page.waitForSelector('dialog .audience-fieldset');
  check('Mobile: audience selector is a usable bottom sheet', (await inViewport(alice, 'dialog .modal-actions .btn.primary')) && (await noOverflow(alice)));
  await alice.page.screenshot({ path: `${OUT}live-audience-mobile.png` });
  await alice.page.keyboard.press('Escape');
  await ev(alice, () => window.__voip.app.calls.hangup());
  await carol.page.waitForFunction(() => ['ended', null].includes(window.__voip.app.calls.state?.status ?? null), null, { timeout: 15_000 });
  check('Streamer stops private stream → viewer sees ended', true);
  void toasts;
} catch (err) {
  check('Rooms run', false, `${err.message.split('\n')[0]} @ ${(err.stack ?? '').split('\n').find((l) => l.includes('rooms.mjs')) ?? ''}`);
} finally {
  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
