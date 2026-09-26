/**
 * P2P-first ICE strategy.
 *
 * WebRTC's ICE agent (RFC 8445) already ranks candidate pairs by type preference:
 *     host (126) > peer-reflexive (110) > server-reflexive (100) > relay (0)
 * so a working direct pair always outranks a relayed one. We deliberately do NOT munge SDP
 * priorities – the browser defaults are the correct "direct first" configuration – and we use
 * iceTransportPolicy "all" so host, srflx and relay candidates are all gathered.
 *
 * On top of that native preference, the CandidateGate adds a configurable *P2P window*:
 * local relay (TURN) candidates are gathered in parallel (so there is no extra latency if they
 * are needed) but are not trickled to the remote peer until either
 *   - direct connectivity succeeded (then they are sent as standby fallback pairs),
 *   - the window (DIRECT_P2P_TIMEOUT_MS) elapsed without a connection,
 *   - ICE reported disconnected/failed, or
 *   - gathering finished and we have no non-relay candidates at all.
 * The gate never tears anything down; it only controls *when* fallback candidates become
 * available to the remote agent. It is re-armed on every fresh connection and every ICE
 * restart, so each join / rejoin / network change gives direct P2P a fresh head start.
 */
import type { CandidateCounts, GateState, IceCandidateType, PathCategory, SelectedPathInfo } from '../types/state';

export function parseCandidateType(candidate: string | undefined | null): IceCandidateType | null {
  if (!candidate) return null;
  const m = / typ (host|srflx|prflx|relay)/.exec(candidate);
  return (m?.[1] as IceCandidateType | undefined) ?? null;
}

export function parseCandidateProtocol(candidate: string | undefined | null): string | null {
  if (!candidate) return null;
  // candidate:<foundation> <component> <transport> <priority> <address> <port> typ …
  const parts = candidate.replace(/^a=/, '').split(' ');
  return parts[2]?.toLowerCase() ?? null;
}

/** Dedupe key: same candidate line for the same ICE generation (ufrag) and m-line. */
export function candidateKey(c: RTCIceCandidateInit): string {
  return `${c.usernameFragment ?? ''}|${c.sdpMid ?? ''}|${c.sdpMLineIndex ?? ''}|${c.candidate ?? ''}`;
}

export function emptyCounts(): CandidateCounts {
  return { host: 0, srflx: 0, prflx: 0, relay: 0 };
}

const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export function isPrivateAddress(address: string | undefined): boolean {
  if (!address) return false;
  if (address.endsWith('.local')) return true; // mDNS-obfuscated host candidate
  if (PRIVATE_V4.test(address)) return true;
  const a = address.toLowerCase();
  return a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd') || a === '::1';
}

export interface CandidateLike {
  candidateType?: string;
  protocol?: string;
  relayProtocol?: string;
  address?: string;
  ip?: string;
  port?: number;
  url?: string;
}

/**
 * Classify the *selected* candidate pair (from getStats) into a network path.
 *  - either side relay           → TURN (media relayed through the TURN server)
 *  - host ↔ host                  → P2P  (direct, same network)
 *  - srflx/prflx involved         → STUN (direct P2P through NAT, discovered via STUN;
 *                                   media does NOT flow through the STUN server)
 *    …except a prflx between two private addresses, which is really a LAN path
 *    (typical with mDNS-obfuscated host candidates) → P2P
 */
export function classifyPath(local: CandidateLike, remote: CandidateLike): SelectedPathInfo {
  const lt = (local.candidateType ?? 'host') as IceCandidateType;
  const rt = (remote.candidateType ?? 'host') as IceCandidateType;
  const localAddress = local.address ?? local.ip;
  const remoteAddress = remote.address ?? remote.ip;
  let path: PathCategory;
  if (lt === 'relay' || rt === 'relay') path = 'relay';
  else if (lt === 'host' && rt === 'host') path = 'direct-host';
  else if (
    (lt === 'host' || lt === 'prflx') &&
    (rt === 'host' || rt === 'prflx') &&
    isPrivateAddress(localAddress) &&
    isPrivateAddress(remoteAddress)
  )
    path = 'direct-host';
  else path = 'direct-stun';

  const connectionType = path === 'relay' ? 'TURN' : path === 'direct-host' ? 'P2P' : 'STUN';
  const pathLabel =
    path === 'relay'
      ? lt === 'relay' && rt === 'relay'
        ? 'TURN relay (both sides relayed)'
        : 'TURN relay'
      : path === 'direct-host'
        ? 'Direct P2P (host / LAN)'
        : 'Direct P2P via NAT traversal (STUN)';
  return {
    localType: lt,
    remoteType: rt,
    pairLabel: `${lt} → ${rt}`,
    connectionType,
    path,
    pathLabel,
    transport: (local.protocol ?? 'udp').toUpperCase(),
    relayProtocol: lt === 'relay' ? local.relayProtocol?.toUpperCase() : undefined,
    localAddress,
    remoteAddress,
    turnUrl: lt === 'relay' ? local.url : undefined,
  };
}

export interface GateOptions {
  mode: 'gated' | 'native';
  /** Delay before srflx candidates are sent (0 = immediately). */
  srflxDelayMs: number;
  /** Delay before relay candidates are sent (the P2P window). */
  relayDelayMs: number;
}

type ReleaseReason = 'connected' | 'timeout' | 'failure' | 'gathering';

/**
 * Holds back fallback candidates for a bounded window per ICE generation.
 * `emit` is called for every candidate that may be sent to the remote peer.
 */
export class CandidateGate {
  private held: Array<{ type: IceCandidateType; init: RTCIceCandidateInit }> = [];
  private srflxOpen = false;
  private relayOpen = false;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private sentNonRelay = 0;
  private _state: GateState = 'holding';
  private generation = 0;

  constructor(
    private readonly opts: GateOptions,
    private readonly emit: (c: RTCIceCandidateInit, type: IceCandidateType | null) => void,
    private readonly onRelease: (reason: ReleaseReason, count: number) => void,
  ) {}

  get state(): GateState {
    return this._state;
  }

  /** Start a new window. Called for every new ICE generation (fresh PC or ICE restart). */
  arm(): void {
    this.clearTimers();
    this.generation++;
    this.held = []; // candidates of the previous generation are useless after a restart
    this.sentNonRelay = 0;
    if (this.opts.mode === 'native') {
      this.srflxOpen = this.relayOpen = true;
      this._state = 'native';
      return;
    }
    this._state = 'holding';
    this.srflxOpen = this.opts.srflxDelayMs <= 0;
    this.relayOpen = false;
    const gen = this.generation;
    if (!this.srflxOpen) {
      this.timers.push(setTimeout(() => gen === this.generation && this.openSrflx(), this.opts.srflxDelayMs));
    }
    this.timers.push(setTimeout(() => gen === this.generation && this.release('timeout'), this.opts.relayDelayMs));
  }

  offer(candidate: RTCIceCandidate | RTCIceCandidateInit): void {
    const init: RTCIceCandidateInit =
      'toJSON' in candidate && typeof candidate.toJSON === 'function' ? candidate.toJSON() : (candidate as RTCIceCandidateInit);
    const type = parseCandidateType(init.candidate);
    if (type === 'relay' && !this.relayOpen) {
      this.held.push({ type, init });
      return;
    }
    if (type === 'srflx' && !this.srflxOpen) {
      this.held.push({ type, init });
      return;
    }
    if (type !== 'relay') this.sentNonRelay++;
    this.emit(init, type);
  }

  /** ICE gathering finished for this generation. */
  gatheringComplete(): void {
    if (this.relayOpen) return;
    const heldNonRelay = this.held.some((h) => h.type !== 'relay');
    if (this.sentNonRelay === 0 && !heldNonRelay) this.release('gathering'); // relay is all we have
  }

  release(reason: ReleaseReason): void {
    if (this.relayOpen && this.srflxOpen) return;
    this.clearTimers();
    this.srflxOpen = this.relayOpen = true;
    this._state =
      reason === 'connected'
        ? 'released-connected'
        : reason === 'timeout'
          ? 'released-timeout'
          : reason === 'failure'
            ? 'released-failure'
            : 'released-gathering';
    const held = this.held;
    this.held = [];
    for (const h of held) this.emit(h.init, h.type);
    this.onRelease(reason, held.length);
  }

  dispose(): void {
    this.clearTimers();
    this.held = [];
    this.generation++;
  }

  private openSrflx(): void {
    this.srflxOpen = true;
    const keep: typeof this.held = [];
    for (const h of this.held) {
      if (h.type === 'srflx') {
        this.sentNonRelay++;
        this.emit(h.init, h.type);
      } else keep.push(h);
    }
    this.held = keep;
  }

  private clearTimers(): void {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }
}
