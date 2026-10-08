/**
 * Browser / Android Back: closes the top layer (conversation, menus, dialogs, panels, mobile
 * sections), never ends a call, and leaves no stray history entries.
 *   npm run dev   then   node tests/e2e/back-nav.mjs
 */
import { chromium } from 'playwright-core';

const URL = process.env.E2E_URL || 'http://localhost:5173/';
const ROOM = `back-${Date.now().toString(36)}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
async function user(name, mobile) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto('about:blank');
  await page.goto(URL);
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  await page.fill('#room-name', ROOM);
  await page.click('.room-screen button[type=submit]');
  await page.waitForFunction(() => window.__voip?.app.rooms.current && window.__voip.app.signaling.status === 'connected', null, { timeout: 30_000 });
  return { name, page, id: await page.evaluate(() => window.__voip.app.identity.deviceId) };
}
const ev = (u, fn, a) => u.page.evaluate(fn, a);
// page.goBack() waits for a navigation; in-page history entries don't navigate → don't wait.
const back = async (u) => {
  await u.page.goBack({ waitUntil: 'commit', timeout: 1500 }).catch(() => {});
  await u.page.waitForTimeout(350);
};
const inApp = (u) => ev(u, () => !!window.__voip?.app.rooms.current && location.href.startsWith('http'));
const drawerOpen = (u) => ev(u, () => !document.querySelector('.dm-drawer').hidden);

try {
  const ann = await user('Ann', true);
  const bob = await user('Bob', false);
  await ann.page.waitForSelector(`li.user[data-user="${bob.id}"] .user-row`, { timeout: 30_000 });

  // Conversation + its menu
  await ann.page.click(`li.user[data-user="${bob.id}"] .user-row`);
  await ann.page.click('.dm-head button[aria-label=More]');
  await back(ann);
  check('Back closes the conversation ⋮ menu only', (await ev(ann, () => document.querySelector('.dm-menu').hidden)) && (await drawerOpen(ann)));
  await back(ann);
  check('Back closes the conversation → contact list (still in the app)', !(await drawerOpen(ann)) && (await inApp(ann)));

  // Dialog (Settings)
  await ann.page.click('.topbar button[aria-label=More]');
  await ann.page.click('.top-menu button:has-text("Settings")');
  await ann.page.waitForSelector('dialog[open]');
  await back(ann);
  check('Back closes a dialog (Settings)', (await ev(ann, () => !document.querySelector('dialog[open]'))) && (await inApp(ann)));

  // Top ⋮ menu
  await ann.page.click('.topbar button[aria-label=More]');
  await back(ann);
  check('Back closes the top ⋮ menu', (await ev(ann, () => document.querySelector('.top-menu').hidden)) && (await inApp(ann)));

  // Mobile section
  await ann.page.click('.bottom-nav button[data-view=live]');
  await back(ann);
  check('Back from the Live section → People', (await ev(ann, () => document.querySelector('.app').dataset.view)) === 'people' && (await inApp(ann)));

  // Incoming call: Back must NOT dismiss/decline it
  await ev(bob, (id) => window.__voip.app.calls.startDirectCall(id, 'audio'), ann.id);
  await ann.page.waitForSelector('dialog.incoming[open]', { timeout: 20_000 });
  await back(ann);
  check('Back on an incoming call keeps ringing (no silent decline)', (await ev(ann, () => !!document.querySelector('dialog.incoming[open]') && window.__voip.app.calls.state?.status === 'ringing')));
  await ann.page.click('dialog.incoming button[aria-label=Accept]');
  await ann.page.waitForFunction(() => window.__voip.app.calls.state?.status === 'connected', null, { timeout: 30_000 });
  await ann.page.waitForTimeout(500);
  check('Accepted call shows the Call section', (await ev(ann, () => document.querySelector('.app').dataset.view)) === 'call');

  // In-call panel (chat)
  // On mobile Chat may sit in the call's "More" menu.
  await ann.page.evaluate(() => (document.querySelector('.call [data-ctrl=chat]') ?? document.querySelector('.call [data-ctrl=more]'))?.click());
  if (!(await ev(ann, () => document.querySelector('.call').classList.contains('panel-open')))) {
    await ann.page.evaluate(() => document.querySelector('.call [data-ctrl=menu-chat]')?.click());
  }
  const panelOpened = await ev(ann, () => document.querySelector('.call').classList.contains('panel-open'));
  await back(ann);
  check('Back closes the in-call chat panel', panelOpened && !(await ev(ann, () => document.querySelector('.call').classList.contains('panel-open'))));

  await back(ann);
  check('Back during a call → People, call keeps running', (await ev(ann, () => document.querySelector('.app').dataset.view)) === 'people' && (await ev(ann, () => window.__voip.app.calls.state?.status)) === 'connected');
  await back(ann);
  const toast = await ev(ann, () => document.querySelector('.toasts').textContent);
  check('Back again during a call stays in the app (never ends the call)', (await inApp(ann)) && (await ev(ann, () => window.__voip.app.calls.state?.status)) === 'connected' && /Hang up/.test(toast), toast.slice(-40));

  await ev(ann, () => window.__voip.app.calls.hangup());
  await ann.page.waitForFunction(() => !window.__voip.app.calls.inCall, null, { timeout: 15_000 });
  await ann.page.waitForTimeout(800);

  // Desktop: diagnostics panel
  await bob.page.waitForFunction(() => !window.__voip.app.calls.inCall, null, { timeout: 15_000 });
  await bob.page.waitForTimeout(800);
  await bob.page.click('.topbar button[aria-label=More]');
  await bob.page.click('.top-menu button:has-text("Settings")');
  await bob.page.click('dialog[open] .settings-tabs button:has-text("Device")');
  await bob.page.click('dialog[open] button:has-text("Open diagnostics")');
  check('Diagnostics opens from Settings → Device', (await ev(bob, () => !document.querySelector('.diagnostics').hidden && !document.querySelector('dialog[open]'))));
  await back(bob);
  check('Back closes the Diagnostics panel (desktop)', (await ev(bob, () => document.querySelector('.diagnostics').hidden)) && (await inApp(bob)));

  // Layers closed in the UI leave no stray entries: one Back now leaves the app.
  await ann.page.click(`li.user[data-user="${bob.id}"] .user-row`);
  await ann.page.click('.dm-head button[aria-label=Back]');
  await ann.page.click('.topbar button[aria-label=More]');
  await ann.page.click('.top-menu button:has-text("Settings")');
  await ann.page.click('dialog[open] button[aria-label=Close]');
  await ann.page.click('.topbar button[aria-label=More]');
  await ann.page.keyboard.press('Escape');
  await ann.page.waitForTimeout(500);
  await ann.page.goBack({ timeout: 5000 }).catch(() => {});
  await ann.page.waitForTimeout(500);
  check('After closing layers in the UI, one Back leaves the app (no "dead" Back presses)', ann.page.url() === 'about:blank', ann.page.url());
} catch (err) {
  check('Run', false, err.stack?.split('\n').slice(0, 2).join(' '));
} finally {
  await browser.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
