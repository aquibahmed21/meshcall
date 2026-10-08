/**
 * People / Live / Calls panes: search on demand, long-press call buttons, multi-select group
 * call, call history with call-back, header ⋮ menu (Go live, Settings), diagnostics in Settings.
 *   npm run dev   then   node tests/e2e/people.mjs
 */
import { chromium } from 'playwright-core';

const URL = process.env.E2E_URL || 'http://localhost:5173/';
const ROOM = `people-${Date.now().toString(36)}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
async function user(name, mobile = false) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto(URL);
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  await page.fill('#room-name', ROOM);
  await page.click('.room-screen button[type=submit]');
  await page.waitForFunction(() => window.__voip?.app.rooms.current && window.__voip.app.signaling.status === 'connected', null, { timeout: 30_000 });
  return { name, page, id: await page.evaluate(() => window.__voip.app.identity.deviceId) };
}
const ev = (u, fn, a) => u.page.evaluate(fn, a);
const idle = (...us) => Promise.all(us.map((u) => u.page.waitForFunction(() => window.__voip?.app.calls.state === null, null, { timeout: 25_000 })));
const visible = (u, sel) => ev(u, (s) => { const e = document.querySelector(s); return !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length); }, sel);

try {
  const ann = await user('Ann', true);
  const bob = await user('Bob');
  const cara = await user('Cara');
  for (const u of [bob, cara]) await ann.page.waitForSelector(`li.user[data-user="${u.id}"] .user-row`, { timeout: 30_000 });

  // Header: only profile + ⋮ (menu has Go live / Settings)
  const headerBtns = await ev(ann, () => [...document.querySelectorAll('.topbar > button, .topbar > .top-menu-wrap > button')].map((b) => b.getAttribute('aria-label')));
  check('Header: profile + ⋮ only (no Settings / Diagnostics icons)', headerBtns.length === 2 && headerBtns[1] === 'More', headerBtns.join(', '));
  await ann.page.click('.topbar button[aria-label=More]');
  const menu = await ev(ann, () => [...document.querySelectorAll('.top-menu .menu-item')].map((b) => b.textContent));
  check('⋮ menu: Go live, Settings, Leave room', ['Go live', 'Settings', 'Leave room'].every((x) => menu.includes(x)), menu.join(', '));
  await ann.page.keyboard.press('Escape');

  // People pane: no heading, search only on demand
  check('People: no "People" heading, no search field until tapped', !(await visible(ann, '#people h2')) && !(await visible(ann, '.search-row')));
  await ann.page.click('.list-toolbar button[aria-label="Search contacts"]');
  await ann.page.fill('.search-row input', 'car');
  const names = await ev(ann, () => [...document.querySelectorAll('li.user .user-name')].map((n) => n.textContent));
  check('Search icon → field appears and filters', (await visible(ann, '.search-row')) && names.join() === 'Cara', names.join());
  await ann.page.click('.search-row button[aria-label="Close search"]');
  check('Closing search hides it and clears the filter', !(await visible(ann, '.search-row')) && (await ev(ann, () => document.querySelectorAll('li.user').length)) === 2);

  // Live now only under Live
  check('Live now is not on the People tab', !(await visible(ann, '#live')));
  await ann.page.click('.bottom-nav button[data-view=live]');
  check('Live tab shows Live now', (await visible(ann, '#live')) && !(await visible(ann, '#people')));
  await ann.page.click('.bottom-nav button[data-view=people]');

  // Long-press → call buttons
  const row = await ann.page.$(`li.user[data-user="${bob.id}"] .user-row`);
  const bb = await row.boundingBox();
  await ann.page.mouse.move(bb.x + 60, bb.y + 20);
  await ann.page.mouse.down();
  await ann.page.waitForTimeout(650);
  await ann.page.mouse.up();
  check('Long-press shows call buttons (does not open the chat)', (await visible(ann, `li.user[data-user="${bob.id}"] .row-actions`)) && (await ev(ann, () => document.querySelector('.dm-drawer').hidden)));
  await ann.page.click(`li.user[data-user="${bob.id}"] button[aria-label="Audio call Bob"]`);
  const rang = await bob.page.waitForSelector('dialog.incoming button[aria-label=Decline]', { timeout: 20_000 }).then(() => true, () => false);
  check('…and its Audio call button rings Bob', rang);
  if (rang) await bob.page.click('dialog.incoming button[aria-label=Decline]');
  await idle(ann, bob);

  // Multi-select → group call
  await ann.page.click('.list-toolbar button[aria-label="Select people for a group call"]');
  await ann.page.click(`li.user[data-user="${bob.id}"] .user-row`);
  await ann.page.click(`li.user[data-user="${cara.id}"] .user-row`);
  check('Select mode: tapping selects (no chat opens), bar shows the count', /2 selected/.test(await ev(ann, () => document.querySelector('.select-bar').textContent)) && (await ev(ann, () => document.querySelector('.dm-drawer').hidden)));
  await ann.page.click('.select-bar button[aria-label="Group video call"]');
  const both = await Promise.all([bob, cara].map((u) => u.page.waitForSelector('dialog.incoming button[aria-label=Accept]', { timeout: 20_000 }).then(() => true, () => false)));
  check('Group video call rings both selected people', both.every(Boolean) && (await ev(ann, () => window.__voip.app.calls.state?.kind)) === 'group');
  for (const u of [bob, cara]) await u.page.click('dialog.incoming button[aria-label=Accept]').catch(() => {});
  await ann.page.waitForFunction(() => (window.__voip.diagnostics().call?.peers ?? []).filter((p) => p.connectionState === 'connected').length === 2, null, { timeout: 40_000 }).catch(() => {});
  check('Group call connects to both', (await ev(ann, () => (window.__voip.diagnostics().call?.peers ?? []).filter((p) => p.connectionState === 'connected').length)) === 2);
  check('Select mode ends after starting the call', !(await visible(ann, '.select-bar')));
  await ann.page.waitForTimeout(1500);
  for (const u of [ann, bob, cara]) await ev(u, () => window.__voip.app.calls.hangup()); // the others stay in the group otherwise
  await idle(ann, bob, cara);

  // Call history (Call tab without a call)
  await ann.page.click('.bottom-nav button[data-view=call]');
  const hist = await ev(ann, () => [...document.querySelectorAll('.call-entry')].map((e) => e.textContent));
  const peers = await ev(ann, () => window.__voip.app.history.list()[0]?.peers.map((p) => p.name).sort().join());
  check('Group entry recorded both participants', peers === 'Bob,Cara', peers);
  check('Call tab lists recent calls (group answered, 1:1 declined)', hist.length === 2 && /Bob, Cara|Cara, Bob/.test(hist[0]) && /Bob/.test(hist[1]) && /Declined/.test(hist[1]), hist.join(' | '));
  await ann.page.click('.call-entry >> nth=1');
  const back = await bob.page.waitForSelector('dialog.incoming', { timeout: 20_000 }).then(() => true, () => false);
  check('Tapping a history row calls back (same media)', back && (await ev(ann, () => window.__voip.app.calls.state?.media)) === 'audio');
  await ev(ann, () => window.__voip.app.calls.hangup());
  await idle(ann, bob);

  // Desktop: tabs + diagnostics from Settings → Device
  check('Desktop sidebar has People / Live / Calls tabs', (await ev(bob, () => [...document.querySelectorAll('.side-tabs .panel-tab')].map((t) => t.textContent.replace(/\d+$/, '')).join())) === 'People,Live,Calls');
  await bob.page.click('.side-tabs button:has-text("Calls")');
  check('Desktop Calls tab shows the history', (await ev(bob, () => document.querySelectorAll('.call-entry').length)) >= 2);
  await bob.page.click('.topbar button[aria-label=More]');
  await bob.page.click('.top-menu button:has-text("Settings")');
  await bob.page.click('dialog[open] .settings-tabs button:has-text("Device")');
  await bob.page.click('dialog[open] button:has-text("Open diagnostics")');
  check('Settings → Device → Open diagnostics', await ev(bob, () => !document.querySelector('.diagnostics').hidden));
} catch (err) {
  check('Run', false, err.stack?.split('\n').slice(0, 2).join(' '));
} finally {
  await browser.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
