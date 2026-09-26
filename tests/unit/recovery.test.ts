import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../src/config';
import { Emitter } from '../../src/core/emitter';
import type { PeerConnectionState } from '../../src/types/state';
import { ConnectionRecoveryManager } from '../../src/webrtc/ConnectionRecoveryManager';
import { emptyCounts } from '../../src/webrtc/IceStrategy';
import type { PeerConnectionManager } from '../../src/webrtc/PeerConnectionManager';

/** Fake session that – like the real PeerSession – emits state synchronously on every patch. */
function fakeWorld() {
  const events = new Emitter<{ peerState: { remoteId: string; state: PeerConnectionState }; peerStalled: { remoteId: string; reason: string } }>();
  let pcSeq = 0;
  const calls = { restartIce: 0, recreate: 0, restartsBeforeFirstRecreate: -1 };
  const makeSession = () => {
    const state: PeerConnectionState = {
      peerId: 'bob', pcId: `pc${++pcSeq}`, generation: pcSeq, polite: false, connectionState: 'new', iceConnectionState: 'new',
      iceGatheringState: 'new', signalingState: 'stable', reconnectAttempts: 0, iceRestarts: 0, recreations: 0, gate: 'holding',
      localCandidates: emptyCounts(), remoteCandidates: emptyCounts(), iceErrors: [], createdAt: Date.now(),
    };
    const s = {
      remoteId: 'bob', name: 'Bob', state, isClosed: false,
      get isConnected() { return s.state.connectionState === 'connected'; },
      pc: { remoteDescription: {} },
      set(conn: RTCPeerConnectionState) { s.state = { ...s.state, connectionState: conn }; events.emit('peerState', { remoteId: 'bob', state: s.state }); },
      setReconnectAttempts(n: number) { s.state = { ...s.state, reconnectAttempts: n }; events.emit('peerState', { remoteId: 'bob', state: s.state }); },
      restartIce() { calls.restartIce++; },
    };
    return s;
  };
  let current = makeSession();
  const peers = {
    events,
    get: () => current,
    all: () => [current],
    connectAsOfferer: () => { if (calls.recreate === 0) calls.restartsBeforeFirstRecreate = calls.restartIce; calls.recreate++; current = makeSession(); events.emit('peerState', { remoteId: 'bob', state: current.state }); return current; },
  } as unknown as PeerConnectionManager;
  const rec = new ConnectionRecoveryManager(peers, CONFIG, () => ({ deviceId: 'bob', sessionId: 's', name: 'Bob' }));
  return { rec, calls, session: () => current };
}

describe('ConnectionRecoveryManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { onLine: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a failed peer triggers exactly one ICE restart (no synchronous re-entrancy storm)', () => {
    const { calls, session } = fakeWorld();
    session().set('connected');
    session().set('failed');
    expect(calls.restartIce).toBe(1);
    expect(calls.recreate).toBe(0);
  });

  it('escalates to a fresh connection only after MAX_ICE_RESTARTS timeouts', () => {
    const { calls, session } = fakeWorld();
    session().set('connected');
    session().set('failed');
    for (let i = 0; i < 10; i++) vi.advanceTimersByTime(CONFIG.timeouts.iceRestartTimeoutMs * 3);
    expect(calls.restartsBeforeFirstRecreate).toBe(CONFIG.timeouts.maxIceRestarts);
    expect(calls.recreate).toBeGreaterThanOrEqual(1);
    expect(calls.recreate).toBeLessThan(5); // paced by timeouts, never a tight loop
  });

  it('disconnected waits for the grace period before restarting', () => {
    const { calls, session } = fakeWorld();
    session().set('connected');
    session().set('disconnected');
    expect(calls.restartIce).toBe(0);
    vi.advanceTimersByTime(CONFIG.timeouts.disconnectedGraceMs + 1);
    expect(calls.restartIce).toBe(1);
  });

  it('recovering before the grace period means no restart', () => {
    const { calls, session } = fakeWorld();
    session().set('connected');
    session().set('disconnected');
    session().set('connected');
    vi.advanceTimersByTime(CONFIG.timeouts.disconnectedGraceMs + 1);
    expect(calls.restartIce).toBe(0);
  });

  it('network change restarts ICE on healthy peers too (path may be stale → retry P2P)', () => {
    const { rec, calls, session } = fakeWorld();
    session().set('connected');
    rec.onNetworkChange('connection-change');
    expect(calls.restartIce).toBe(1);
    rec.onNetworkChange('resume'); // resume only touches unhealthy peers
    expect(calls.restartIce).toBe(1);
  });
});

describe('ConnectionRecoveryManager offline handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { onLine: false });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not burn restart attempts while the browser is offline', () => {
    const { calls, session } = fakeWorld();
    session().set('connected');
    session().set('failed');
    expect(calls.restartIce).toBe(0);
  });
});
