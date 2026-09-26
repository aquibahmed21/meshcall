import { Emitter } from '../core/emitter';
import { formatBitrate, formatMs } from '../core/format';
import { createLogger, errorMessage } from '../core/logger';
import type { NetworkQuality } from '../types/state';
import type { PeerSession } from './PeerSession';
import { classifyQuality, parseStats, type ParsedStats, type RawCounters } from './StatsParser';

const logStats = createLogger('Stats');
const logNet = createLogger('Network');
const EWMA = 0.4;
const STALL_SAMPLES = 3;

export interface PeerStatsSnapshot extends Omit<ParsedStats, 'counters'> {
  remoteId: string;
  name: string;
  pcId: string;
  timestamp: number;
  quality: NetworkQuality;
  smoothedRttMs?: number;
  smoothedLossPct?: number;
}

export interface StatsReport {
  timestamp: number;
  peers: Map<string, PeerStatsSnapshot>;
}

interface PeerTrack {
  pcId: string;
  counters?: RawCounters;
  rtt?: number;
  loss?: number;
  idleSamples: number;
}

/**
 * Polls RTCPeerConnection.getStats() for every live peer at a fixed interval.
 * pc.getStats() is a superset of RTCRtpSender/Receiver.getStats(); using a single report per
 * peer per tick is what guarantees that nothing is counted twice.
 * Also feeds the selected candidate pair back into each PeerSession (the source of truth for
 * P2P / STUN / TURN classification).
 */
export class StatsMonitor {
  readonly events = new Emitter<{ report: StatsReport }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tracks = new Map<string, PeerTrack>();
  private busy = false;
  private latest: StatsReport = { timestamp: 0, peers: new Map() };

  constructor(
    private readonly sessions: () => PeerSession[],
    private readonly intervalMs: number,
  ) {}

  get report(): StatsReport {
    return this.latest;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  reset(): void {
    this.tracks.clear();
    this.latest = { timestamp: 0, peers: new Map() };
  }

  async poll(): Promise<void> {
    if (this.busy) return; // never overlap polls on slow devices
    this.busy = true;
    try {
      const now = Date.now();
      const peers = new Map<string, PeerStatsSnapshot>();
      await Promise.all(
        this.sessions().map(async (s) => {
          if (s.isClosed) return;
          try {
            const snap = await this.sample(s, now);
            if (snap) peers.set(s.remoteId, snap);
          } catch (err) {
            logStats.throttled(`fail-${s.remoteId}`, 30_000, 'DEBUG', `getStats failed for ${s.name}`, errorMessage(err));
          }
        }),
      );
      for (const id of [...this.tracks.keys()]) if (!this.sessions().some((s) => s.remoteId === id)) this.tracks.delete(id);
      this.latest = { timestamp: now, peers };
      this.logSummary(peers);
      this.events.emit('report', this.latest);
    } finally {
      this.busy = false;
    }
  }

  private async sample(s: PeerSession, now: number): Promise<PeerStatsSnapshot | null> {
    const report = await s.pc.getStats();
    let t = this.tracks.get(s.remoteId);
    if (!t || t.pcId !== s.pcId) {
      t = { pcId: s.pcId, idleSamples: 0 }; // new RTCPeerConnection → counters restart at 0
      this.tracks.set(s.remoteId, t);
    }
    const parsed = parseStats(report as unknown as Parameters<typeof parseStats>[0], t.counters, now);
    const { counters, ...rest } = parsed;
    const hadPrev = !!t.counters;
    t.counters = counters;

    if (parsed.rttMs !== undefined) t.rtt = t.rtt === undefined ? parsed.rttMs : t.rtt * (1 - EWMA) + parsed.rttMs * EWMA;
    const lossNow = Math.max(parsed.lossPct ?? 0, parsed.outboundLossPct ?? 0);
    if (parsed.lossPct !== undefined || parsed.outboundLossPct !== undefined) {
      t.loss = t.loss === undefined ? lossNow : t.loss * (1 - EWMA) + lossNow * EWMA;
    }
    // Transport bytesReceived includes RTCP and STUN consent checks, so zero growth while
    // "connected" means the path is effectively dead.
    if (s.isConnected && hadPrev && parsed.recvBitrate === 0) t.idleSamples++;
    else t.idleSamples = 0;

    s.updateSelectedPath(parsed.path);
    const quality = s.isConnected
      ? classifyQuality({ rttMs: t.rtt, lossPct: t.loss, jitterMs: parsed.jitterMs, stalled: t.idleSamples >= STALL_SAMPLES })
      : 'unknown';

    return { ...rest, remoteId: s.remoteId, name: s.name, pcId: s.pcId, timestamp: now, quality, smoothedRttMs: t.rtt, smoothedLossPct: t.loss };
  }

  private logSummary(peers: Map<string, PeerStatsSnapshot>): void {
    if (!peers.size) return;
    let up = 0;
    let down = 0;
    for (const p of peers.values()) {
      up += p.sendBitrate;
      down += p.recvBitrate;
      logNet.throttled(`rtt-${p.remoteId}`, 30_000, 'DEBUG', `${p.name}: RTT = ${formatMs(p.smoothedRttMs)}, quality ${p.quality}`);
    }
    logStats.throttled('summary', 30_000, 'DEBUG', `Upload = ${formatBitrate(up)}, Download = ${formatBitrate(down)}`);
  }
}
