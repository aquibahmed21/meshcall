/**
 * Service Worker · install-as-app · offline shell · update flow (production build).
 *   npx vite build --base=/meshcall/ && npm run test:pwa     (the test serves dist/ itself)
 * Web Push is covered by tests/e2e/push.mjs against the real push backend.
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
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const RUN = Date.now().toString(36);
const ROOM = `PWA ${RUN}`;
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

let shell;
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

} catch (err) {
  check('PWA run', false, `${err.message.split('\n')[0]} @ ${(err.stack ?? '').split('\n').find((l) => l.includes('pwa.mjs')) ?? ''}`);
} finally {
  await shell?.close().catch(() => {});
  host.close();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
