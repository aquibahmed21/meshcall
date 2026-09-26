import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

/**
 * Service Worker precache manifest.
 * public/sw.js is copied verbatim, so after the bundle is written we stamp it with
 *   - a unique BUILD_ID  → a byte-changed sw.js per release, which is how browsers detect updates
 *   - the list of emitted files (hashed JS/CSS, index.html, icons, manifest) to precache
 * In `vite dev` sw.js keeps the placeholders and runs in pass-through mode (no caching).
 */
function serviceWorkerManifest(): Plugin {
  let outDir = 'dist';
  const files = new Set<string>();
  return {
    name: 'meshcall-sw-manifest',
    apply: 'build',
    configResolved(cfg) {
      outDir = resolve(cfg.root, cfg.build.outDir);
    },
    generateBundle(_opts, bundle) {
      for (const f of Object.keys(bundle)) if (!f.endsWith('.map')) files.add(f);
    },
    closeBundle() {
      const sw = resolve(outDir, 'sw.js');
      const statics = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/badge-96.png'];
      const precache = [...new Set([...statics, ...files])].filter((f) => f !== 'sw.js').sort();
      const buildId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
      const src = readFileSync(sw, 'utf8')
        .replace("'__BUILD_ID__'", JSON.stringify(buildId))
        .replace('/*__PRECACHE__*/ []', JSON.stringify(precache));
      writeFileSync(sw, src);
    },
  };
}

// `npm run dev`      → http://localhost:5173 (localhost is a secure context, so getUserMedia works)
// `npm run dev:lan`  → https://<lan-ip>:5173 with a self-signed cert so phones/other PCs on the
//                      LAN get a secure context (required for getUserMedia, Service Workers, Push).
export default defineConfig(({ mode }) => {
  const lan = mode === 'lan';
  return {
    plugins: [...(lan ? [basicSsl()] : []), serviceWorkerManifest()],
    server: { host: lan ? true : 'localhost', port: 5173 },
    preview: { host: true, port: 4173 },
    build: { target: 'es2022', sourcemap: true },
    test: { environment: 'node', include: ['tests/unit/**/*.test.ts'] },
  };
});
