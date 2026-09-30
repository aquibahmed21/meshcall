import { describeIceServers } from '../config';
import { formatBitrate, formatMs, formatPct } from '../core/format';
import type { ConnectionPath, ParticipantState, ServerIdentification } from '../types/state';
import type { PeerStatsSnapshot } from '../webrtc/StatsMonitor';

export type PeerNetStatus = 'connected' | 'connecting' | 'reconnecting' | 'failed' | 'waiting';

/** Everything the UI shows about how ONE participant is connected – all from getStats(). */
export interface PeerNetInfo {
  status: PeerNetStatus;
  statusLabel: string;
  path: ConnectionPath;
  pathLabel: 'P2P' | 'STUN' | 'TURN' | 'Unknown';
  pair?: string;
  protocol?: string;
  relayProtocol?: string;
  server?: ServerIdentification;
  rttMs?: number;
  lossPct?: number;
  upBps?: number;
  downBps?: number;
}

const STATUS_LABEL: Record<PeerNetStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  failed: 'Failed – recovering',
  waiting: 'Waiting',
};

export function peerNetInfo(p: ParticipantState, snap: PeerStatsSnapshot | undefined): PeerNetInfo {
  const s = p.peer;
  let status: PeerNetStatus = 'waiting';
  if (s) {
    if (s.connectionState === 'connected') status = 'connected';
    else if (s.connectionState === 'failed') status = 'failed';
    else if (s.connectionState === 'disconnected') status = 'reconnecting';
    else if (s.connectionState === 'new' || s.connectionState === 'connecting') status = s.connectedAt ? 'reconnecting' : 'connecting';
  }
  // The path is only meaningful for a connected pair – otherwise it is Unknown, never a guess.
  const sel = status === 'connected' ? s?.selectedPath : undefined;
  const path: ConnectionPath = sel?.connectionPath ?? 'unknown';
  const loss = snap ? Math.max(snap.smoothedLossPct ?? snap.lossPct ?? 0, snap.outboundLossPct ?? 0) : undefined;
  return {
    status,
    statusLabel: STATUS_LABEL[status],
    path,
    pathLabel: path === 'p2p' ? 'P2P' : path === 'stun' ? 'STUN' : path === 'turn' ? 'TURN' : 'Unknown',
    pair: sel?.pairLabel,
    protocol: sel?.transport,
    relayProtocol: sel?.relayProtocol,
    server: sel?.server,
    rttMs: status === 'connected' ? (snap?.smoothedRttMs ?? snap?.rttMs) : undefined,
    lossPct: status === 'connected' ? loss : undefined,
    upBps: status === 'connected' ? snap?.sendBitrate : undefined,
    downBps: status === 'connected' ? snap?.recvBitrate : undefined,
  };
}

/** "TURN Server: turn:…" / "STUN Server: …" row, or honest "not identifiable" text. */
export function serverRow(info: PeerNetInfo): [string, string] | null {
  const srv = info.server;
  if (!srv || srv.role === 'none') return null;
  const label = srv.role === 'turn' ? 'TURN Server' : 'STUN Server';
  if (srv.url) return [label, `${srv.url}${srv.source === 'gathering' ? ' (from ICE gathering)' : ''}`];
  if (srv.side === 'remote') return [label, srv.note];
  const configured = describeIceServers().filter((u) => (srv.role === 'turn' ? /^turns?:/i : /^stun:/i).test(u));
  return [label, `${srv.role === 'turn' ? 'Relay' : 'Server-reflexive'} candidate detected – the browser did not say which server.\nConfigured: ${configured.join(', ') || 'none'}`];
}

/** Rows for tiles / diagnostics (same wording everywhere). */
export function netRows(info: PeerNetInfo): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Status', info.statusLabel],
    ['Connection', info.pathLabel],
    ['ICE', info.pair ?? '—'],
  ];
  const srv = serverRow(info);
  if (srv) rows.push(srv);
  if (info.protocol) rows.push(['Protocol', `${info.protocol}${info.relayProtocol ? ` (to TURN: ${info.relayProtocol})` : ''}`]);
  if (info.status === 'connected') {
    rows.push(['RTT', formatMs(info.rttMs)], ['Packet Loss', formatPct(info.lossPct)], ['Upload', formatBitrate(info.upBps)], ['Download', formatBitrate(info.downBps)]);
  }
  return rows;
}
