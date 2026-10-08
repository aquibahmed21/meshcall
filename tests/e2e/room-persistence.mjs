/**
 * Room persistence: the active room is reopened on the next launch; "Leave room" forgets it;
 * switching rooms saves the new one.     npm run dev   then   node tests/e2e/room-persistence.mjs
 */
import { chromium } from 'playwright-core';

const URL = process.env.E2E_URL || 'http://localhost:5173/';
const tag = Date.now().toString(36);
const ROOM1 = `Room 1 ${tag}`;
const ROOM2 = `Room 2 ${tag}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
const ctx = await browser.newContext(); // one device: storage survives closing/reopening pages
const current = (page) => page.evaluate(() => window.__voip?.app.rooms.current?.roomName ?? null);
const joinedIn = (page, room) =>
  page
    .waitForFunction((r) => window.__voip?.app.rooms.current?.roomName === r && window.__voip.app.signaling.status === 'connected' && !!document.querySelector('.topbar .me'), room, { timeout: 30_000 })
    .then(() => true, () => false);
const roomScreen = (page) =>
  page
    .waitForSelector('#room-name:not([disabled])', { timeout: 20_000 })
    .then(() => page.evaluate(() => window.__voip.app.rooms.current === null), () => false);
async function join(page, room) {
  await page.waitForSelector('#room-name:not([disabled])', { timeout: 30_000 });
  await page.fill('#room-name', room);
  await page.click('.room-screen button[type=submit]');
  return joinedIn(page, room);
}
const leave = async (page) => {
  await page.click('.topbar button[aria-label=More]');
  await page.click('.top-menu button:has-text("Leave room")');
  await page.waitForSelector('#room-name', { timeout: 20_000 });
};

try {
  let page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(URL);
  await page.fill('#name', 'Pat');
  await page.click('button[type=submit]');
  check('First launch (nothing saved) asks which room to join', await roomScreen(page));
  check('Join Room 1', await join(page, ROOM1));

  await page.reload();
  check('Reload while in Room 1 → Room 1 reopened automatically', await joinedIn(page, ROOM1), String(await current(page)));

  await page.close(); // close the app…
  page = await ctx.newPage();
  await page.goto(URL); // …and open it again
  check('Close + reopen → Room 1 joined automatically (no input needed)', await joinedIn(page, ROOM1), String(await current(page)));

  await leave(page);
  await page.reload();
  check('After "Leave room" → next launch asks which room (no auto-join)', await roomScreen(page));
  check('…and the input is not prefilled with the old room', (await page.inputValue('#room-name')) === '');

  check('Join Room 1 again', await join(page, ROOM1));
  await leave(page);
  check('Switch to Room 2', await join(page, ROOM2));
  await page.close();
  page = await ctx.newPage();
  await page.goto(URL);
  check('Switched Room 1 → Room 2 → next launch reopens Room 2', await joinedIn(page, ROOM2), String(await current(page)));

  // A launch link for another room (?room=) still only prefills it – never auto-joins anything.
  await page.goto(`${URL}?room=${encodeURIComponent(ROOM1)}`);
  const pre = await roomScreen(page);
  check('?room= launch link prefills (no silent auto-join) – existing behaviour kept', pre && (await page.inputValue('#room-name')) === ROOM1);
} catch (err) {
  check('Run', false, err.stack?.split('\n').slice(0, 2).join(' '));
} finally {
  await browser.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
