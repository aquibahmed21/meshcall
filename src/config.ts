/**
 * Runtime configuration, sourced from Vite env variables.
 *
 * SECURITY: `import.meta.env.VITE_*` values are inlined into the bundle and are visible to
 * every visitor. Never put long-lived production secrets here — issue short-lived TURN
 * credentials from a backend in production. Credentials are never logged (see logger.redact).
 */
import { createLogger } from './core/logger';

const log = createLogger('Config');
const env = import.meta.env;

/** Default signaling server URL (the self-hosted Express server). Override with VITE_SERVER_URL. */
export const DEFAULT_SERVER_URL = 'http://localhost:3000';

/**
 * Static pointer URL — a fixed GitHub Pages JSON file that always contains the latest tunnel URL.
 * Override with VITE_POINTER_URL for a different pointer site.
 */
export const POINTER_URL = (env.VITE_POINTER_URL || 'https://aquibahmed21.github.io/server/server-url.json').replace(/\/+$/, '');

/** Existing Web Push backend (see src/push/PushBackend.ts). Override with VITE_PUSH_SERVER_URL. */
export const PUSH_SERVER_URL = 'https://web-push-3zaz.onrender.com';

/** Public Google STUN servers – used for STUN only (Google runs no public TURN servers). */
export const GOOGLE_STUN = ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];

/** STUN order: Google's servers always first, then the configured ones (de-duplicated). */
export function orderStunUrls(configured: string[]): string[] {
  const norm = (u: string) => u.trim().toLowerCase();
  const google = new Set(GOOGLE_STUN.map(norm));
  return [...GOOGLE_STUN, ...configured.filter((u, i) => !google.has(norm(u)) && configured.findIndex((x) => norm(x) === norm(u)) === i)];
}

export type IceFallbackMode = 'gated' | 'native';

export interface AppConfig {
  serverUrl: string;
  iceServers: RTCIceServer[];
  hasTurn: boolean;
  hasStun: boolean;
  ice: {
    /** How long local relay candidates are withheld while direct paths are tried. */
    directP2PTimeoutMs: number;
    /** Optional head start for host→host pairs before srflx candidates are sent. */
    hostOnlyWindowMs: number;
    fallbackMode: IceFallbackMode;
    candidatePoolSize: number;
    /** If > 0, periodically ICE-restart peers that sit on a relay to re-probe direct P2P. */
    relayUpgradeProbeMs: number;
  };
  timeouts: {
    ringMs: number;
    offlineNoAckMs: number;
    acceptConnectMs: number;
    disconnectedGraceMs: number;
    iceRestartTimeoutMs: number;
    maxIceRestarts: number;
    negotiationTimeoutMs: number;
    callReconnectMs: number;
    endedScreenMs: number;
  };
  presence: { heartbeatMs: number; offlineGraceMs: number; staleAfterMs: number };
  signaling: { echoWatchdogMs: number; messageMaxAgeMs: number };
  mesh: { heartbeatMs: number; peerTimeoutMs: number; maxParticipants: number; maxLiveViewers: number };
  stats: { intervalMs: number };
  push: { serverUrl: string; vapidPublicKey: string };
  logLevel: string;
}

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildIceServers(): { servers: RTCIceServer[]; hasTurn: boolean; hasStun: boolean } {
  const servers: RTCIceServer[] = [];
  // Google STUN first, then configured STUN, then TURN (the fallback relay).
  const stunUrls = orderStunUrls(list(env.VITE_STUN_SERVER));
  servers.push({ urls: stunUrls });

  const turnUrls = list(env.VITE_TURN_SERVER);
  const username = env.VITE_TURN_USERNAME;
  const credential = env.VITE_TURN_CREDENTIAL;
  const hasTurn = turnUrls.length > 0 && !!username && !!credential;
  if (hasTurn) {
    servers.push({ urls: turnUrls.length === 1 ? turnUrls[0]! : turnUrls, username, credential });
  } else if (turnUrls.length) {
    log.warn('TURN URL configured without username/credential – TURN relay disabled');
  } else {
    log.warn('No TURN server configured – peers behind symmetric NAT/firewalls may fail to connect');
  }
  return { servers, hasTurn, hasStun: stunUrls.length > 0 };
}

const ice = buildIceServers();

export const CONFIG: AppConfig = {
  serverUrl: (env.VITE_SERVER_URL || DEFAULT_SERVER_URL).replace(/\/+$/, ''),
  iceServers: ice.servers,
  hasTurn: ice.hasTurn,
  hasStun: ice.hasStun,
  ice: {
    directP2PTimeoutMs: num(env.VITE_DIRECT_P2P_TIMEOUT_MS, 3000),
    hostOnlyWindowMs: num(env.VITE_HOST_ONLY_WINDOW_MS, 0),
    fallbackMode: env.VITE_ICE_FALLBACK_MODE === 'native' ? 'native' : 'gated',
    candidatePoolSize: 2,
    relayUpgradeProbeMs: num(env.VITE_RELAY_UPGRADE_PROBE_MS, 0),
  },
  timeouts: {
    ringMs: 45_000,
    offlineNoAckMs: 8_000,
    acceptConnectMs: 25_000,
    disconnectedGraceMs: 3_000,
    iceRestartTimeoutMs: 10_000,
    maxIceRestarts: 3,
    negotiationTimeoutMs: 10_000,
    callReconnectMs: 45_000,
    endedScreenMs: 2_500,
  },
  presence: { heartbeatMs: 20_000, offlineGraceMs: 10_000, staleAfterMs: 70_000 },
  signaling: { echoWatchdogMs: 45_000, messageMaxAgeMs: 120_000 },
  mesh: { heartbeatMs: 10_000, peerTimeoutMs: 35_000, maxParticipants: 6, maxLiveViewers: 8 },
  stats: { intervalMs: 2_000 },
  push: {
    // `||` (not `??`): an empty variable from CI must also fall back to the default server.
    serverUrl: (env.VITE_PUSH_SERVER_URL || PUSH_SERVER_URL).replace(/\/+$/, ''),
    vapidPublicKey: env.VITE_VAPID_PUBLIC_KEY ?? '',
  },
  logLevel: env.VITE_LOG_LEVEL ?? 'INFO',
};

/** Human-readable, credential-free summary of ICE configuration for diagnostics. */
export function describeIceServers(servers: RTCIceServer[] = CONFIG.iceServers): string[] {
  return servers.flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]));
}

/**
 * Resolve the signaling server URL at runtime.
 * - If VITE_SERVER_URL was set at build time (local dev), use it directly.
 * - Otherwise fetch the current tunnel URL from the static pointer site.
 *   The pointer JSON is { server_url: "https://..." } and is updated by the server on each restart.
 */
export async function resolveServerUrl(): Promise<string> {
  if (env.VITE_SERVER_URL) return env.VITE_SERVER_URL.replace(/\/+$/, '');
  try {
    const res = await fetch(POINTER_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { server_url?: string };
    if (typeof json.server_url === 'string' && json.server_url) {
      return json.server_url.replace(/\/+$/, '');
    }
  } catch (err) {
    log.warn('Could not fetch pointer URL, falling back to default:', err);
  }
  return DEFAULT_SERVER_URL;
}
