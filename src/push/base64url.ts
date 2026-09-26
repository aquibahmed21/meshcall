/**
 * Base64URL (RFC 4648 §5, unpadded) → Uint8Array.
 * VAPID public keys are distributed in this form but PushManager.subscribe() needs the raw bytes
 * as `applicationServerKey`.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const clean = base64String.trim();
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(clean)) throw new Error('Invalid base64url string');
  const padding = '='.repeat((4 - (clean.replace(/=+$/, '').length % 4)) % 4);
  const base64 = (clean.replace(/=+$/, '') + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Uint8Array/ArrayBuffer → Base64URL (used to compare a subscription's key with the server's). */
export function uint8ArrayToUrlBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
