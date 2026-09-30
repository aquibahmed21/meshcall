/**
 * PiP / Fullscreen / Chat end-to-end tests (real ScaleDrone, headless Chrome, fake media).
 *   npm run dev   then   npm run test:features
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
const OUT = new globalThis.URL('./artifacts/', import.meta.url).pathname;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: process.env.HEADLESS !== '0',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

async function user(name, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto(URL);
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  await enterRoom(page);
  await page.waitForFunction(() => window.__voip?.app.signaling.status === 'connected', null, { timeout: 30_000 });
  return { name, ctx, page, id: await page.evaluate(() => window.__voip.app.identity.deviceId) };
}

const waitConnected = (u, n = 1) =>
  u.page.waitForFunction((k) => (window.__voip.diagnostics().call?.peers ?? []).filter((p) => p.connectionState === 'connected').length >= k, n, { timeout: 40_000 });
const waitIdle = (u) => u.page.waitForFunction(() => window.__voip.app.calls.state === null, null, { timeout: 20_000 });
const accept = async (u) => {
  await u.page.waitForSelector('dialog.incoming button[aria-label=Accept]', { timeout: 20_000 });
  await u.page.click('dialog.incoming button[aria-label=Accept]');
};
const pipState = (u) =>
  u.page.evaluate(() => {
    const el = document.pictureInPictureElement;
    const tile = el?.closest?.('.tile');
    const btn = document.querySelector('[data-ctrl=pip]');
    return { active: !!el, tileId: tile?.dataset.id ?? null, label: btn?.getAttribute('aria-label') ?? null, pressed: btn?.getAttribute('aria-pressed') };
  });
const fsState = (u) =>
  u.page.evaluate(() => {
    const btn = document.querySelector('[data-ctrl=fs]');
    return {
      active: document.fullscreenElement?.classList.contains('call') ?? false,
      label: btn?.getAttribute('aria-label') ?? null,
      layout: document.querySelector('.video-stage')?.dataset.layout ?? null,
      appFullscreen: document.fullscreenElement === document.documentElement,
    };
  });
const chatTexts = (u) => u.page.$$eval('.chat-list .msg', (els) => els.map((e) => `${e.querySelector('.msg-name').textContent}: ${e.querySelector('.msg-text').textContent}`));
const unreadBadge = (u) => u.page.evaluate(() => document.querySelector('[data-ctrl=chat] .badge')?.textContent ?? null);
const openChat = async (u) => {
  const open = await u.page.evaluate(() => !document.querySelector('.call-panel')?.hidden && document.querySelector('.panel-tab[aria-selected=true]')?.textContent === 'Chat');
  if (!open) await u.page.click('[data-ctrl=chat]');
  await u.page.waitForSelector('.chat-input:not([disabled])', { timeout: 10_000 });
};
const send = async (u, text) => {
  await u.page.fill('.chat-input', text);
  await u.page.press('.chat-input', 'Enter');
};
const noOverflow = (u) => u.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
const inViewport = (u, sel) =>
  u.page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return !!r && r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.left >= 0 && r.right <= window.innerWidth + 1;
  }, sel);

try {
  const alice = await user('Alice');
  const bob = await user('Bob');
  await alice.page.waitForFunction((id) => window.__voip.app.presence.status(id) === 'online', bob.id, { timeout: 30_000 });

  await alice.page.evaluate((id) => window.__voip.app.calls.startDirectCall(id, 'video'), bob.id);
  await accept(bob);
  await Promise.all([waitConnected(alice), waitConnected(bob)]);
  await alice.page.waitForFunction(() => document.querySelector('.tile:not(.local)')?.classList.contains('has-video'), null, { timeout: 15_000 });

  // ── PiP ──────────────────────────────────────────────────────────────────
  check('PiP + Fullscreen + Chat controls rendered', await alice.page.$('[data-ctrl=pip]') && await alice.page.$('[data-ctrl=fs]') && await alice.page.$('[data-ctrl=chat]'));
  let s = await pipState(alice);
  check('PiP button starts as "Enter PiP"', s.label === 'Enter PiP' && s.pressed === 'false');
  await alice.page.click('[data-ctrl=pip]');
  await alice.page.waitForFunction(() => !!document.pictureInPictureElement, null, { timeout: 5_000 });
  await alice.page.waitForFunction(() => document.querySelector('[data-ctrl=pip]')?.getAttribute('aria-label') === 'Exit PiP');
  s = await pipState(alice);
  check('Enter PiP uses the EXISTING remote tile <video> (main participant)', s.active && s.tileId === bob.id, `tile=${s.tileId?.slice(0, 8)} label=${s.label}`);
  check('Tile shows "Playing in picture-in-picture" placeholder', await alice.page.evaluate(() => !!document.querySelector('.tile.in-pip')));
  const streamsBefore = await alice.page.evaluate(() => document.querySelectorAll('video').length);

  await alice.page.click('.tile.local');
  await alice.page.waitForFunction(() => document.pictureInPictureElement?.closest('.tile')?.classList.contains('local'), null, { timeout: 5_000 }).catch(() => {});
  s = await pipState(alice);
  check('Selecting another participant moves PiP to that video (local)', s.tileId === 'local', `now ${s.tileId}`);
  check('No extra <video>/stream created for PiP', (await alice.page.evaluate(() => document.querySelectorAll('video').length)) === streamsBefore);

  await alice.page.click('[data-ctrl=pip]');
  await alice.page.waitForFunction(() => !document.pictureInPictureElement, null, { timeout: 5_000 });
  s = await pipState(alice);
  check('Exit PiP via control', !s.active && s.label === 'Enter PiP');

  await alice.page.click(`.tile[data-id="${bob.id}"]`);
  await alice.page.click('[data-ctrl=pip]');
  await alice.page.waitForFunction(() => !!document.pictureInPictureElement);
  await alice.page.evaluate(() => document.exitPictureInPicture()); // what the browser does when the user closes the PiP window
  await alice.page.waitForFunction(() => document.querySelector('[data-ctrl=pip]')?.getAttribute('aria-label') === 'Enter PiP', null, { timeout: 5_000 });
  check('User closing the PiP window resyncs the UI (leavepictureinpicture)', true);

  // ── Fullscreen ───────────────────────────────────────────────────────────
  await alice.page.click('[data-ctrl=fs]');
  await alice.page.waitForFunction(() => !!document.fullscreenElement && document.querySelector('[data-ctrl=fs]')?.getAttribute('aria-label') === 'Exit fullscreen', null, { timeout: 5_000 });
  let f = await fsState(alice);
  check('Fullscreen targets the call container (not the whole app)', f.active && !f.appFullscreen, `label=${f.label}`);
  check('Fullscreen shows the call layout (video stage + tiles inside the fullscreen element)', await alice.page.evaluate(() => !!document.fullscreenElement?.querySelector('.video-stage .tile')), `layout=${f.layout}`);
  check('Controls remain visible in fullscreen', await inViewport(alice, '[data-ctrl=end]'));
  await alice.page.screenshot({ path: `${OUT}features-fullscreen.png` });

  await alice.page.click('.tile.local');
  check('Switching participants in fullscreen', await alice.page.evaluate(() => document.querySelector('.tile.selected')?.classList.contains('local')) && (await fsState(alice)).active);

  // Fullscreen + Chat
  await openChat(alice);
  check('Chat panel usable inside fullscreen', await inViewport(alice, '.chat-input'));

  // Fullscreen → PiP
  await alice.page.click(`.tile[data-id="${bob.id}"]`);
  await alice.page.click('[data-ctrl=pip]');
  await alice.page.waitForFunction(() => !!document.pictureInPictureElement, null, { timeout: 5_000 }).catch(() => {});
  s = await pipState(alice);
  f = await fsState(alice);
  check('Fullscreen → PiP: UI matches browser state', s.active === (s.label === 'Exit PiP') && f.active === (f.label === 'Exit fullscreen'), `pip=${s.active} fs=${f.active}`);

  await alice.page.keyboard.press('Escape');
  await alice.page.waitForTimeout(500);
  if (await alice.page.evaluate(() => !!document.fullscreenElement)) await alice.page.evaluate(() => document.exitFullscreen()); // headless may not map ESC
  await alice.page.waitForFunction(() => !document.fullscreenElement, null, { timeout: 5_000 });
  await alice.page.waitForFunction(() => document.querySelector('[data-ctrl=fs]')?.getAttribute('aria-label') === 'Fullscreen', null, { timeout: 3_000 }).catch(() => {});
  f = await fsState(alice);
  check('Leaving fullscreen (ESC / exit) resyncs UI (fullscreenchange)', !f.active && f.label === 'Fullscreen');

  // PiP → Fullscreen
  if (!(await pipState(alice)).active) {
    await alice.page.click('[data-ctrl=pip]');
    await alice.page.waitForFunction(() => !!document.pictureInPictureElement);
  }
  await alice.page.click('[data-ctrl=fs]');
  await alice.page.waitForFunction(() => !!document.fullscreenElement, null, { timeout: 5_000 });
  s = await pipState(alice);
  f = await fsState(alice);
  check('PiP → Fullscreen: both states consistent with browser', f.active && s.active === (s.label === 'Exit PiP'), `pip=${s.active} fs=${f.active}`);

  // ── Chat ─────────────────────────────────────────────────────────────────
  await send(alice, 'Hello Bob');
  await bob.page.waitForFunction(() => document.querySelector('[data-ctrl=chat] .badge')?.textContent === '1', null, { timeout: 10_000 });
  check('Unread badge on receiver while chat closed', (await unreadBadge(bob)) === '1');
  check('No unread badge for own message', (await unreadBadge(alice)) === null);
  await openChat(bob);
  let texts = await chatTexts(bob);
  check('1:1 message delivered with sender name', texts.includes('Alice: Hello Bob'), texts.join(' | '));
  check('Opening chat clears unread', (await unreadBadge(bob)) === null);
  await alice.page.waitForFunction(() => !document.querySelector('.msg.own .msg-delivery'), null, { timeout: 10_000 });
  check('Own message shown as "You" and confirmed (echo)', (await chatTexts(alice)).includes('You: Hello Bob'));

  await bob.page.fill('.chat-input', 'line one');
  await bob.page.press('.chat-input', 'Shift+Enter');
  await bob.page.type('.chat-input', 'line two');
  const draft = await bob.page.inputValue('.chat-input');
  check('Shift+Enter inserts a newline instead of sending', draft === 'line one\nline two');
  await bob.page.press('.chat-input', 'Enter');
  await alice.page.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some((e) => e.textContent === 'line one\nline two'), null, { timeout: 10_000 });
  check('Multi-line message delivered intact', true);

  const before = (await chatTexts(bob)).length;
  await bob.page.fill('.chat-input', '     ');
  await bob.page.press('.chat-input', 'Enter');
  check('Empty / whitespace message not sent, Send disabled', (await chatTexts(bob)).length === before && (await bob.page.$eval('.chat-send', (b) => b.disabled)));

  const long = 'Long message. '.repeat(110).trim();
  await send(bob, long);
  await alice.page.waitForFunction((n) => [...document.querySelectorAll('.msg-text')].some((e) => e.textContent.length === n), long.length, { timeout: 10_000 });
  check('Long message (1.5k chars) delivered and wraps without horizontal overflow', await noOverflow(alice));

  for (const t of ['one', 'two', 'three']) await send(alice, t);
  await bob.page.waitForFunction(() => document.querySelectorAll('.chat-list .msg').length >= 6, null, { timeout: 10_000 });
  texts = await chatTexts(bob);
  check('Multiple messages arrive in order', texts.slice(-3).join(',') === 'Alice: one,Alice: two,Alice: three', texts.slice(-3).join(' | '));

  // duplicates + out-of-order + stale call (injected straight into the signaling bus)
  await bob.page.evaluate(({ from }) => {
    const { app } = window.__voip;
    const callId = app.calls.state.callId;
    const base = { v: 1, messageType: 'chat-message', senderId: from, senderSessionId: 'x', senderName: 'Alice', receiverId: '*', peerId: 'x' };
    const now = Date.now();
    const emit = (m) => app.signaling.events.emit('message', { room: `mesh-${callId}`, msg: m });
    emit({ ...base, messageId: 'late-2', timestamp: now + 2000, callId, payload: { text: 'ooo-second' } });
    emit({ ...base, messageId: 'late-1', timestamp: now + 1000, callId, payload: { text: 'ooo-first' } });
    emit({ ...base, messageId: 'late-2', timestamp: now + 2000, callId, payload: { text: 'ooo-second' } });
    emit({ ...base, messageId: 'stale', timestamp: now, callId: 'some-other-call', payload: { text: 'from another call' } });
  }, { from: alice.id });
  await bob.page.waitForTimeout(300);
  texts = await chatTexts(bob);
  check('Out-of-order messages sorted by timestamp', texts.indexOf('Alice: ooo-first') < texts.indexOf('Alice: ooo-second'));
  check('Duplicate messageId shown once', texts.filter((t) => t === 'Alice: ooo-second').length === 1);
  check('Message with another callId ignored', !texts.some((t) => t.includes('from another call')));

  // Signaling disconnect / reconnect: chat degrades, call survives
  const during = await bob.page.evaluate(() => {
    window.__voip.app.signaling.reconnectNow('e2e');
    const i = document.querySelector('.chat-input');
    return { disabled: i.disabled, placeholder: i.placeholder, status: document.querySelector('.chat-status')?.textContent };
  });
  check('Signaling down → chat disabled with "Connecting…"', during.disabled && during.placeholder === 'Connecting…', JSON.stringify(during));
  await bob.page.waitForFunction(() => window.__voip.app.signaling.status === 'connected', null, { timeout: 30_000 });
  await bob.page.waitForSelector('.chat-input:not([disabled])');
  check('Signaling back → chat enabled; WebRTC call unaffected', (await bob.page.evaluate(() => window.__voip.app.calls.state.status)) === 'connected');
  await send(bob, 'after reconnect');
  await alice.page.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some((e) => e.textContent === 'after reconnect'), null, { timeout: 15_000 });
  check('Messaging works after signaling reconnect', true);

  // Call ends while PiP + fullscreen are active
  s = await pipState(alice);
  f = await fsState(alice);
  await alice.page.click('[data-ctrl=end]');
  await alice.page.waitForFunction(() => !document.pictureInPictureElement && !document.fullscreenElement, null, { timeout: 5_000 });
  check('Call end exits PiP and fullscreen', true, `were pip=${s.active} fs=${f.active}`);
  await Promise.all([waitIdle(alice), waitIdle(bob)]);
  check('Chat state cleared after call', await alice.page.evaluate(() => window.__voip.app.chat.messages.length === 0 && window.__voip.app.chat.boundCallId === null && window.__voip.app.chat.unread === 0));

  // ── Group chat ───────────────────────────────────────────────────────────
  const carol = await user('Carol');
  await alice.page.waitForFunction((id) => window.__voip.app.presence.status(id) === 'online', carol.id, { timeout: 30_000 });
  await alice.page.evaluate(([b, c]) => window.__voip.app.groups.create([b, c], 'video', 'Chat test'), [bob.id, carol.id]);
  await accept(bob);
  await accept(carol);
  await Promise.all([alice, bob, carol].map((u) => waitConnected(u, 2)));
  check('New call starts with a clean chat', (await bob.page.evaluate(() => window.__voip.app.chat.messages.length)) === 0);
  for (const [u, text] of [[alice, 'Hello everyone'], [bob, 'Hi Alice'], [carol, 'Hi!']]) {
    await openChat(u);
    await send(u, text);
    await u.page.waitForTimeout(150);
  }
  await Promise.all([alice, bob, carol].map((u) => u.page.waitForFunction(() => document.querySelectorAll('.chat-list .msg').length >= 3, null, { timeout: 15_000 })));
  const g = await Promise.all([alice, bob, carol].map(chatTexts));
  check('Group: every participant has all 3 messages', g.every((t) => t.length === 3), g.map((t) => t.join(' / ')).join(' || '));
  check('Group: own vs remote labelling', g[2].includes('You: Hi!') && g[0].includes('Carol: Hi!'));

  // Participant rejoins + chat
  await carol.page.reload();
  await enterRoom(carol.page);
  await carol.page.click('.banner button.primary');
  await waitConnected(carol, 2);
  await openChat(carol);
  await send(alice, 'welcome back');
  await carol.page.waitForFunction(() => [...document.querySelectorAll('.msg-text')].some((e) => e.textContent === 'welcome back'), null, { timeout: 15_000 });
  check('Rejoined participant receives new messages', true);
  check('Others keep their chat history across a participant rejoin', (await chatTexts(bob)).length >= 4);

  // ── Mobile layout ────────────────────────────────────────────────────────
  await carol.page.setViewportSize({ width: 390, height: 844 });
  await carol.page.waitForTimeout(300);
  check('Mobile: no horizontal overflow with chat open', await noOverflow(carol));
  check('Mobile: chat input and End control both visible', (await inViewport(carol, '.chat-input')) && (await inViewport(carol, '[data-ctrl=end]')));
  await carol.page.screenshot({ path: `${OUT}features-mobile-chat.png` });
  await carol.page.setViewportSize({ width: 390, height: 430 }); // on-screen keyboard shrinks the viewport
  await carol.page.focus('.chat-input');
  await carol.page.waitForTimeout(500);
  check('Mobile keyboard (short viewport): input stays visible', await inViewport(carol, '.chat-input'));
  await carol.page.screenshot({ path: `${OUT}features-mobile-keyboard.png` });
  await carol.page.setViewportSize({ width: 390, height: 844 });
  await carol.page.click('[data-ctrl=more]');
  const menu = await carol.page.$$eval('.more-menu .menu-item', (els) => els.map((e) => e.textContent));
  check('Mobile: PiP / Fullscreen / People reachable via "More"', ['Enter PiP', 'Fullscreen', 'People'].every((x) => menu.includes(x)), menu.join(', '));
  await carol.page.keyboard.press('Escape');

  await alice.page.setViewportSize({ width: 820, height: 1180 });
  await alice.page.waitForTimeout(300);
  check('Tablet: no horizontal overflow with chat drawer', await noOverflow(alice));
  await alice.page.screenshot({ path: `${OUT}features-tablet-chat.png` });
  await alice.page.setViewportSize({ width: 1440, height: 900 });
  await alice.page.waitForTimeout(300);
  await alice.page.screenshot({ path: `${OUT}features-desktop-chat.png` });

  // Listener hygiene: many renders must not multiply listeners/subscriptions
  const counts = await alice.page.evaluate(() => ({ unread: window.__voip.app.chat.unread, msgs: document.querySelectorAll('.chat-list .msg').length }));
  await bob.page.evaluate(() => {
    const i = document.querySelector('.chat-input');
    i.value = 'single delivery check';
    i.dispatchEvent(new Event('input'));
    i.form.requestSubmit();
  });
  await alice.page.waitForFunction((n) => document.querySelectorAll('.chat-list .msg').length > n, counts.msgs, { timeout: 10_000 });
  await alice.page.waitForTimeout(800);
  check('Each message rendered exactly once (no duplicate subscriptions)', (await alice.page.$$eval('.msg-text', (e) => e.filter((x) => x.textContent === 'single delivery check').length)) === 1);

  await Promise.all([alice, bob, carol].map((u) => u.page.evaluate(() => window.__voip.app.calls.hangup())));
} catch (err) {
  check('Features run', false, err.message.split('\n')[0]);
} finally {
  await browser.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
