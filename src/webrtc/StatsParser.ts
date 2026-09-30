/**
 * Pure getStats() parsing – unit-testable without a browser.
 *
 * Data usage source of truth (never summed across layers, to avoid double counting):
 *   1. RTCTransportStats.bytesSent/bytesReceived   (all RTP+RTCP+DTLS+STUN on the bundle transport)
 *   2. fallback (no transport stats, e.g. Firefox): sum of candidate-pair bytes – each packet is
 *      sent on exactly one pair, so the sum is still not double-counted.
 * Per-media bitrates come from outbound-rtp / inbound-rtp and are shown separately.
 */
import type { NetworkQuality, SelectedPathInfo } from '../types/state';
import { classifyPath } from './IceStrategy';

type Stat = Record<string, unknown> & { id: string; type: string; timestamp?: number };
export interface StatsReportLike {
  forEach(cb: (value: Stat) => void): void;
  get(id: string): Stat | undefined;
}

export interface RawCounters {
  ts: number;
  bytesSent: number;
  bytesReceived: number;
  audioSent: number;
  audioRecv: number;
  videoSent: number;
  videoRecv: number;
  packetsLost: number;
  packetsReceived: number;
}

export interface MediaStats {
  codec?: string;
  sendBitrate: number;
  recvBitrate: number;
}

export interface VideoStats extends MediaStats {
  sendWidth?: number;
  sendHeight?: number;
  sendFps?: number;
  recvWidth?: number;
  recvHeight?: number;
  recvFps?: number;
  framesDropped: number;
  qualityLimitationReason?: string;
}

export interface ParsedStats {
  path?: SelectedPathInfo;
  rttMs?: number;
  jitterMs?: number;
  lossPct?: number;
  outboundLossPct?: number;
  availableOutgoingBitrate?: number;
  availableIncomingBitrate?: number;
  bytesSent: number;
  bytesReceived: number;
  sendBitrate: number;
  recvBitrate: number;
  packetsLost: number;
  packetsReceived: number;
  packetsDiscarded: number;
  audio: MediaStats;
  video: VideoStats;
  counters: RawCounters;
}

const n = (s: Stat | undefined, key: string): number | undefined => {
  const v = s?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};
const str = (s: Stat | undefined, key: string): string | undefined => {
  const v = s?.[key];
  return typeof v === 'string' ? v : undefined;
};

function selectedPair(report: StatsReportLike): Stat | undefined {
  let pair: Stat | undefined;
  report.forEach((s) => {
    if (!pair && s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') pair = report.get(s.selectedCandidatePairId);
  });
  if (pair) return pair;
  // Firefox: `selected`; others: nominated + succeeded (pick the busiest)
  let best: Stat | undefined;
  report.forEach((s) => {
    if (s.type !== 'candidate-pair') return;
    const isSel = s.selected === true || (s.nominated === true && s.state === 'succeeded');
    if (!isSel) return;
    if (!best || (n(s, 'bytesReceived') ?? 0) + (n(s, 'bytesSent') ?? 0) > (n(best, 'bytesReceived') ?? 0) + (n(best, 'bytesSent') ?? 0)) best = s;
  });
  return best;
}

function rate(cur: number, prev: number | undefined, dtMs: number): number {
  if (prev === undefined || dtMs <= 0 || cur < prev) return 0;
  return ((cur - prev) * 8 * 1000) / dtMs;
}

export function parseStats(report: StatsReportLike, prev: RawCounters | undefined, now: number): ParsedStats {
  const pair = selectedPair(report);
  let path: SelectedPathInfo | undefined;
  if (pair) {
    const local = report.get(String(pair.localCandidateId));
    const remote = report.get(String(pair.remoteCandidateId));
    if (local && remote) {
      path = classifyPath(
        {
          candidateType: str(local, 'candidateType'),
          protocol: str(local, 'protocol'),
          relayProtocol: str(local, 'relayProtocol'),
          address: str(local, 'address') ?? str(local, 'ip'),
          port: n(local, 'port'),
          url: str(local, 'url'),
        },
        { candidateType: str(remote, 'candidateType'), protocol: str(remote, 'protocol'), address: str(remote, 'address') ?? str(remote, 'ip') },
      );
    }
  }

  let transportSent: number | undefined;
  let transportRecv: number | undefined;
  let pairSumSent = 0;
  let pairSumRecv = 0;
  let remoteInboundRtt: number | undefined;
  let outboundLoss: number | undefined;
  const audio: MediaStats = { sendBitrate: 0, recvBitrate: 0 };
  const video: VideoStats = { sendBitrate: 0, recvBitrate: 0, framesDropped: 0 };
  let audioSent = 0, audioRecv = 0, videoSent = 0, videoRecv = 0;
  let packetsLost = 0, packetsReceived = 0, packetsDiscarded = 0;
  let jitterMs: number | undefined;

  report.forEach((s) => {
    switch (s.type) {
      case 'transport':
        transportSent = (transportSent ?? 0) + (n(s, 'bytesSent') ?? 0);
        transportRecv = (transportRecv ?? 0) + (n(s, 'bytesReceived') ?? 0);
        break;
      case 'candidate-pair':
        pairSumSent += n(s, 'bytesSent') ?? 0;
        pairSumRecv += n(s, 'bytesReceived') ?? 0;
        break;
      case 'outbound-rtp': {
        const kind = str(s, 'kind') ?? str(s, 'mediaType');
        const bytes = (n(s, 'bytesSent') ?? 0) + (n(s, 'headerBytesSent') ?? 0);
        const codec = str(report.get(String(s.codecId)), 'mimeType');
        if (kind === 'audio') {
          audioSent += bytes;
          audio.codec ??= codec;
        } else if (kind === 'video') {
          videoSent += bytes;
          video.codec ??= codec;
          video.sendWidth = n(s, 'frameWidth') ?? video.sendWidth;
          video.sendHeight = n(s, 'frameHeight') ?? video.sendHeight;
          video.sendFps = n(s, 'framesPerSecond') ?? video.sendFps;
          video.qualityLimitationReason = str(s, 'qualityLimitationReason') ?? video.qualityLimitationReason;
        }
        break;
      }
      case 'inbound-rtp': {
        const kind = str(s, 'kind') ?? str(s, 'mediaType');
        const bytes = (n(s, 'bytesReceived') ?? 0) + (n(s, 'headerBytesReceived') ?? 0);
        packetsLost += Math.max(0, n(s, 'packetsLost') ?? 0);
        packetsReceived += n(s, 'packetsReceived') ?? 0;
        packetsDiscarded += n(s, 'packetsDiscarded') ?? 0;
        const codec = str(report.get(String(s.codecId)), 'mimeType');
        if (kind === 'audio') {
          audioRecv += bytes;
          audio.codec ??= codec;
          const j = n(s, 'jitter');
          if (j !== undefined) jitterMs = j * 1000;
        } else if (kind === 'video') {
          videoRecv += bytes;
          video.codec ??= codec;
          video.recvWidth = n(s, 'frameWidth') ?? video.recvWidth;
          video.recvHeight = n(s, 'frameHeight') ?? video.recvHeight;
          video.recvFps = n(s, 'framesPerSecond') ?? video.recvFps;
          video.framesDropped += n(s, 'framesDropped') ?? 0;
          const j = n(s, 'jitter');
          if (j !== undefined && jitterMs === undefined) jitterMs = j * 1000;
        }
        break;
      }
      case 'remote-inbound-rtp': {
        const rtt = n(s, 'roundTripTime');
        if (rtt !== undefined) remoteInboundRtt = Math.max(remoteInboundRtt ?? 0, rtt * 1000);
        const fl = n(s, 'fractionLost');
        if (fl !== undefined) outboundLoss = Math.max(outboundLoss ?? 0, fl * 100);
        break;
      }
    }
  });

  const bytesSent = transportSent ?? pairSumSent;
  const bytesReceived = transportRecv ?? pairSumRecv;
  const dt = prev ? now - prev.ts : 0;
  audio.sendBitrate = rate(audioSent, prev?.audioSent, dt);
  audio.recvBitrate = rate(audioRecv, prev?.audioRecv, dt);
  video.sendBitrate = rate(videoSent, prev?.videoSent, dt);
  video.recvBitrate = rate(videoRecv, prev?.videoRecv, dt);

  let lossPct: number | undefined;
  if (prev) {
    const dLost = packetsLost - prev.packetsLost;
    const dRecv = packetsReceived - prev.packetsReceived;
    if (dLost >= 0 && dRecv >= 0 && dLost + dRecv > 0) lossPct = (dLost / (dLost + dRecv)) * 100;
  }

  const pairRtt = n(pair, 'currentRoundTripTime');
  return {
    path,
    rttMs: pairRtt !== undefined ? pairRtt * 1000 : remoteInboundRtt,
    jitterMs,
    lossPct,
    outboundLossPct: outboundLoss,
    availableOutgoingBitrate: n(pair, 'availableOutgoingBitrate'),
    availableIncomingBitrate: n(pair, 'availableIncomingBitrate'),
    bytesSent,
    bytesReceived,
    sendBitrate: rate(bytesSent, prev?.bytesSent, dt),
    recvBitrate: rate(bytesReceived, prev?.bytesReceived, dt),
    packetsLost,
    packetsReceived,
    packetsDiscarded,
    audio,
    video,
    counters: { ts: now, bytesSent, bytesReceived, audioSent, audioRecv, videoSent, videoRecv, packetsLost, packetsReceived },
  };
}

export interface QualityInput {
  rttMs?: number;
  lossPct?: number;
  outboundLossPct?: number;
  jitterMs?: number;
  stalled?: boolean;
}

/** Excellent / Good / Poor / Critical from smoothed metrics. */
export function classifyQuality(m: QualityInput): NetworkQuality {
  if (m.stalled) return 'critical';
  const loss = Math.max(m.lossPct ?? 0, m.outboundLossPct ?? 0);
  if (m.rttMs === undefined && m.lossPct === undefined && m.outboundLossPct === undefined) return 'unknown';
  const rtt = m.rttMs ?? 0;
  const jitter = m.jitterMs ?? 0;
  if (rtt >= 800 || loss >= 12) return 'critical';
  if (rtt >= 400 || loss >= 5 || jitter >= 80) return 'poor';
  if (rtt >= 200 || loss >= 2 || jitter >= 40) return 'good';
  return 'excellent';
}
