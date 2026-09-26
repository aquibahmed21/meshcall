import { Disposer, Emitter } from '../core/emitter';
import { createLogger } from '../core/logger';
import type { AppConfig } from '../config';
import type { MediaManager } from '../media/MediaManager';
import type { NetworkChangeReason } from '../services/NetworkMonitor';
import type { IdentityService } from '../services/IdentityService';
import type { SettingsService } from '../services/SettingsService';
import { meshRoom, type SignalingService } from '../services/SignalingService';
import {
  isNegotiationMessage,
  type CallKind,
  type MediaStatePayload,
  type MeshMemberPayload,
  type MeshRole,
  type MessageOf,
  type PayloadOf,
  type SignalingMessage,
} from '../types/signaling';
import type { ParticipantState, PeerConnectionState } from '../types/state';
import { AdaptiveQualityManager } from '../webrtc/AdaptiveQualityManager';
import { ConnectionRecoveryManager } from '../webrtc/ConnectionRecoveryManager';
import { DataUsageMonitor, type DataUsageSnapshot } from '../webrtc/DataUsageMonitor';
import { PeerConnectionManager, type RemoteInfo } from '../webrtc/PeerConnectionManager';
import { StatsMonitor, type StatsReport } from '../webrtc/StatsMonitor';
import type { WebRTCManager } from '../webrtc/WebRTCManager';

const log = createLogger('Mesh');
const logCall = createLogger('Call');

export interface MeshDeps {
  identity: IdentityService;
  signaling: SignalingService;
  webrtc: WebRTCManager;
  media: MediaManager;
  settings: SettingsService;
  config: AppConfig;
}

export interface MeshOptions {
  callId: string;
  kind: CallKind;
  role: MeshRole;
  hostId: string;
  /** Direct calls: only these devices may connect. */
  allowList?: ReadonlySet<string>;
}

/**
 * Membership + mesh wiring for one call / stream.
 *
 * Protocol (room `mesh-<callId>` for broadcasts, inbox for directed messages):
 *   joiner  ──mesh-join (broadcast)──▶ members
 *   member  ──mesh-welcome (direct)──▶ joiner            (so the joiner learns who is there)
 *   For each pair, the IMPOLITE side (deterministic id comparison) creates the connection and
 *   sends the first offer as soon as it learns about the other (join / welcome / heartbeat).
 *   → no glare on join; Perfect Negotiation still covers every later collision.
 *   Every member heartbeats every MESH_HEARTBEAT (role, media state, and its pcId per peer),
 *   which heals missed joins and detects orphaned connections.
 *   mesh-leave closes exactly that participant's connection – the rest of the mesh is untouched.
 *
 * Rejoin handling:
 *   - new session id from a known device (reload) → close its old connection, brand-new one
 *   - same session re-announces (its signaling reconnected) → ICE restart on that one link, so
 *     the path is re-validated and direct P2P is tried again
 */
export class MeshSession {
  readonly events = new Emitter<{
    participants: void;
    peerState: { remoteId: string; state: PeerConnectionState };
    left: { deviceId: string; name: string; role: MeshRole; reason: string };
    removed: void;
    rejected: { reason: string };
    stats: { report: StatsReport; usage: DataUsageSnapshot };
  }>();

  readonly participants = new Map<string, ParticipantState>();
  readonly peers: PeerConnectionManager;
  readonly usage = new DataUsageMonitor();
  private readonly recovery: ConnectionRecoveryManager;
  private readonly stats: StatsMonitor;
  private readonly quality: AdaptiveQualityManager;
  private readonly disposer = new Disposer();
  private readonly banned = new Set<string>();
  private unsubscribeRoom: (() => void) | null = null;
  private signalingUpSince = Date.now();
  private mediaStateTimer: ReturnType<typeof setTimeout> | null = null;
  private warnedSameDevice = false;
  private joined = false;
  private closed = false;

  constructor(
    private readonly deps: MeshDeps,
    readonly opts: MeshOptions,
  ) {
    this.peers = new PeerConnectionManager({
      callId: opts.callId,
      send: opts.role !== 'viewer',
      receive: opts.role !== 'broadcaster',
      identity: deps.identity,
      signaling: deps.signaling,
      webrtc: deps.webrtc,
      media: deps.media,
      config: deps.config,
    });
    this.recovery = new ConnectionRecoveryManager(this.peers, deps.config, (id) => this.remoteInfo(id));
    this.stats = new StatsMonitor(() => this.peers.all(), deps.config.stats.intervalMs);
    this.quality = new AdaptiveQualityManager(deps.settings, deps.media, () => this.peers.all());
  }

  get callId(): string {
    return this.opts.callId;
  }

  get statsReport(): StatsReport {
    return this.stats.report;
  }

  join(): void {
    if (this.joined) return;
    this.joined = true;
    logCall.info(`Joining ${this.opts.kind} ${this.opts.callId.slice(0, 8)} as ${this.opts.role}`);
    const { signaling, media, settings, config } = this.deps;

    this.disposer.add(
      this.peers.events.on('peerState', ({ remoteId, state }) => {
        const p = this.participants.get(remoteId);
        const wasConnected = p?.peer?.connectionState === 'connected';
        if (p) p.peer = state.connectionState === 'closed' ? null : state;
        if (state.connectionState === 'connected' && !wasConnected) {
          const s = this.peers.get(remoteId);
          if (s) void this.quality.applyTo(s);
        }
        this.events.emit('peerState', { remoteId, state });
        this.events.emit('participants', undefined);
      }),
    );
    this.disposer.add(this.peers.events.on('peerCreated', ({ session }) => void this.quality.applyTo(session)));
    this.disposer.add(this.peers.events.on('peerTrack', () => this.events.emit('participants', undefined)));
    this.disposer.add(
      this.stats.events.on('report', (report) => {
        for (const snap of report.peers.values()) {
          this.usage.ingest({
            remoteId: snap.remoteId,
            name: snap.name,
            pcId: snap.pcId,
            bytesSent: snap.bytesSent,
            bytesReceived: snap.bytesReceived,
            sendBps: snap.sendBitrate,
            recvBps: snap.recvBitrate,
          });
          this.recovery.onPath(snap.remoteId, snap.path);
        }
        this.quality.onStats(report);
        this.events.emit('stats', { report, usage: this.usage.snapshot() });
      }),
    );
    this.disposer.add(
      media.events.on('track', ({ kind }) => {
        void this.peers.replaceTrack(kind, media.getSendTrack(kind)).then(() => {
          if (kind === 'video') this.quality.applyAll();
        });
      }),
    );
    this.disposer.add(media.events.on('state', () => this.scheduleMediaState()));
    this.disposer.add(
      settings.events.on('change', ({ changed }) => {
        if (changed.includes('videoQuality')) void media.applyVideoQuality(settings.get().videoQuality).then(() => this.quality.applyAll());
        else if (changed.includes('audioQuality')) this.quality.applyAll();
        if (changed.some((c) => c === 'echoCancellation' || c === 'noiseSuppression' || c === 'autoGainControl')) void media.applyAudioProcessing();
      }),
    );
    this.disposer.add(
      signaling.events.on('status', (s) => {
        if (s === 'connected') this.signalingUpSince = Date.now();
      }),
    );
    this.disposer.add(signaling.events.on('reconnected', () => this.onSignalingReconnected()));

    this.unsubscribeRoom = signaling.subscribe(meshRoom(this.opts.callId), { onOpen: () => this.announce('mesh-join') });
    this.disposer.interval(() => this.tick(), config.mesh.heartbeatMs);
    this.usage.reset();
    this.stats.start();
  }

  leave(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    logCall.info(`Leaving call ${this.opts.callId.slice(0, 8)} (${reason})`);
    if (this.joined) this.deps.signaling.broadcast(meshRoom(this.opts.callId), 'mesh-leave', { reason }, { callId: this.opts.callId });
    if (this.mediaStateTimer) clearTimeout(this.mediaStateTimer);
    this.disposer.dispose();
    this.stats.stop();
    this.recovery.dispose();
    this.quality.dispose();
    this.peers.dispose(reason);
    this.unsubscribeRoom?.();
    this.participants.clear();
    this.events.removeAllListeners();
  }

  handleMessage(msg: SignalingMessage): void {
    if (this.closed) return;
    if (msg.senderId === this.deps.identity.deviceId) {
      if (!this.warnedSameDevice) log.warn('This device joined the same call from another tab – ignoring it');
      this.warnedSameDevice = true;
      return;
    }
    const p = this.participants.get(msg.senderId);
    if (p && p.sessionId === msg.senderSessionId) p.lastSeen = Date.now();

    if (isNegotiationMessage(msg)) {
      if (!this.allowed(msg.senderId)) return;
      const role = p?.sessionId === msg.senderSessionId ? p.role : this.defaultRole(msg.senderId);
      if (!this.shouldConnect(role)) return;
      if (!p || p.sessionId !== msg.senderSessionId) {
        this.upsert(msg.senderId, msg.senderSessionId, msg.senderName, role, p?.media);
      }
      this.peers.handleNegotiation(msg);
      return;
    }

    switch (msg.messageType) {
      case 'mesh-join':
      case 'mesh-welcome':
      case 'mesh-heartbeat':
        this.onMember(msg);
        break;
      case 'mesh-leave':
        this.onLeave(msg);
        break;
      case 'mesh-remove':
        this.onRemove(msg);
        break;
      case 'mesh-reject':
        log.warn(`Join rejected by ${msg.senderName}: ${msg.payload.reason}`);
        this.events.emit('rejected', { reason: msg.payload.reason });
        break;
      case 'media-state':
        if (p) {
          p.media = msg.payload;
          this.events.emit('participants', undefined);
        }
        break;
      default:
        break;
    }
  }

  /** Host-only: remove a participant from a group call. */
  removeParticipant(deviceId: string): void {
    if (this.opts.hostId !== this.deps.identity.deviceId) return;
    this.deps.signaling.broadcast(meshRoom(this.opts.callId), 'mesh-remove', { targetId: deviceId }, { callId: this.opts.callId });
    this.drop(deviceId, 'removed by host');
    this.banned.add(deviceId);
  }

  onNetworkChange(reason: NetworkChangeReason): void {
    this.recovery.onNetworkChange(reason);
  }

  retryDirect(remoteId: string): void {
    this.recovery.retryDirect(remoteId);
  }

  remoteStream(deviceId: string): MediaStream {
    return this.peers.remoteStream(deviceId);
  }

  // ── membership ───────────────────────────────────────────────────────────

  private onMember(msg: MessageOf<'mesh-join'> | MessageOf<'mesh-welcome'> | MessageOf<'mesh-heartbeat'>): void {
    const { identity, config } = this.deps;
    const id = msg.senderId;
    const payload = msg.payload;
    const isJoin = msg.messageType === 'mesh-join';

    if (!this.allowed(id)) {
      if (isJoin) this.reply(msg, 'mesh-reject', { reason: 'not-allowed' });
      return;
    }
    // Live streams: viewers never see or connect to other viewers.
    if (!this.shouldConnect(payload.role)) return;
    const existing = this.participants.get(id);
    if (
      isJoin &&
      !existing &&
      this.opts.kind === 'live' &&
      this.opts.role === 'broadcaster' &&
      [...this.participants.values()].filter((p) => p.role === 'viewer').length >= config.mesh.maxLiveViewers
    ) {
      log.warn(`Stream full – rejecting ${msg.senderName}`);
      this.reply(msg, 'mesh-reject', { reason: 'full' });
      return;
    }

    if (
      isJoin &&
      !existing &&
      this.opts.kind === 'group' &&
      this.opts.hostId === identity.deviceId &&
      this.participants.size + 1 >= config.mesh.maxParticipants
    ) {
      log.warn(`Group full (${config.mesh.maxParticipants}) – rejecting ${msg.senderName}`);
      this.reply(msg, 'mesh-reject', { reason: 'full' });
      return;
    }

    const sessionChanged = !!existing && existing.sessionId !== msg.senderSessionId;
    const p = this.upsert(id, msg.senderSessionId, msg.senderName, payload.role, payload.media);
    const remote: RemoteInfo = { deviceId: id, sessionId: msg.senderSessionId, name: msg.senderName };
    if (!existing) logCall.info(`${msg.senderName} joined (${payload.role})`);

    if (sessionChanged) {
      logCall.info(`${msg.senderName} rejoined with a new session – discarding stale peer state`);
      this.peers.closePeer(id, 'remote rejoined', true);
      p.peer = null;
    }

    if (isJoin) {
      this.reply(msg, 'mesh-welcome', this.memberPayload());
      const s = this.peers.get(id);
      if (s && !sessionChanged) {
        // Same session announced again → its signaling reconnected; its network may have changed.
        const young = Date.now() - s.state.createdAt < config.timeouts.negotiationTimeoutMs;
        if (s.isConnected) s.restartIce('peer re-announced after reconnect');
        else if (!young && !this.peers.politeTowards(remote)) this.peers.connectAsOfferer(remote, 'peer rejoined');
        return;
      }
    }
    const s = this.peers.get(id);
    if (!s) {
      if (!this.peers.politeTowards(remote)) this.peers.connectAsOfferer(remote, msg.messageType);
      return;
    }
    if (msg.messageType === 'mesh-heartbeat' && s.remotePcId && Date.now() - s.state.createdAt > config.mesh.heartbeatMs * 2) {
      const theirPcForUs = payload.peers?.[identity.deviceId];
      if (theirPcForUs !== s.remotePcId) {
        // The remote does not know our current connection → it is orphaned on one side.
        log.warn(`${msg.senderName}: connection is orphaned (${theirPcForUs ? 'mismatch' : 'unknown to peer'}) – rebuilding`);
        if (!this.peers.politeTowards(remote)) this.peers.connectAsOfferer(remote, 'orphaned connection');
        else if (!theirPcForUs) this.peers.closePeer(id, 'orphaned', true);
      }
    }
  }

  private onLeave(msg: MessageOf<'mesh-leave'>): void {
    const p = this.participants.get(msg.senderId);
    if (!p || p.sessionId !== msg.senderSessionId) return; // stale leave from an old session
    this.drop(msg.senderId, msg.payload.reason);
  }

  private onRemove(msg: MessageOf<'mesh-remove'>): void {
    if (msg.senderId !== this.opts.hostId) return; // only the host may remove people
    if (msg.payload.targetId === this.deps.identity.deviceId) {
      logCall.warn('Removed from the call by the host');
      this.events.emit('removed', undefined);
      return;
    }
    this.banned.add(msg.payload.targetId);
    this.drop(msg.payload.targetId, 'removed by host');
  }

  private drop(deviceId: string, reason: string): void {
    const p = this.participants.get(deviceId);
    this.peers.closePeer(deviceId, reason);
    this.quality.forget(deviceId);
    if (!p) return;
    this.participants.delete(deviceId);
    logCall.info(`${p.name} left (${reason})`);
    this.events.emit('left', { deviceId, name: p.name, role: p.role, reason });
    this.events.emit('participants', undefined);
  }

  private tick(): void {
    this.announce('mesh-heartbeat');
    // Remove participants that went silent AND whose media path is dead. A participant whose
    // signaling is down but media still flows is kept.
    const { config, signaling } = this.deps;
    if (!signaling.isConnected || Date.now() - this.signalingUpSince < config.mesh.peerTimeoutMs) return;
    for (const p of [...this.participants.values()]) {
      if (Date.now() - p.lastSeen < config.mesh.peerTimeoutMs) continue;
      if (this.peers.get(p.deviceId)?.isConnected) continue;
      this.drop(p.deviceId, 'timed out');
    }
  }

  private onSignalingReconnected(): void {
    log.info('Signaling reconnected – re-announcing and re-validating peers');
    this.signalingUpSince = Date.now();
    for (const p of this.participants.values()) p.lastSeen = Date.now();
    this.announce('mesh-join');
    this.recovery.onSignalingRecovered();
  }

  private announce(type: 'mesh-join' | 'mesh-heartbeat'): void {
    if (this.closed) return;
    this.deps.signaling.broadcast(meshRoom(this.opts.callId), type, this.memberPayload(), { callId: this.opts.callId });
  }

  private reply<T extends 'mesh-welcome' | 'mesh-reject'>(to: SignalingMessage, type: T, payload: PayloadOf<T>): void {
    this.deps.signaling.send(to.senderId, type, payload, { callId: this.opts.callId, receiverSessionId: to.senderSessionId });
  }

  private memberPayload(): MeshMemberPayload {
    const peers: Record<string, string> = {};
    for (const s of this.peers.all()) peers[s.remoteId] = s.pcId;
    return { role: this.opts.role, callKind: this.opts.kind, media: this.localMediaState(), peers, hostId: this.opts.hostId };
  }

  localMediaState(): MediaStatePayload {
    const m = this.deps.media.state;
    if (this.opts.role === 'viewer') return { audioMuted: true, videoMuted: true, screenSharing: false };
    return { audioMuted: m.audioMuted || !m.hasAudio, videoMuted: !m.hasVideo, screenSharing: m.screenSharing };
  }

  private scheduleMediaState(): void {
    if (this.mediaStateTimer || this.closed) return;
    this.mediaStateTimer = setTimeout(() => {
      this.mediaStateTimer = null;
      if (this.closed) return;
      this.deps.signaling.broadcast(meshRoom(this.opts.callId), 'media-state', this.localMediaState(), { callId: this.opts.callId });
    }, 150);
  }

  private upsert(deviceId: string, sessionId: string, name: string, role: MeshRole, media?: MediaStatePayload): ParticipantState {
    const now = Date.now();
    let p = this.participants.get(deviceId);
    if (!p || p.sessionId !== sessionId) {
      p = {
        deviceId,
        sessionId,
        name,
        role,
        media: media ?? { audioMuted: false, videoMuted: false, screenSharing: false },
        joinedAt: now,
        lastSeen: now,
        peer: this.peers.get(deviceId)?.remoteSessionId === sessionId ? this.peers.get(deviceId)!.state : null,
      };
      this.participants.set(deviceId, p);
    } else {
      p.name = name || p.name;
      p.role = role;
      if (media) p.media = media;
      p.lastSeen = now;
    }
    this.events.emit('participants', undefined);
    return p;
  }

  private remoteInfo(deviceId: string): RemoteInfo | undefined {
    const p = this.participants.get(deviceId);
    return p ? { deviceId, sessionId: p.sessionId, name: p.name } : undefined;
  }

  private allowed(deviceId: string): boolean {
    if (this.banned.has(deviceId)) return false;
    return !this.opts.allowList || this.opts.allowList.has(deviceId);
  }

  private defaultRole(deviceId: string): MeshRole {
    if (this.opts.kind !== 'live') return 'participant';
    return deviceId === this.opts.hostId ? 'broadcaster' : 'viewer';
  }

  /** Live streams: only broadcaster↔viewer links. Calls: full mesh. */
  private shouldConnect(theirRole: MeshRole): boolean {
    if (this.opts.kind !== 'live') return true;
    return (this.opts.role === 'broadcaster') !== (theirRole === 'broadcaster');
  }
}
