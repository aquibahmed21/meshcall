import { Emitter } from '../core/emitter';
import { uuid } from '../core/ids';
import { createLogger } from '../core/logger';
import type { AppConfig } from '../config';
import type { FileMeta, SignalingMessage } from '../types/signaling';
import { blobStore } from './BlobStore';
import type { SignalingService } from './SignalingService';

const log = createLogger('File');

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
const CHUNK = 16 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
/** Images/audio/video up to this size are fetched automatically (like a chat app's media download). */
export const AUTO_DOWNLOAD_BYTES = 8 * 1024 * 1024;

export interface TransferProgress {
  status: 'downloading' | 'failed';
  pct: number;
  detail?: string;
}

interface Session {
  pc: RTCPeerConnection;
  peerId: string;
  fileId: string;
  queued: RTCIceCandidateInit[];
  remoteSet: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export function isFileMeta(v: unknown): v is FileMeta {
  const f = v as Partial<FileMeta> | null;
  return !!f && typeof f.id === 'string' && f.id.length <= 64 && typeof f.name === 'string' && typeof f.size === 'number' && f.size >= 0 && f.size <= MAX_FILE_BYTES && typeof f.mime === 'string';
}

/**
 * Peer-to-peer file sharing for chats. The receiver asks, a dedicated RTCDataChannel is negotiated
 * over the normal signaling channel, and the bytes flow directly between the two devices – never
 * through the signaling server. Both sides keep their copy in IndexedDB.
 */
export class FileTransferService {
  readonly events = new Emitter<{ change: void }>();
  private progress = new Map<string, TransferProgress>();
  private urls = new Map<string, string>();
  private loading = new Set<string>();
  private sessions = new Map<string, Session>();
  private off: (() => void) | null = null;
  /** Set by the app: may this peer fetch this file? (only the conversation partner it was sent to) */
  authorize: (fileId: string, peerId: string) => boolean = () => false;

  constructor(
    private readonly signaling: SignalingService,
    private readonly config: AppConfig,
  ) {}

  start(): void {
    this.off?.();
    this.off = this.signaling.events.on('message', ({ msg }) => void this.onMessage(msg));
  }

  stop(): void {
    this.off?.();
    this.off = null;
    for (const t of [...this.sessions.keys()]) this.close(t);
    this.progress.clear();
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
  }

  /** Keep a file we are about to send, so the contact can fetch it. */
  async offer(file: File): Promise<FileMeta | 'too-big'> {
    if (file.size > MAX_FILE_BYTES) return 'too-big';
    const meta: FileMeta = { id: uuid(), name: (file.name || 'file').slice(0, 120), size: file.size, mime: file.type || 'application/octet-stream' };
    await blobStore.put(meta.id, file);
    this.urls.set(meta.id, URL.createObjectURL(file));
    this.events.emit('change', undefined);
    return meta;
  }

  /** Object URL once the file is on this device (null → not downloaded yet). Loads from disk lazily. */
  url(fileId: string): string | null {
    const u = this.urls.get(fileId);
    if (u) return u;
    if (!this.loading.has(fileId)) {
      this.loading.add(fileId);
      void blobStore.get(fileId).then((b) => {
        if (b) {
          this.urls.set(fileId, URL.createObjectURL(b));
          this.events.emit('change', undefined);
        }
        this.loading.delete(fileId);
      });
    }
    return null;
  }

  state(fileId: string): TransferProgress | undefined {
    return this.progress.get(fileId);
  }

  async blob(fileId: string): Promise<Blob | null> {
    return (await blobStore.get(fileId)) ?? null;
  }

  // ── receiving ────────────────────────────────────────────────────────────

  download(meta: FileMeta, peerId: string): void {
    if (this.progress.get(meta.id)?.status === 'downloading' || this.urls.has(meta.id) || !this.signaling.isConnected) return;
    const tid = uuid();
    const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
    const s: Session = { pc, peerId, fileId: meta.id, queued: [], remoteSet: false };
    this.sessions.set(tid, s);
    this.setProgress(meta.id, { status: 'downloading', pct: 0 });
    const chunks: ArrayBuffer[] = [];
    let got = 0;
    const fail = (detail: string) => {
      this.setProgress(meta.id, { status: 'failed', pct: 0, detail });
      this.close(tid);
    };
    const arm = () => {
      clearTimeout(s.timer);
      s.timer = setTimeout(() => fail('No response – is the sender online?'), 20_000);
    };
    arm();
    const dc = pc.createDataChannel('file');
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e) => {
      arm();
      if (typeof e.data === 'string') {
        if (e.data !== 'done') return;
        if (got !== meta.size) return fail('Incomplete');
        const blob = new Blob(chunks, { type: meta.mime });
        void blobStore.put(meta.id, blob);
        this.urls.set(meta.id, URL.createObjectURL(blob));
        this.progress.delete(meta.id);
        this.events.emit('change', undefined);
        this.close(tid);
        return;
      }
      chunks.push(e.data as ArrayBuffer);
      got += (e.data as ArrayBuffer).byteLength;
      this.setProgress(meta.id, { status: 'downloading', pct: meta.size ? Math.min(99, Math.round((got / meta.size) * 100)) : 0 });
    };
    pc.onicecandidate = (e) => e.candidate && this.signal(peerId, { fileId: meta.id, tid, kind: 'ice', data: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => pc.connectionState === 'failed' && fail('Connection failed');
    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.signal(peerId, { fileId: meta.id, tid, kind: 'offer', data: { type: offer.type, sdp: offer.sdp } });
      } catch (err) {
        fail(String(err));
      }
    })();
  }

  // ── sending / signaling ──────────────────────────────────────────────────

  private signal(peerId: string, payload: { fileId: string; tid: string; kind: 'offer' | 'answer' | 'ice' | 'error'; data?: unknown }): void {
    this.signaling.send(peerId, 'file-signal', payload as never, {});
  }

  private async onMessage(msg: SignalingMessage): Promise<void> {
    if (msg.messageType !== 'file-signal') return;
    const { fileId, tid, kind, data } = msg.payload as { fileId: string; tid: string; kind: string; data?: unknown };
    if (typeof fileId !== 'string' || typeof tid !== 'string') return;
    let s = this.sessions.get(tid);
    if (s && s.peerId !== msg.senderId) return;

    if (kind === 'offer') {
      // We are the sender: serve the file, but only to the person it was shared with.
      if (!this.authorize(fileId, msg.senderId)) return this.signal(msg.senderId, { fileId, tid, kind: 'error', data: 'Not available' });
      const blob = await blobStore.get(fileId);
      if (!blob) return this.signal(msg.senderId, { fileId, tid, kind: 'error', data: 'The sender no longer has this file' });
      const pc = new RTCPeerConnection({ iceServers: this.config.iceServers });
      s = { pc, peerId: msg.senderId, fileId, queued: [], remoteSet: false };
      s.timer = setTimeout(() => this.close(tid), 120_000);
      this.sessions.set(tid, s);
      pc.onicecandidate = (e) => e.candidate && this.signal(msg.senderId, { fileId, tid, kind: 'ice', data: e.candidate.toJSON() });
      pc.ondatachannel = (e) => void this.pump(e.channel, blob, tid);
      await pc.setRemoteDescription(data as RTCSessionDescriptionInit);
      s.remoteSet = true;
      await pc.setLocalDescription(await pc.createAnswer());
      this.signal(msg.senderId, { fileId, tid, kind: 'answer', data: { type: pc.localDescription!.type, sdp: pc.localDescription!.sdp } });
      for (const c of s.queued.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
    } else if (kind === 'answer' && s) {
      await s.pc.setRemoteDescription(data as RTCSessionDescriptionInit);
      s.remoteSet = true;
      for (const c of s.queued.splice(0)) await s.pc.addIceCandidate(c).catch(() => undefined);
    } else if (kind === 'ice' && s) {
      if (s.remoteSet) await s.pc.addIceCandidate(data as RTCIceCandidateInit).catch(() => undefined);
      else s.queued.push(data as RTCIceCandidateInit);
    } else if (kind === 'error' && s) {
      this.setProgress(s.fileId, { status: 'failed', pct: 0, detail: typeof data === 'string' ? data : 'Failed' });
      this.close(tid);
    }
  }

  private async pump(dc: RTCDataChannel, blob: Blob, tid: string): Promise<void> {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = HIGH_WATER / 2;
    if (dc.readyState !== 'open') await new Promise<void>((r) => (dc.onopen = () => r()));
    try {
      for (let off = 0; off < blob.size; off += CHUNK) {
        if (dc.readyState !== 'open') return;
        if (dc.bufferedAmount > HIGH_WATER) await new Promise<void>((r) => (dc.onbufferedamountlow = () => r()));
        dc.send(await blob.slice(off, off + CHUNK).arrayBuffer());
      }
      dc.send('done');
      // Let the tail drain before tearing the connection down.
      while (dc.bufferedAmount > 0 && dc.readyState === 'open') await new Promise((r) => setTimeout(r, 100));
      setTimeout(() => this.close(tid), 1500);
    } catch (err) {
      log.warn('Sending file failed', String(err));
      this.close(tid);
    }
  }

  private setProgress(id: string, p: TransferProgress): void {
    this.progress.set(id, p);
    this.events.emit('change', undefined);
  }

  private close(tid: string): void {
    const s = this.sessions.get(tid);
    if (!s) return;
    clearTimeout(s.timer);
    s.pc.close();
    this.sessions.delete(tid);
  }
}
