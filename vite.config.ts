import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev`      → http://localhost:5173 (localhost is a secure context, so getUserMedia works)
// `npm run dev:lan`  → https://<lan-ip>:5173 with a self-signed cert so phones/other PCs on the
//                      LAN get a secure context (required for getUserMedia, Service Workers, Push).
export default defineConfig(({ mode }) => {
  const lan = mode === 'lan';
  return {
    plugins: lan ? [basicSsl()] : [],
    server: { host: lan ? true : 'localhost', port: 5173 },
    preview: { host: true, port: 4173 },
    build: { target: 'es2022', sourcemap: true },
    test: { environment: 'node', include: ['tests/unit/**/*.test.ts'] },
  };
});
