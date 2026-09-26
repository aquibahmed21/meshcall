import { describe, expect, it } from 'vitest';
import { DataUsageMonitor } from '../../src/webrtc/DataUsageMonitor';
import { classifyQuality, parseStats, type StatsReportLike } from '../../src/webrtc/StatsParser';

function report(entries: Array<Record<string, unknown>>): StatsReportLike {
  const map = new Map(entries.map((e) => [e.id as string, e as never]));
  return { forEach: (cb) => map.forEach((v) => cb(v)), get: (id) => map.get(id) };
}

const base = (bytesSent: number, bytesReceived: number, lost = 0, recv = 100) => [
  { id: 'T1', type: 'transport', bytesSent, bytesReceived, selectedCandidatePairId: 'CP1' },
  { id: 'CP1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', currentRoundTripTime: 0.05, availableOutgoingBitrate: 2_000_000, bytesSent, bytesReceived },
  { id: 'CP2', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R1', bytesSent: 999, bytesReceived: 999 },
  { id: 'L1', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp', address: '1.2.3.4' },
  { id: 'L2', type: 'local-candidate', candidateType: 'host', protocol: 'udp' },
  { id: 'R1', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' },
  { id: 'IA', type: 'inbound-rtp', kind: 'audio', bytesReceived: 1000, packetsLost: lost, packetsReceived: recv, jitter: 0.01, codecId: 'C1' },
  { id: 'C1', type: 'codec', mimeType: 'audio/opus' },
];

describe('parseStats', () => {
  it('uses the SELECTED pair (transport.selectedCandidatePairId) for the path', () => {
    const s = parseStats(report(base(1000, 2000)), undefined, 1000);
    expect(s.path?.connectionType).toBe('TURN');
    expect(s.path?.pairLabel).toBe('relay → srflx');
    expect(s.path?.relayProtocol).toBe('TCP');
    expect(s.rttMs).toBe(50);
    expect(s.audio.codec).toBe('audio/opus');
  });

  it('uses transport bytes only – candidate pairs are not added on top (no double counting)', () => {
    const s = parseStats(report(base(1000, 2000)), undefined, 1000);
    expect(s.bytesSent).toBe(1000);
    expect(s.bytesReceived).toBe(2000);
  });

  it('computes bitrates and loss from deltas', () => {
    const a = parseStats(report(base(0, 0, 0, 100)), undefined, 0);
    const b = parseStats(report(base(125_000, 250_000, 10, 190)), a.counters, 1000);
    expect(b.sendBitrate).toBe(1_000_000);
    expect(b.recvBitrate).toBe(2_000_000);
    expect(b.lossPct).toBeCloseTo(10);
  });

  it('falls back to Firefox-style selected pair', () => {
    const r = report([
      { id: 'CP', type: 'candidate-pair', selected: true, localCandidateId: 'L', remoteCandidateId: 'R', bytesSent: 10, bytesReceived: 20 },
      { id: 'L', type: 'local-candidate', candidateType: 'host' },
      { id: 'R', type: 'remote-candidate', candidateType: 'host' },
    ]);
    const s = parseStats(r, undefined, 0);
    expect(s.path?.connectionType).toBe('P2P');
    expect(s.bytesReceived).toBe(20);
  });
});

describe('classifyQuality', () => {
  it('maps metrics to levels', () => {
    expect(classifyQuality({ rttMs: 40, lossPct: 0 })).toBe('excellent');
    expect(classifyQuality({ rttMs: 250, lossPct: 1 })).toBe('good');
    expect(classifyQuality({ rttMs: 100, lossPct: 6 })).toBe('poor');
    expect(classifyQuality({ rttMs: 900 })).toBe('critical');
    expect(classifyQuality({ stalled: true })).toBe('critical');
    expect(classifyQuality({})).toBe('unknown');
  });
});

describe('DataUsageMonitor', () => {
  it('accumulates across a peer connection re-creation without double counting', () => {
    const u = new DataUsageMonitor();
    const s = (pcId: string, sent: number, recv: number) => u.ingest({ remoteId: 'john', name: 'John', pcId, bytesSent: sent, bytesReceived: recv, sendBps: 0, recvBps: 0 });
    s('pc1', 100, 200);
    s('pc1', 300, 500);
    s('pc1', 300, 500); // same sample twice → no change
    s('pc2', 50, 70); // new connection starts from zero
    const snap = u.snapshot();
    expect(snap.uploadBytes).toBe(350);
    expect(snap.downloadBytes).toBe(570);
    expect(snap.scope).toBe('Current Call');
  });

  it('sums multiple peers', () => {
    const u = new DataUsageMonitor();
    u.ingest({ remoteId: 'a', name: 'A', pcId: '1', bytesSent: 10, bytesReceived: 20, sendBps: 1, recvBps: 2 });
    u.ingest({ remoteId: 'b', name: 'B', pcId: '2', bytesSent: 30, bytesReceived: 40, sendBps: 3, recvBps: 4 });
    const s = u.snapshot();
    expect([s.uploadBytes, s.downloadBytes, s.uploadBps, s.downloadBps]).toEqual([40, 60, 4, 6]);
  });
});
