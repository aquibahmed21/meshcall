/**
 * Contacts & top bar: rows open the conversation (calls from there), remove contact, ⋮ menu with
 * Leave, profile in the top bar, Settings split into Call / Device.
 *   npm run dev   then   node tests/e2e/contacts.mjs
 */
import { chromium } from 'playwright-core';

const URL = process.env.E2E_URL || 'http://localhost:5173/';
const ROOM = `contacts-${Date.now().toString(36)}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
async function user(name, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  page.on('dialog', (d) => void d.accept()); // confirm() for remove/leave
  await page.goto(URL);
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  await page.fill('#room-name', ROOM);
  await page.click('.room-screen button[type=submit]');
  await page.waitForFunction(() => window.__voip?.app.rooms.current && window.__voip.app.signaling.status === 'connected', null, { timeout: 30_000 });
  return { name, page, id: await page.evaluate(() => window.__voip.app.identity.deviceId) };
}
const ev = (u, fn, a) => u.page.evaluate(fn, a);
const listed = (u, id) => ev(u, (i) => !!document.querySelector(`li.user[data-user="${i}"]`), id);

try {
  const ann = await user('Ann', { width: 390, height: 844 });
  const bob = await user('Bob');
  await ann.page.waitForSelector(`li.user[data-user="${bob.id}"]`, { timeout: 30_000 });

  // Top bar
  const top = await ev(ann, () => ({ profile: document.querySelector('.topbar .me')?.textContent ?? '', copy: [...document.querySelectorAll('.topbar button')].some((b) => /copy/i.test(b.textContent)), leaveText: [...document.querySelectorAll('.topbar > button, .topbar > div > button')].some((b) => /^leave$/i.test(b.textContent.trim())), roomRow: !!document.querySelector('.room-chip') }));
  check('Top bar starts with my profile (name + online dot, room only in the ⋮ menu)', /Ann/.test(top.profile) && !top.profile.includes(ROOM) && (await ev(ann, () => !!document.querySelector('.topbar .me .presence-dot.online'))), top.profile);
  check('No Copy button, no room-name row, no "Leave" text button', !top.copy && !top.roomRow && !top.leaveText);

  // Contact row
  const row = await ev(ann, (id) => [...document.querySelectorAll(`li.user[data-user="${id}"] button`)].map((b) => b.className), bob.id);
  check('Contact row is one button (no call/message buttons)', row.length === 1 && row[0] === 'user-row', row.join(','));
  await ann.page.click(`li.user[data-user="${bob.id}"] .user-row`);
  await ann.page.waitForSelector('.dm-drawer:not([hidden])');
  const head = await ev(ann, () => [...document.querySelectorAll('.dm-head button')].map((b) => b.getAttribute('aria-label')));
  check('Tap contact → conversation with Audio/Video call buttons at the top', head.includes('Audio call Bob') && head.includes('Video call Bob'), head.join(', '));

  // Call from the conversation header
  await ann.page.click('.dm-head button[aria-label="Video call Bob"]');
  const rang = await bob.page.waitForSelector('dialog.incoming button[aria-label=Decline]', { timeout: 20_000 }).then(() => true, () => false);
  check('Video call from the conversation header rings Bob', rang && (await ev(ann, () => window.__voip.app.calls.state?.media)) === 'video');
  if (rang) await bob.page.click('dialog.incoming button[aria-label=Decline]');
  await ann.page.waitForFunction(() => !window.__voip.app.calls.inCall, null, { timeout: 15_000 });

  // Remove contact (with a conversation)
  await ev(ann, (id) => window.__voip.app.dms.send(id, 'hello'), bob.id);
  await ann.page.waitForFunction((id) => window.__voip.app.dms.conversation(id).messages.length === 1, bob.id);
  await ann.page.click('.dm-head button[aria-label=More]');
  await ann.page.click('.dm-menu button:has-text("Remove contact")');
  await ann.page.waitForSelector('.dm-drawer[hidden]', { state: 'attached', timeout: 5_000 });
  check('Remove contact → gone from the list', !(await listed(ann, bob.id)));
  check('…and the conversation is deleted', (await ev(ann, (id) => window.__voip.app.dms.conversation(id).messages.length, bob.id)) === 0);
  await ann.page.reload();
  await ann.page.waitForFunction(() => window.__voip?.app.rooms.current && window.__voip.app.signaling.status === 'connected', null, { timeout: 30_000 });
  await ann.page.waitForTimeout(3000);
  check('…still removed after reload (Bob online)', !(await listed(ann, bob.id)) && (await ev(ann, (id) => window.__voip.app.presence.status(id), bob.id)) === 'online');
  await ev(bob, (id) => window.__voip.app.dms.send(id, 'hi again'), ann.id);
  const back = await ann.page.waitForSelector(`li.user[data-user="${bob.id}"]`, { timeout: 15_000 }).then(() => true, () => false);
  check('Bob messages Ann → he is back in her list (with the message)', back && (await ev(ann, (id) => window.__voip.app.dms.unreadFor(id), bob.id)) === 1);

  // Settings tabs
  await bob.page.click('.topbar button[aria-label=More]');
  await bob.page.click('.top-menu button:has-text("Settings")');
  await bob.page.waitForSelector('dialog[open] .settings-tabs');
  const callTab = await ev(bob, () => [...document.querySelectorAll('dialog[open] [role=tabpanel]:not([hidden]) h3')].map((x) => x.textContent));
  await bob.page.click('dialog[open] .settings-tabs button:has-text("Device")');
  const devTab = await ev(bob, () => [...document.querySelectorAll('dialog[open] [role=tabpanel]:not([hidden]) h3')].map((x) => x.textContent));
  check('Settings → Call tab: devices, quality, connection', callTab.join('|') === 'Audio & video devices|Quality|Connection', callTab.join(', '));
  check('Settings → Device tab: profile, notifications, app, diagnostics', devTab.join('|') === 'Profile|Notifications|App|Diagnostics', devTab.join(', '));
  await bob.page.keyboard.press('Escape');
  await bob.page.click('.topbar .me');
  check('Tapping my profile opens Settings on the Device tab', await bob.page.waitForSelector('dialog[open] #settings-tab-device[aria-selected=true]', { timeout: 5_000 }).then(() => true, () => false));
  await bob.page.keyboard.press('Escape');

  // ⋮ menu → Leave
  await ann.page.click('.topbar button[aria-label=More]');
  const menu = await ev(ann, () => document.querySelector('.top-menu').textContent);
  check('⋮ menu shows the room and an exit-icon "Leave room"', menu.includes(ROOM) && /Leave room/.test(menu) && (await ev(ann, () => !!document.querySelector(".top-menu .menu-item.danger svg"))), menu);
  await ann.page.click('.top-menu button:has-text("Leave room")');
  check('Leave room → room screen, saved room cleared', await ann.page.waitForSelector('#room-name', { timeout: 15_000 }).then(() => ev(ann, () => window.__voip.app.rooms.current === null && localStorage.getItem('voip.activeRoom') === null), () => false));
} catch (err) {
  check('Run', false, err.stack?.split('\n').slice(0, 2).join(' '));
} finally {
  await browser.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
