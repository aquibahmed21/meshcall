/**
 * Service Worker · install-as-app · Web Push (REAL push: app → relay → FCM → Service Worker).
 *
 * Needs (see README → Testing):
 *   npx vite build --base=/meshcall/ && npx vite preview --base=/meshcall/ --port 4173
 *   VITE_PUSH_SERVER_URL=http://localhost:8787 npx vite build --base=/meshcall/ --outDir dist-push
 *   npx vite preview --base=/meshcall/ --outDir dist-push --port 4174
 *   (cd server && npm install && npm start)          # relay on :8787
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

/**
 * Minimal static host for dist/ under /meshcall/ that reads files on every request – like a real
 * host after a deploy (vite preview indexes files at start-up, which breaks the update test).
 */
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.map': 'application/json' };
const host = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/meshcall/')) return res.writeHead(404).end();
  let file = join('dist', decodeURIComponent(url.pathname.slice('/meshcall/'.length)) || 'index.html');
  if (!existsSync(file) || statSync(file).isDirectory()) file = join('dist', 'index.html');
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache', vary: 'Origin' });
  res.end(readFileSync(file));
});
await new Promise((r) => host.listen(4175, r));
const APP = process.env.E2E_URL || 'http://localhost:4175/meshcall/';
const PUSH_APP = process.env.E2E_PUSH_URL || 'http://localhost:4174/meshcall/';
const RELAY = process.env.E2E_RELAY || 'http://localhost:8787';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const RUN = Date.now().toString(36);
const ROOM = `PWA ${RUN}`;
const OTHER_ROOM = `Elsewhere ${RUN}`;
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const section = (t) => console.log(`\n── ${t}`);
const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--bypass-app-banner-engagement-checks'];
// Persistent (non-incognito) profiles: required for installability and for a real push subscription.
const profile = (name) =>
  chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), `meshcall-${name}-`)), {
    executablePath: CHROME,
    headless: process.env.HEADLESS !== '0',
    args,
    permissions: ['camera', 'microphone', 'notifications'],
  });

async function onboard(page, name, room) {
  await page.waitForSelector('#name', { timeout: 20_000 });
  await page.fill('#name', name);
  await page.click('button[type=submit]');
  if (room) await enterRoom(page, room);
}
async function enterRoom(page, room) {
  await page.waitForSelector('#room-name', { timeout: 20_000 });
  await page.fill('#room-name', room);
  await page.click('.room-screen button[type=submit]');
  await page.waitForSelector('.room-chip strong', { timeout: 30_000 }).catch(async (e) => {
    console.log('   join failed:', await page.textContent('#room-error').catch(() => '?'));
    throw e;
  });
}
const swNotifications = async (ctx) => {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 10_000 }));
  return sw.evaluate(async () => (await self.registration.getNotifications()).map((n) => ({ tag: n.tag, title: n.title, body: n.body, actions: (n.actions || []).map((a) => a.action) })));
};

let a, b, shell;
try {
  // ═══════════════════════════ SERVICE WORKER / INSTALL ═══════════════════════
  section('Service Worker & install');
  shell = await profile('shell');
  const page = shell.pages()[0] ?? (await shell.newPage());
  if (process.env.DEBUG) page.on('console', (m) => /Room|Signaling|PWA|rror/.test(m.text()) && console.log('   ·', m.text().slice(0, 150)));
  await page.goto(APP);
  await page.waitForSelector('#name');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
  check('Service Worker active before the user even entered a name', true, await page.evaluate(() => navigator.serviceWorker.controller.scriptURL));
  const cdp = await shell.newCDPSession(page);
  const errs = (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors;
  check('Installable (Chrome installability criteria: manifest, icons, SW)', errs.length === 0, JSON.stringify(errs));
  const man = await cdp.send('Page.getAppManifest');
  check('Manifest parsed without errors', man.errors.length === 0 && /"display": "standalone"/.test(man.data ?? ''), JSON.stringify(man.errors));
  await page.waitForFunction(() => window.__voip?.app.pwa.installState === 'available', null, { timeout: 10_000 }).catch(() => {});
  const inst = await page.evaluate(() => window.__voip.app.pwa.installState);
  check('Install prompt captured (beforeinstallprompt) → "Install" offered', inst === 'available', inst);
  await onboard(page, 'Shell', ROOM);
  check('Install button shown in the app', await page.waitForSelector('.install-btn', { timeout: 10_000 }).then(() => true, () => false));
  const v1 = await page.evaluate(() => window.__voip.app.pwa.version());
  check('Build-stamped Service Worker version', !!v1 && v1 !== 'dev', v1);
  const cached = await page.evaluate(async () => (await caches.keys()).find((k) => k.startsWith('meshcall-2')));
  const cachedCount = await page.evaluate(async (k) => (await (await caches.open(k)).keys()).length, cached);
  check('App shell precached (hashed JS/CSS, HTML, icons, manifest)', cachedCount >= 8, `${cached}: ${cachedCount} files`);

  await shell.setOffline(true);
  await page.reload();
  const offlineOk = await page.waitForSelector('#room-name', { timeout: 10_000 }).then(() => true, () => false);
  check('Offline: installed app still opens (served from cache)', offlineOk, await page.title());
  await shell.setOffline(false);
  await enterRoom(page, ROOM);

  execSync('npx vite build --base=/meshcall/', { stdio: 'ignore' }); // "deploy" a new release
  await page.evaluate(() => window.__voip.app.pwa.checkForUpdate());
  await page.waitForSelector('.banner button.primary', { timeout: 20_000 }).catch(async (e) => {
    console.log('   update state:', JSON.stringify(await page.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return { installing: r?.installing?.state, waiting: !!r?.waiting, active: r?.active?.state, controller: !!navigator.serviceWorker.controller, updateReady: window.__voip.app.pwa.updateReady, hasReg: !!window.__voip.app.pwa.registration, banner: document.querySelector('.banner')?.hidden };
    })));
    throw e;
  });
  check('New release detected → "new version available" banner (no forced reload)', (await page.textContent('.banner')).includes('new version'));
  await Promise.all([page.waitForNavigation({ timeout: 15_000 }), page.click('.banner button.primary')]);
  await page.waitForFunction(() => !!window.__voip, null, { timeout: 15_000 });
  const v2 = await page.evaluate(() => window.__voip.app.pwa.version());
  check('Reload activates the new version', !!v2 && v2 !== v1, `${v1} → ${v2}`);
  await shell.close();
  shell = null;

  // ═══════════════════════════════ PUSH ═══════════════════════════════════════
  section('Push notifications (real FCM delivery)');
  b = await profile('bob');
  const bp = b.pages()[0] ?? (await b.newPage());
  await bp.goto(PUSH_APP);
  await onboard(bp, 'Bob', ROOM);
  await bp.waitForFunction(() => window.__voip.app.push.status === 'available', null, { timeout: 15_000 });
  await bp.click('.topbar button[aria-label=Settings]');
  await bp.click('dialog button:text("Enable push notifications")');
  await bp.waitForFunction(() => window.__voip.app.push.status === 'subscribed', null, { timeout: 30_000 });
  const health = await (await fetch(`${RELAY}/health`)).json();
  check('Enable push → subscribed with the browser push service and registered at the relay', health.subscriptions >= 1, JSON.stringify(health));
  await bp.click('dialog button:text("Send a test notification")');
  await bp.waitForTimeout(800);
  check('Test notification displayed by the Service Worker', (await swNotifications(b)).some((n) => n.tag === 'test'));
  const bobId = await bp.evaluate(() => window.__voip.app.identity.deviceId);
  await bp.keyboard.press('Escape');
  await bp.close(); // app closed – only the Service Worker can reach Bob now

  a = await chromium.launch({ executablePath: CHROME, headless: process.env.HEADLESS !== '0', args });
  const actx = await a.newContext({ permissions: ['camera', 'microphone'] });
  const ap = await actx.newPage();
  await ap.goto(PUSH_APP);
  await onboard(ap, 'Alice', ROOM);
  await ap.waitForFunction((id) => ['offline', 'online'].includes(window.__voip.app.presence.status(id)), bobId, { timeout: 20_000 }).catch(() => {});
  await ap.evaluate((id) => window.__voip.app.calls.startDirectCall(id, 'video'), bobId);
  const callId = await ap.evaluate(() => window.__voip.app.calls.state.callId);
  let shown = [];
  for (let i = 0; i < 30 && !shown.some((n) => n.tag === `call-${callId}`); i++) {
    await new Promise((r) => setTimeout(r, 1000));
    shown = await swNotifications(b);
  }
  const n = shown.find((x) => x.tag === `call-${callId}`);
  check('Closed app: incoming-call push delivered and shown by the Service Worker', !!n, n ? `${n.title} – ${n.body.replace('\n', ' | ')}` : JSON.stringify(shown));
  check('Notification has Answer / Dismiss actions and names the room', !!n && n.actions.join() === 'answer,dismiss' && n.body.includes(ROOM));
  check('Caller keeps ringing while the callee is woken by push', ['calling', 'ringing'].includes(await ap.evaluate(() => window.__voip.app.calls.state?.status)));

  // "Answer" on the notification opens the app with the room prefilled and answers after joining.
  const bp2 = await b.newPage();
  await bp2.goto(`${PUSH_APP}?room=${encodeURIComponent(ROOM)}&action=answer&callId=${callId}`);
  await bp2.waitForSelector('#room-name');
  check('Notification click → room screen prefilled with the call\'s room (no silent auto-join)', (await bp2.inputValue('#room-name')) === ROOM && (await bp2.evaluate(() => window.__voip.app.rooms.current)) === null);
  await bp2.click('.room-screen button[type=submit]');
  await ap.waitForFunction(() => window.__voip.diagnostics().call?.peers[0]?.connectionState === 'connected', null, { timeout: 40_000 });
  check('…joining answers the call automatically and it connects', true, await ap.evaluate(() => window.__voip.diagnostics().call.peers[0].selectedCandidate ?? ''));
  await ap.evaluate(() => window.__voip.app.calls.hangup());
  await bp2.waitForFunction(() => window.__voip.app.calls.state === null, null, { timeout: 20_000 });

  // App open (visible) but in ANOTHER room: the push is routed to the page → offer to switch.
  await bp2.click('.room-chip button[aria-label="Leave room"]');
  await enterRoom(bp2, OTHER_ROOM);
  await ap.waitForFunction((id) => window.__voip.app.presence.status(id) === 'offline', bobId, { timeout: 20_000 });
  await ap.evaluate((id) => window.__voip.app.calls.startDirectCall(id, 'audio'), bobId);
  const offered = await bp2.waitForSelector('.toast.has-action button', { timeout: 30_000 }).then(() => true, () => false);
  check('App open in another room → "calling you in room … [Switch room]"', offered, offered ? await bp2.textContent('.toast.has-action') : '');
  if (offered) {
    await bp2.click('.toast.has-action button');
    await bp2.waitForSelector('#room-name');
    check('Switch room → leaves current room, prefilled room screen', (await bp2.inputValue('#room-name')) === ROOM);
    await bp2.click('.room-screen button[type=submit]');
    const rang = await bp2.waitForSelector('dialog.incoming button[aria-label=Accept]', { timeout: 30_000 }).then(() => true, () => false);
    check('After switching, the ringing call is delivered in-app', rang);
    if (rang) await bp2.click('dialog.incoming button[aria-label=Decline]');
  }
  const before = (await (await fetch(`${RELAY}/health`)).json()).subscriptions;
  await bp2.evaluate(() => window.__voip.app.push.disable());
  check('Turning push off unregisters at the relay', (await (await fetch(`${RELAY}/health`)).json()).subscriptions === before - 1);
} catch (err) {
  check('PWA run', false, `${err.message.split('\n')[0]} @ ${(err.stack ?? '').split('\n').find((l) => l.includes('pwa.mjs')) ?? ''}`);
} finally {
  await shell?.close().catch(() => {});
  await b?.close().catch(() => {});
  await a?.close().catch(() => {});
  host.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
