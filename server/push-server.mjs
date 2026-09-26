#!/usr/bin/env node
/**
 * Minimal Web Push relay for offline incoming-call notifications.
 *
 * Why it exists: browsers cannot send Web Push themselves – the VAPID private key must stay
 * secret and push services do not accept cross-origin browser requests. This relay stores
 * {deviceId → PushSubscription} and forwards call invites.
 *
 *   GET  /vapid-public-key
 *   POST /subscribe   { deviceId, name, subscription }
 *   POST /unsubscribe { deviceId }
 *   POST /notify      { toDeviceId, payload }
 *
 * Env: PORT (8787), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…),
 *      ALLOWED_ORIGIN (default "*").
 * If VAPID keys are not provided they are generated once and stored in server/vapid.json.
 *
 * PRODUCTION NOTE: /notify is unauthenticated here (anyone who knows a deviceId can ring it).
 * Put it behind real authentication (e.g. the same JWT you use for ScaleDrone auth).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SUBS_FILE = path.join(dir, 'subscriptions.json');
const VAPID_FILE = path.join(dir, 'vapid.json');
const PORT = Number(process.env.PORT || 8787);
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

let vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
if (!vapid.publicKey || !vapid.privateKey) {
  vapid = loadJson(VAPID_FILE, null) || webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2), { mode: 0o600 });
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

const subs = new Map(Object.entries(loadJson(SUBS_FILE, {})));
const save = () => fs.writeFile(SUBS_FILE, JSON.stringify(Object.fromEntries(subs), null, 2), () => undefined);

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 60;
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error('body too large');
  }
  return JSON.parse(raw || '{}');
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (limited(req.socket.remoteAddress || '?')) return send(res, 429, { error: 'rate limited' });
  try {
    if (req.method === 'GET' && req.url === '/vapid-public-key') return send(res, 200, { publicKey: vapid.publicKey });
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    const body = await readBody(req);
    if (req.url === '/subscribe') {
      if (typeof body.deviceId !== 'string' || !body.subscription?.endpoint) return send(res, 400, { error: 'invalid' });
      subs.set(body.deviceId, { subscription: body.subscription, name: String(body.name || ''), updatedAt: Date.now() });
      save();
      return send(res, 200, { ok: true });
    }
    if (req.url === '/unsubscribe') {
      subs.delete(String(body.deviceId));
      save();
      return send(res, 200, { ok: true });
    }
    if (req.url === '/notify') {
      const entry = subs.get(String(body.toDeviceId));
      if (!entry) return send(res, 404, { error: 'no subscription' });
      try {
        await webpush.sendNotification(entry.subscription, JSON.stringify(body.payload || {}), { TTL: 60, urgency: 'high' });
        return send(res, 200, { ok: true });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          subs.delete(String(body.toDeviceId)); // subscription expired
          save();
        }
        console.warn('[Push] delivery failed', err.statusCode || err.message);
        return send(res, 502, { error: 'delivery failed' });
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    return send(res, 400, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`[Push] relay on http://localhost:${PORT}`);
  console.log(`[Push] VAPID public key: ${vapid.publicKey}`);
});
