/**
 * Data usage for the measurement scope "Current Call".
 *
 * Counters from getStats() are cumulative *per RTCPeerConnection* and restart at zero when a
 * connection is re-created (rejoin / recovery). We therefore accumulate positive deltas per
 * pcId, so totals survive reconnects and nothing is counted twice.
 */
export interface PeerUsage {
  remoteId: string;
  name: string;
  sentBytes: number;
  receivedBytes: number;
  sendBps: number;
  recvBps: number;
}

export interface DataUsageSnapshot {
  scope: 'Current Call';
  startedAt: number;
  uploadBytes: number;
  downloadBytes: number;
  uploadBps: number;
  downloadBps: number;
  peers: PeerUsage[];
}

interface Entry extends PeerUsage {
  pcId: string | null;
  lastSent: number;
  lastRecv: number;
  updatedAt: number;
}

const STALE_RATE_MS = 6_000;

export class DataUsageMonitor {
  private peers = new Map<string, Entry>();
  private startedAt = Date.now();

  reset(): void {
    this.peers.clear();
    this.startedAt = Date.now();
  }

  ingest(sample: { remoteId: string; name: string; pcId: string; bytesSent: number; bytesReceived: number; sendBps: number; recvBps: number; at?: number }): void {
    const at = sample.at ?? Date.now();
    let e = this.peers.get(sample.remoteId);
    if (!e) {
      e = { remoteId: sample.remoteId, name: sample.name, sentBytes: 0, receivedBytes: 0, sendBps: 0, recvBps: 0, pcId: null, lastSent: 0, lastRecv: 0, updatedAt: at };
      this.peers.set(sample.remoteId, e);
    }
    if (e.pcId !== sample.pcId) {
      // New RTCPeerConnection: its counters start from zero.
      e.pcId = sample.pcId;
      e.lastSent = 0;
      e.lastRecv = 0;
    }
    const dSent = sample.bytesSent >= e.lastSent ? sample.bytesSent - e.lastSent : sample.bytesSent;
    const dRecv = sample.bytesReceived >= e.lastRecv ? sample.bytesReceived - e.lastRecv : sample.bytesReceived;
    e.sentBytes += dSent;
    e.receivedBytes += dRecv;
    e.lastSent = sample.bytesSent;
    e.lastRecv = sample.bytesReceived;
    e.sendBps = sample.sendBps;
    e.recvBps = sample.recvBps;
    e.name = sample.name;
    e.updatedAt = at;
  }

  snapshot(now = Date.now()): DataUsageSnapshot {
    const peers: PeerUsage[] = [];
    let up = 0, down = 0, upBps = 0, downBps = 0;
    for (const e of this.peers.values()) {
      const fresh = now - e.updatedAt < STALE_RATE_MS;
      const p: PeerUsage = {
        remoteId: e.remoteId,
        name: e.name,
        sentBytes: e.sentBytes,
        receivedBytes: e.receivedBytes,
        sendBps: fresh ? e.sendBps : 0,
        recvBps: fresh ? e.recvBps : 0,
      };
      peers.push(p);
      up += p.sentBytes;
      down += p.receivedBytes;
      upBps += p.sendBps;
      downBps += p.recvBps;
    }
    return { scope: 'Current Call', startedAt: this.startedAt, uploadBytes: up, downloadBytes: down, uploadBps: upBps, downloadBps: downBps, peers };
  }
}
