import { Timer } from '../core/async';
import { Disposer } from '../core/emitter';
import { createLogger } from '../core/logger';
import type { AppConfig } from '../config';
import type { NetworkChangeReason } from '../services/NetworkMonitor';
import type { PeerConnectionState, SelectedPathInfo } from '../types/state';
import type { PeerConnectionManager, RemoteInfo } from './PeerConnectionManager';

const log = createLogger('Recovery');
const MAX_RELAY_PROBES = 3;

interface Tracker {
  pcId: string;
  /** Last connectionState we reacted to – attribute-only updates must not re-trigger recovery. */
  lastState: RTCPeerConnectionState | null;
  /** Re-entrancy guard: restart() emits state updates synchronously. */
  restarting: boolean;
  attempts: number;
  graceTimer: Timer;
  restartTimer: Timer;
  waitingForNetwork: boolean;
  everConnected: boolean;
  relaySince: number | null;
  probes: number;
}

/**
 * Per-mesh recovery policy (per peer):
 *
 *   connected     → reset attempts
 *   disconnected  → wait DISCONNECTED_GRACE (ICE often self-heals) → ICE restart
 *   failed        → ICE restart now
 *   restart did not reconnect within timeout → next ICE restart (timeout grows)
 *   > MAX_ICE_RESTARTS                       → brand-new RTCPeerConnection (full re-negotiation)
 *   offline       → pause; resume on "online"
 *   network change / wake → ICE restart for every peer (the old path may be stale; direct P2P
 *                           is tried again first because the candidate gate is re-armed)
 *
 * Only the impolite side escalates to re-creation immediately; the polite side waits one extra
 * restart interval. Both may do it concurrently – PeerConnectionManager/Perfect Negotiation
 * resolve that correctly – this just avoids needless duplicate work.
 */
export class ConnectionRecoveryManager {
  private trackers = new Map<string, Tracker>();
  private disposer = new Disposer();

  constructor(
    private readonly peers: PeerConnectionManager,
    private readonly config: AppConfig,
    private readonly remoteInfo: (remoteId: string) => RemoteInfo | undefined,
  ) {
    this.disposer.add(this.peers.events.on('peerState', ({ remoteId, state }) => this.onPeerState(remoteId, state)));
    this.disposer.add(this.peers.events.on('peerStalled', ({ remoteId, reason }) => this.recreate(remoteId, `negotiation stalled (${reason})`)));
  }

  dispose(): void {
    this.disposer.dispose();
    for (const t of this.trackers.values()) this.clear(t);
    this.trackers.clear();
  }

  onNetworkChange(reason: NetworkChangeReason): void {
    if (reason === 'offline') {
      log.warn('Offline – peer recovery paused until the network returns');
      return;
    }
    for (const s of this.peers.all()) {
      const t = this.tracker(s.remoteId, s.state.pcId);
      if (!s.pc.remoteDescription) continue; // still in first negotiation – nothing stale yet
      const healthy = s.isConnected;
      if (reason === 'resume' && healthy) continue;
      t.attempts = 0;
      t.waitingForNetwork = false;
      this.restart(s.remoteId, `network ${reason}`);
    }
  }

  onSignalingRecovered(): void {
    for (const s of this.peers.all()) {
      if (!s.isConnected && s.pc.remoteDescription) this.restart(s.remoteId, 'signaling recovered');
    }
  }

  onPath(remoteId: string, path: SelectedPathInfo | undefined): void {
    const probeMs = this.config.ice.relayUpgradeProbeMs;
    const s = this.peers.get(remoteId);
    if (!probeMs || !s || !s.isConnected) return;
    const t = this.tracker(remoteId, s.state.pcId);
    if (path?.path !== 'relay') {
      t.relaySince = null;
      return;
    }
    t.relaySince ??= Date.now();
    if (s.state.polite || t.probes >= MAX_RELAY_PROBES || Date.now() - t.relaySince < probeMs) return;
    t.probes++;
    t.relaySince = Date.now();
    log.info(`${s.name}: on TURN relay for a while – probing for a direct path (${t.probes}/${MAX_RELAY_PROBES})`);
    s.restartIce('relay-upgrade-probe');
  }

  /** Explicit "retry P2P" from diagnostics. */
  retryDirect(remoteId: string): void {
    const s = this.peers.get(remoteId);
    if (s) s.restartIce('manual P2P retry');
  }

  private onPeerState(remoteId: string, state: PeerConnectionState): void {
    if (state.connectionState === 'closed') {
      const t = this.trackers.get(remoteId);
      if (t && t.pcId === state.pcId) {
        this.clear(t);
        this.trackers.delete(remoteId);
      }
      return;
    }
    const t = this.tracker(remoteId, state.pcId);
    if (t.restarting || state.connectionState === t.lastState) return;
    t.lastState = state.connectionState;
    switch (state.connectionState) {
      case 'connected':
        if (t.attempts > 0) log.info(`${this.name(remoteId)}: recovered after ${t.attempts} attempt(s)`);
        this.clear(t);
        t.attempts = 0;
        t.everConnected = true;
        this.peers.get(remoteId)?.setReconnectAttempts(0);
        break;
      case 'disconnected':
        if (!t.graceTimer.active && !t.restartTimer.active) {
          t.graceTimer.start(this.config.timeouts.disconnectedGraceMs, () => {
            const s = this.peers.get(remoteId);
            if (s && s.state.pcId === t.pcId && !s.isConnected) this.restart(remoteId, 'disconnected');
          });
        }
        break;
      case 'failed':
        t.graceTimer.clear();
        if (!t.restartTimer.active) this.restart(remoteId, 'failed');
        break;
      case 'new':
      case 'connecting':
        // Initial connection watchdog – ICE "failed" can take ~30 s in some browsers.
        if (!t.everConnected && !t.restartTimer.active && t.attempts === 0) {
          t.restartTimer.start(this.config.timeouts.iceRestartTimeoutMs * 2, () => {
            const s = this.peers.get(remoteId);
            if (s && s.state.pcId === t.pcId && !s.isConnected) this.restart(remoteId, 'initial connect timeout');
          });
        }
        break;
    }
  }

  private restart(remoteId: string, reason: string): void {
    const s = this.peers.get(remoteId);
    if (!s || s.isClosed) return;
    const t = this.tracker(remoteId, s.state.pcId);
    if (t.restarting) return;
    if (!navigator.onLine) {
      if (!t.waitingForNetwork) log.info(`${s.name}: offline – waiting for network before recovering`);
      t.waitingForNetwork = true;
      return;
    }
    t.attempts++;
    const max = this.config.timeouts.maxIceRestarts + (s.state.polite ? 1 : 0);
    if (t.attempts > max) {
      this.recreate(remoteId, `${t.attempts - 1} ICE restarts did not recover`);
      return;
    }
    // Arm the timer BEFORE any side effect that can emit state synchronously.
    const timeout = Math.min(30_000, this.config.timeouts.iceRestartTimeoutMs * t.attempts);
    t.restartTimer.start(timeout, () => {
      const cur = this.peers.get(remoteId);
      if (cur && cur.state.pcId === t.pcId && !cur.isConnected) this.restart(remoteId, 'restart timeout');
    });
    t.restarting = true;
    try {
      s.setReconnectAttempts(t.attempts);
      s.restartIce(`${reason}, attempt ${t.attempts}`);
    } finally {
      t.restarting = false;
    }
  }

  private recreate(remoteId: string, reason: string): void {
    const remote = this.remoteInfo(remoteId);
    if (!remote) return;
    log.warn(`${remote.name}: re-creating peer connection (${reason})`);
    const old = this.trackers.get(remoteId);
    if (old) this.clear(old);
    this.trackers.delete(remoteId);
    this.peers.connectAsOfferer(remote, reason);
  }

  private tracker(remoteId: string, pcId: string): Tracker {
    let t = this.trackers.get(remoteId);
    if (!t || t.pcId !== pcId) {
      if (t) this.clear(t);
      t = { pcId, lastState: null, restarting: false, attempts: 0, graceTimer: new Timer(), restartTimer: new Timer(), waitingForNetwork: false, everConnected: false, relaySince: null, probes: 0 };
      this.trackers.set(remoteId, t);
    }
    return t;
  }

  private clear(t: Tracker): void {
    t.graceTimer.clear();
    t.restartTimer.clear();
  }

  private name(remoteId: string): string {
    return this.peers.get(remoteId)?.name ?? remoteId.slice(0, 8);
  }
}
