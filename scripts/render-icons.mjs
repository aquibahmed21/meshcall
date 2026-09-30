/**
 * Regenerate the PNG app icons, notification badge and banner from their SVG sources with
 * headless Chrome (uses the existing playwright-core dev dependency).
 *
 *   node scripts/render-icons.mjs        (CHROME_PATH=/path/to/chrome to override)
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const jobs = [
  ['public/icon.svg', 'public/icons/icon-192.png', 192, 192],
  ['public/icon.svg', 'public/icons/icon-512.png', 512, 512],
  ['public/icon.svg', 'public/icons/apple-touch-icon.png', 180, 180, '#0f1419'], // iOS ignores alpha
  ['assets/brand/maskable.svg', 'public/icons/maskable-512.png', 512, 512],
  ['public/icons/badge.svg', 'public/icons/badge-96.png', 96, 96], // white on transparent
  ['public/banner.svg', 'public/banner.png', 1200, 630],
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
const page = await browser.newPage();
for (const [src, out, w, h, bg = 'transparent'] of jobs) {
  await page.setViewportSize({ width: w, height: h });
  const svg = readFileSync(src, 'utf8').replace('<svg ', `<svg width="${w}" height="${h}" `);
  await page.setContent(`<html><body style="margin:0;background:${bg}">${svg}</body></html>`);
  await page.screenshot({ path: out, omitBackground: bg === 'transparent', clip: { x: 0, y: 0, width: w, height: h } });
  console.log(`${out} (${w}×${h})`);
}
await browser.close();
