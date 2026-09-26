import { Emitter } from '../core/emitter';
import { createLogger } from '../core/logger';
import type { AppConfig } from '../config';
import type { IdentityService } from '../services/IdentityService';
import { LOBBY_ROOM, type SignalingService } from '../services/SignalingService';
import type { StreamInfoPayload, StreamMessage } from '../types/signaling';
import type { CallState } from '../types/state';
import type { CallManager } from './CallManager';
import { isTerminal } from './CallStateMachine';

const log = createLogger('Live');
const ANNOUNCE_MS = 15_000;
const EXPIRE_MS = 45_000;

export interface LiveStream extends StreamInfoPayload {
  hostId: string;
  hostName: string;
  lastSeen: number;
}

/**
 * Mesh live streaming: the broadcaster opens one RTCPeerConnection *per viewer* and uploads a
 * full copy of its audio/video to each of them (viewers never connect to each other).
 * Upstream bandwidth ≈ bitrate × viewers, which is why viewers are capped
 * (config.mesh.maxLiveViewers). This is NOT a scalable broadcast – that needs an SFU.
 *
 * Streams are discovered via `stream-announce` heartbeats in the lobby.
 */
export class LiveStreamManager {
  readonly events = new Emitter<{ streams: LiveStream[] }>();
  private streams = new Map<string, LiveStream>();
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private current: StreamInfoPayload | null = null;

  constructor(
    private readonly calls: CallManager,
    private readonly signaling: SignalingService,
    private readonly identity: IdentityService,
    private readonly config: AppConfig,
  ) {}

  start(): void {
    this.signaling.events.on('message', ({ msg }) => {
      if (msg.messageType === 'stream-announce' || msg.messageType === 'stream-end') this.onStream(msg);
    });
    this.calls.events.on('state', (s) => this.onCallState(s));
    setInterval(() => this.expire(), 10_000);
  }

  list(): LiveStream[] {
    return [...this.streams.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  async goLive(title: string): Promise<void> {
    const streamId = await this.calls.startLive(title || `${this.identity.displayName}'s stream`);
    if (!streamId) return;
    this.current = { streamId, title: title || `${this.identity.displayName}'s stream`, viewers: 0, maxViewers: this.config.mesh.maxLiveViewers, startedAt: Date.now() };
    log.info(`Live: "${this.current.title}"`);
    this.announce();
    this.announceTimer = setInterval(() => this.announce(), ANNOUNCE_MS);
  }

  join(streamId: string): void {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.calls.joinLive(streamId, { deviceId: s.hostId, name: s.hostName }, s.title);
  }

  private onCallState(s: CallState | null): void {
    if (!this.current) return;
    if (!s || s.callId !== this.current.streamId || isTerminal(s.status)) {
      this.signaling.broadcast(LOBBY_ROOM, 'stream-end', this.current, { callId: this.current.streamId });
      log.info('Stream ended');
      this.current = null;
      if (this.announceTimer) clearInterval(this.announceTimer);
      this.announceTimer = null;
      return;
    }
    const viewers = [...s.participants.values()].filter((p) => p.role === 'viewer').length;
    if (viewers !== this.current.viewers) {
      this.current.viewers = viewers;
      this.announce();
    }
  }

  private announce(): void {
    if (!this.current) return;
    this.signaling.broadcast(LOBBY_ROOM, 'stream-announce', this.current, { callId: this.current.streamId });
  }

  private onStream(msg: StreamMessage): void {
    const p = msg.payload;
    if (msg.messageType === 'stream-end') {
      if (this.streams.delete(p.streamId)) this.emit();
      return;
    }
    this.streams.set(p.streamId, { ...p, hostId: msg.senderId, hostName: msg.senderName, lastSeen: Date.now() });
    this.emit();
  }

  private expire(): void {
    let changed = false;
    for (const [id, s] of this.streams) {
      if (Date.now() - s.lastSeen > EXPIRE_MS) {
        this.streams.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private emit(): void {
    this.events.emit('streams', this.list());
  }
}
