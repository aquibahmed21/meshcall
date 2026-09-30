/** Responsive screenshots: desktop / tablet / phone, idle + in-call + diagnostics. */
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
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const viewports = {
  desktop: { viewport: { width: 1440, height: 900 } },
  tablet: { viewport: { width: 820, height: 1180 }, hasTouch: true },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};
async function user(name, opts) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], ...opts });
  const page = await ctx.newPage();
  await page.goto(URL);
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  await enterRoom(page);
  await page.waitForFunction(() => window.__voip?.app.signaling.status === 'connected');
  return { page, id: await page.evaluate(() => window.__voip.app.identity.deviceId) };
}
const peer = await user('Sarah', viewports.desktop);
for (const [label, opts] of Object.entries(viewports)) {
  const me = await user(`Aquib-${label}`, opts);
  await me.page.waitForFunction((id) => window.__voip.app.presence.status(id) === 'online', peer.id);
  await me.page.screenshot({ path: `${OUT}${label}-idle.png` });
  await me.page.evaluate((id) => window.__voip.app.calls.startDirectCall(id, 'video'), peer.id);
  await peer.page.waitForSelector('dialog.incoming button[aria-label=Accept]');
  await peer.page.click('dialog.incoming button[aria-label=Accept]');
  await me.page.waitForFunction(() => window.__voip.diagnostics().call?.peers[0]?.connectionType);
  await me.page.waitForTimeout(2500);
  await me.page.screenshot({ path: `${OUT}${label}-call.png` });
  await me.page.click('button[aria-label=Diagnostics]');
  await me.page.waitForTimeout(2500);
  await me.page.screenshot({ path: `${OUT}${label}-diagnostics.png` });
  const overflow = await me.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log(`${label}: horizontal overflow = ${overflow}`);
  await me.page.evaluate(() => window.__voip.app.calls.hangup());
  await peer.page.waitForFunction(() => window.__voip.app.calls.state === null, null, { timeout: 15000 });
  await me.page.context().close();
}
await browser.close();
console.log('screenshots in', OUT);
