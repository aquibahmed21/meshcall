import { BoundedSet } from '../core/async';
import { Emitter } from '../core/emitter';
import { createLogger } from '../core/logger';
import type { AppConfig } from '../config';
import type { IdentityService } from '../services/IdentityService';
import type { SignalingService } from '../services/SignalingService';
import type { MediaKind, NegotiationMessage } from '../types/signaling';
import type { PeerConnectionState } from '../types/state';
import { PeerSession, type EncodingPatch, type LocalMediaSource } from './PeerSession';
import type { WebRTCManager } from './WebRTCManager';

const log = createLogger('WebRTC');
const ORPHAN_TTL_MS = 30_000;
const ORPHAN_MAX = 150;
/** Circuit breaker: at most this many re-creations per remote peer per minute. */
const MAX_RECREATES_PER_MIN = 4;

export interface RemoteInfo {
  deviceId: string;
  sessionId: string;
  name: string;
}

export interface PeerManagerOptions {
  callId: string;
  send: boolean;
  receive: boolean;
  identity: IdentityService;
  signaling: SignalingService;
  webrtc: WebRTCManager;
  media: LocalMediaSource;
  config: AppConfig;
}

/** Deterministic, symmetric role: exactly one side of every pair is polite. */
export function isPolite(localDeviceId: string, localSessionId: string, remoteDeviceId: string, remoteSessionId: string): boolean {
  return `${localDeviceId}|${localSessionId}` > `${remoteDeviceId}|${remoteSessionId}`;
}

/**
 * Owns the mesh's RTCPeerConnections – one PeerSession per remote device.
 *
 * Rejoin rules (a *fresh* connection, never a stale one):
 *  - remote session id changed (reload / new tab)          → close old session, new one
 *  - offer arrives from a new remote pcId (remote recreated) → close old session, new one
 *  - messages from retired remote pcIds                      → dropped
 *  - candidates that arrive before the offer that creates their session are parked as
 *    "orphans" and replayed once the session exists
 * Remote MediaStreams are kept per participant so video tiles survive reconnects.
 */
export class PeerConnectionManager {
  readonly events = new Emitter<{
    peerState: { remoteId: string; state: PeerConnectionState };
    peerTrack: { remoteId: string };
    peerCreated: { remoteId: string; session: PeerSession };
    peerStalled: { remoteId: string; reason: string };
  }>();

  private sessions = new Map<string, PeerSession>();
  private streams = new Map<string, MediaStream>();
  private generations = new Map<string, number>();
  private retired = new Map<string, BoundedSet<string>>();
  private orphans = new Map<string, Array<{ msg: NegotiationMessage; at: number }>>();
  private recreates = new Map<string, number[]>();
  private disposed = false;

  constructor(private readonly opts: PeerManagerOptions) {}

  get(remoteId: string): PeerSession | undefined {
    return this.sessions.get(remoteId);
  }

  has(remoteId: string): boolean {
    return this.sessions.has(remoteId);
  }

  all(): PeerSession[] {
    return [...this.sessions.values()];
  }

  remoteStream(remoteId: string): MediaStream {
    let s = this.streams.get(remoteId);
    if (!s) {
      s = new MediaStream();
      this.streams.set(remoteId, s);
    }
    return s;
  }

  politeTowards(remote: RemoteInfo): boolean {
    return isPolite(this.opts.identity.deviceId, this.opts.identity.sessionId, remote.deviceId, remote.sessionId);
  }

  /** Create a brand-new connection where WE send the first offer. Replaces any existing one. */
  connectAsOfferer(remote: RemoteInfo, reason: string): PeerSession | null {
    if (this.disposed) return null;
    const existing = this.sessions.get(remote.deviceId);
    if (existing) {
      const now = Date.now();
      const recent = (this.recreates.get(remote.deviceId) ?? []).filter((t) => now - t < 60_000);
      if (recent.length >= MAX_RECREATES_PER_MIN) {
        log.error(`${remote.name}: too many re-creations in the last minute – not re-creating (${reason})`);
        return null;
      }
      recent.push(now);
      this.recreates.set(remote.deviceId, recent);
      this.closePeer(remote.deviceId, `recreate: ${reason}`, true);
    }
    const s = this.create(remote);
    if (existing) {
      this.opts.signaling.send(
        remote.deviceId,
        'peer-reconnect',
        { reason, pcId: s.pcId, targetPcId: null },
        { callId: this.opts.callId, peerId: s.pcId, receiverSessionId: remote.sessionId },
      );
    }
    s.startAsOfferer();
    return s;
  }

  handleNegotiation(msg: NegotiationMessage): void {
    if (this.disposed) return;
    const remoteId = msg.senderId;
    const fromPcId = msg.payload.pcId;
    if (this.retired.get(remoteId)?.has(fromPcId)) {
      log.debug(`Dropping ${msg.messageType} from retired connection of ${msg.senderName}`);
      return;
    }
    const remote: RemoteInfo = { deviceId: remoteId, sessionId: msg.senderSessionId, name: msg.senderName };
    let s = this.sessions.get(remoteId);

    if (s && s.remoteSessionId !== msg.senderSessionId) {
      if (msg.messageType !== 'offer') return this.park(msg);
      log.info(`${msg.senderName} rejoined with a new session – fresh peer connection`);
      this.closePeer(remoteId, 'remote-session-changed', true);
      s = undefined;
    } else if (s && s.remotePcId && fromPcId !== s.remotePcId) {
      if (msg.messageType === 'offer') {
        log.info(`${msg.senderName} re-created its connection – fresh peer connection`);
        this.closePeer(remoteId, 'remote-recreated', true);
        s = undefined;
      } else if (msg.messageType === 'ice-candidate') {
        return this.park(msg);
      } else {
        return;
      }
    }

    if (!s) {
      if (msg.messageType !== 'offer') {
        if (msg.messageType === 'ice-candidate') this.park(msg);
        return;
      }
      s = this.create(remote);
    }
    s.handleSignal(msg);
    this.replayOrphans(remoteId, fromPcId, s);
  }

  closePeer(remoteId: string, reason: string, keepStream = false): void {
    const s = this.sessions.get(remoteId);
    if (s) {
      this.sessions.delete(remoteId);
      const retired = this.retired.get(remoteId) ?? new BoundedSet<string>(50);
      if (s.remotePcId) retired.add(s.remotePcId);
      this.retired.set(remoteId, retired);
      s.close(reason);
    }
    if (!keepStream) {
      this.streams.get(remoteId)?.getTracks().forEach((t) => this.streams.get(remoteId)?.removeTrack(t));
      this.streams.delete(remoteId);
      this.orphans.delete(remoteId);
    }
  }

  closeAll(reason: string): void {
    for (const id of [...this.sessions.keys()]) this.closePeer(id, reason);
    this.streams.clear();
    this.orphans.clear();
  }

  dispose(reason: string): void {
    this.closeAll(reason);
    this.disposed = true;
    this.events.removeAllListeners();
  }

  async replaceTrack(kind: MediaKind, track: MediaStreamTrack | null): Promise<void> {
    await Promise.all(this.all().map((s) => s.replaceTrack(kind, track)));
  }

  async setEncodingAll(kind: MediaKind, patch: EncodingPatch): Promise<void> {
    await Promise.all(this.all().map((s) => s.setEncoding(kind, patch)));
  }

  // ── internals ────────────────────────────────────────────────────────────

  private create(remote: RemoteInfo): PeerSession {
    const generation = (this.generations.get(remote.deviceId) ?? -1) + 1;
    this.generations.set(remote.deviceId, generation);
    const { signaling, callId } = this.opts;
    const s = new PeerSession({
      remoteId: remote.deviceId,
      remoteSessionId: remote.sessionId,
      remoteName: remote.name,
      polite: this.politeTowards(remote),
      send: this.opts.send,
      receive: this.opts.receive,
      generation,
      remoteStream: this.remoteStream(remote.deviceId),
      media: this.opts.media,
      webrtc: this.opts.webrtc,
      config: this.opts.config,
      signal: (type, payload, pcId) =>
        signaling.send(remote.deviceId, type, payload, { callId, peerId: pcId, receiverSessionId: remote.sessionId }),
    });
    this.sessions.set(remote.deviceId, s);
    s.events.on('state', (state) => this.events.emit('peerState', { remoteId: remote.deviceId, state }));
    s.events.on('track', () => this.events.emit('peerTrack', { remoteId: remote.deviceId }));
    s.events.on('stalled', (reason) => this.events.emit('peerStalled', { remoteId: remote.deviceId, reason }));
    this.events.emit('peerCreated', { remoteId: remote.deviceId, session: s });
    this.events.emit('peerState', { remoteId: remote.deviceId, state: s.state });
    return s;
  }

  private park(msg: NegotiationMessage): void {
    const now = Date.now();
    const list = (this.orphans.get(msg.senderId) ?? []).filter((o) => now - o.at < ORPHAN_TTL_MS);
    list.push({ msg, at: now });
    if (list.length > ORPHAN_MAX) list.shift();
    this.orphans.set(msg.senderId, list);
  }

  private replayOrphans(remoteId: string, fromPcId: string, s: PeerSession): void {
    const list = this.orphans.get(remoteId);
    if (!list?.length) return;
    const now = Date.now();
    const matching = list.filter((o) => o.msg.payload.pcId === fromPcId && now - o.at < ORPHAN_TTL_MS);
    const rest = list.filter((o) => o.msg.payload.pcId !== fromPcId && now - o.at < ORPHAN_TTL_MS);
    if (rest.length) this.orphans.set(remoteId, rest);
    else this.orphans.delete(remoteId);
    for (const o of matching) s.handleSignal(o.msg);
  }
}
