import { Disposer, Emitter } from '../core/emitter';
import { createLogger } from '../core/logger';
import type { AppConfig } from '../config';
import type { IdentityService } from '../services/IdentityService';
import type { PresenceService } from '../services/PresenceService';
import type { NotifyResult, PushNotificationService } from '../services/PushNotificationService';
import { lobbyRoom, type SignalingService } from '../services/SignalingService';
import type { AudienceMode, LiveStreamInfo, LiveStreamMessage, PayloadOf, SignalingMessage } from '../types/signaling';
import type { CallState } from '../types/state';
import type { CallManager } from './CallManager';
import { isTerminal } from './CallStateMachine';

const log = createLogger('Live');
const ANNOUNCE_MS = 15_000;
const EXPIRE_MS = 45_000;

/** A stream visible to this user (room-scoped discovery). */
export interface LiveStream extends LiveStreamInfo {
  hostId: string;
  hostName: string;
  lastSeen: number;
}

export type ViewerStatus = 'not-selected' | 'available' | 'invited' | 'connecting' | 'streaming' | 'disconnected';

export interface StreamViewerState {
  userId: string;
  name: string;
  /** Streamer's decision – the ONLY thing that lets media flow to this user. */
  allowed: boolean;
  /** WebRTC link to this viewer is up. */
  connected: boolean;
  /** Media is being sent to this viewer right now. */
  streamActive: boolean;
  status: ViewerStatus;
  /** Measured upload to this viewer (transport stats), bps. */
  uploadBps: number;
}

export interface LiveStreamState {
  streamId: string;
  streamerId: string;
  title: string;
  audienceMode: AudienceMode;
  selectedViewerIds: Set<string>;
  viewers: Map<string, StreamViewerState>;
  startedAt: number;
}

export interface LiveInvite {
  streamId: string;
  title: string;
  hostId: string;
  hostName: string;
  /** The streamer is actively calling (ring + attention), not just adding us to the audience. */
  ring?: boolean;
}

/**
 * Outcome of calling someone into the stream:
 *  ringing      – online: ringing invitation delivered over signaling
 *  push         – offline/unknown: targeted push accepted by the push server (not proof of delivery)
 *  waiting      – offline/unknown and no targeted push available: they are rung as soon as they come online
 */
export type LiveCallResult = 'ringing' | 'push' | 'waiting' | 'watching' | 'not-live';

/**
 * Mesh live streaming with audience control.
 *
 * Streamer: one RTCPeerConnection per ALLOWED viewer. The audience decision is enforced inside
 * the broadcaster's MeshSession (authorize callback) on every join and negotiation message –
 * unselected users never get a connection, so they never receive the media. Removing a viewer
 * closes only that viewer's connection (media stops) and bars reconnection.
 *
 * Signaling (all room-scoped, all carrying streamId = callId):
 *   lobby   live-started (+ heartbeat) · live-audience-updated · live-stopped
 *   inbox   live-viewer-added / live-viewer-removed   (streamer → viewer)
 *           live-viewer-joined / live-viewer-left     (viewer → streamer)
 * Audience-changing messages are only accepted from the stream's own streamer.
 *
 * Mesh cost: the streamer uploads one full copy per viewer (≈ bitrate × viewers).
 */
export class LiveStreamManager {
  readonly events = new Emitter<{ streams: LiveStream[]; state: LiveStreamState | null; invite: LiveInvite }>();
  private streams = new Map<string, LiveStream>();
  private current: LiveStreamState | null = null;
  private announceTimer: ReturnType<typeof setInterval> | null = null;
  private disposer = new Disposer();
  private uploadByViewer = new Map<string, number>();
  /** Viewer side: the stream we are currently watching (to send joined/left). */
  private watching: { streamId: string; hostId: string } | null = null;
  private lastViewerCount = -1;
  /** People the streamer called into the stream who have not joined yet → call expiry. */
  private calling = new Map<string, { until: number; rungOnline: boolean }>();

  constructor(
    private readonly calls: CallManager,
    private readonly signaling: SignalingService,
    private readonly identity: IdentityService,
    private readonly presence: PresenceService,
    private readonly config: AppConfig,
    private readonly push: PushNotificationService,
  ) {}

  /** Enter the room: listen for stream signaling of THIS room only. */
  start(): void {
    this.stop();
    this.disposer.add(this.signaling.events.on('message', ({ msg }) => this.onMessage(msg)));
    this.disposer.add(this.calls.events.on('state', (s) => this.onCallState(s)));
    this.disposer.add(this.calls.events.on('stats', ({ usage }) => this.onUsage(usage.peers)));
    this.disposer.add(
      this.presence.events.on('change', () => {
        if (!this.current) return;
        this.ringCalledWhenOnline();
        this.emitState();
      }),
    );
    this.disposer.interval(() => this.expire(), 10_000);
    // Viewer closing/reloading the page: tell the streamer right away (frees the upload slot).
    this.disposer.listen(window, 'pagehide', () => {
      if (this.watching) this.signaling.send(this.watching.hostId, 'live-viewer-left', { streamId: this.watching.streamId }, { callId: this.watching.streamId });
    });
  }

  /** Leave the room: stop announcing, forget streams and any live state. */
  stop(): void {
    this.disposer.dispose();
    if (this.announceTimer) clearInterval(this.announceTimer);
    this.announceTimer = null;
    this.current = null;
    this.watching = null;
    this.calling.clear();
    this.streams.clear();
    this.uploadByViewer.clear();
    this.events.emit('streams', []);
    this.events.emit('state', null);
  }

  list(): LiveStream[] {
    return [...this.streams.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get state(): LiveStreamState | null {
    return this.current;
  }

  // ── streamer ─────────────────────────────────────────────────────────────

  async goLive(title: string, audience: { mode: AudienceMode; viewerIds?: string[] } = { mode: 'everyone' }): Promise<void> {
    const name = title.trim() || `${this.identity.displayName}'s stream`;
    const selected = new Set(audience.mode === 'selected' ? (audience.viewerIds ?? []) : []);
    // The audience object must exist BEFORE the mesh starts, because it is the join gate.
    const pending: LiveStreamState = {
      streamId: '',
      streamerId: this.identity.deviceId,
      title: name,
      audienceMode: audience.mode,
      selectedViewerIds: selected,
      viewers: new Map(),
      startedAt: Date.now(),
    };
    this.current = pending;
    const streamId = await this.calls.startLive(name, (id) => this.isAllowed(id));
    if (!streamId || this.current !== pending) {
      if (this.current === pending) this.current = null;
      if (!streamId) log.warn('Unable to start stream');
      return;
    }
    pending.streamId = streamId;
    log.info(`Live: "${name}" (${audience.mode === 'everyone' ? 'everyone' : `${selected.size} selected viewer(s)`})`);
    this.announce(false);
    for (const id of selected) this.notifyAdded(id);
    this.announceTimer = setInterval(() => this.announce(true), ANNOUNCE_MS);
    this.emitState();
  }

  /**
   * Change who may watch. Removed viewers: connection closed (media stops) + told to leave.
   * Added viewers: invited; their connection follows the normal P2P → STUN → TURN path.
   */
  updateAudience(mode: AudienceMode, viewerIds: string[] = []): void {
    const cur = this.current;
    if (!cur?.streamId) return;
    const before = new Set(this.audienceUniverse().filter((id) => this.isAllowed(id)));
    cur.audienceMode = mode;
    cur.selectedViewerIds = new Set(mode === 'selected' ? viewerIds : []);
    const connected = new Set(this.connectedViewerIds());
    for (const id of new Set([...before, ...connected, ...this.audienceUniverse()])) {
      const now = this.isAllowed(id);
      if (!now && (before.has(id) || connected.has(id))) {
        this.calls.revokeViewer(id, 'removed from audience');
        this.signaling.send(id, 'live-viewer-removed', { streamId: cur.streamId, targetUserId: id, reason: 'removed-by-streamer' }, { callId: cur.streamId });
        log.info(`Viewer removed: ${this.nameOf(id)}`);
      } else if (now && !before.has(id)) {
        this.calls.reinstateViewer(id);
        if (mode === 'selected') this.notifyAdded(id);
        log.info(`Viewer added: ${this.nameOf(id)}`);
      }
    }
    this.signaling.broadcast(this.lobby(), 'live-audience-updated', this.info(false), { callId: cur.streamId });
    this.emitState();
  }

  /**
   * Call someone into the running stream (streamer only). They are added to the audience if
   * needed, then:
   *   online           → ringing invitation over signaling (incoming UI + ringtone on their side)
   *   offline/unknown  → TARGETED incoming-call push (never broadcast); with no targeted push the
   *                      call waits and rings them as soon as presence shows them online
   * The WebRTC/live-stream path is unchanged: they join as a normal viewer.
   */
  async callViewer(userId: string): Promise<LiveCallResult> {
    const cur = this.current;
    const room = this.signaling.currentRoom;
    if (!cur?.streamId || userId === this.identity.deviceId) return 'not-live';
    if (this.connectedViewerIds().includes(userId)) return 'watching';
    const online = this.presence.status(userId) === 'online';
    this.calling.set(userId, { until: Date.now() + this.config.timeouts.ringMs, rungOnline: online });
    if (!this.isAllowed(userId)) this.updateAudience('selected', [...cur.selectedViewerIds, userId]); // → ringing invite
    else if (online) this.notifyAdded(userId);
    if (online) {
      log.info(`Calling ${this.nameOf(userId)} into the stream (ringing)`);
      return 'ringing';
    }
    const result: NotifyResult = room
      ? await this.push.notifyIncomingCall(userId, {
          type: 'incoming-call',
          callId: cur.streamId,
          roomId: room.roomId,
          roomName: room.roomName,
          callerId: this.identity.deviceId,
          callerName: this.identity.displayName,
          callType: 'live',
          title: cur.title,
          timestamp: Date.now(),
          expiresAt: Date.now() + this.config.timeouts.ringMs,
        })
      : 'failed';
    log.info(`Calling ${this.nameOf(userId)} into the stream: offline → targeted push ${result}`);
    return result === 'accepted' ? 'push' : 'waiting';
  }

  /** Called people who just came online (e.g. opened the push notification) get the ringing invite. */
  private ringCalledWhenOnline(): void {
    const now = Date.now();
    for (const [id, c] of this.calling) {
      if (now > c.until) this.calling.delete(id);
      else if (!c.rungOnline && this.presence.status(id) === 'online' && this.isAllowed(id)) {
        c.rungOnline = true;
        log.info(`${this.nameOf(id)} is online – ringing the stream invitation`);
        this.notifyAdded(id);
      }
    }
  }

  isAllowed(deviceId: string): boolean {
    const cur = this.current;
    if (!cur || deviceId === this.identity.deviceId) return false;
    return cur.audienceMode === 'everyone' || cur.selectedViewerIds.has(deviceId);
  }

  // ── viewer ───────────────────────────────────────────────────────────────

  join(streamId: string): void {
    const s = this.streams.get(streamId);
    if (!s || !this.canWatch(s)) return;
    this.watching = { streamId, hostId: s.hostId };
    this.calls.joinLive(streamId, { deviceId: s.hostId, name: s.hostName }, s.title);
    this.signaling.send(s.hostId, 'live-viewer-joined', { streamId }, { callId: streamId });
  }

  /** Accept a live-viewer-added invitation (the stream may not have been announced to us yet). */
  watch(invite: LiveInvite): void {
    if (!this.streams.has(invite.streamId)) {
      this.streams.set(invite.streamId, {
        streamId: invite.streamId,
        title: invite.title,
        audienceMode: 'selected',
        allowedViewerIds: [this.identity.deviceId],
        viewers: 0,
        maxViewers: this.config.mesh.maxLiveViewers,
        startedAt: Date.now(),
        hostId: invite.hostId,
        hostName: invite.hostName,
        lastSeen: Date.now(),
      });
    }
    this.join(invite.streamId);
  }

  canWatch(s: LiveStream): boolean {
    return s.audienceMode === 'everyone' || (s.allowedViewerIds ?? []).includes(this.identity.deviceId);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private onMessage(msg: SignalingMessage): void {
    if (!msg.messageType.startsWith('live-')) return;
    const m = msg as LiveStreamMessage;
    const me = this.identity.deviceId;
    switch (m.messageType) {
      case 'live-started':
      case 'live-audience-updated': {
        const known = this.streams.get(m.payload.streamId);
        if (known && known.hostId !== m.senderId) return; // only the streamer may update its stream
        if (m.senderId === me) return;
        this.streams.set(m.payload.streamId, { ...m.payload, hostId: m.senderId, hostName: m.senderName, lastSeen: Date.now() });
        const s = this.streams.get(m.payload.streamId)!;
        if (!this.canWatch(s)) {
          this.streams.delete(s.streamId);
          this.kickIfWatching(s.streamId, m.senderId, 'The streamer changed the audience');
        }
        this.emitStreams();
        break;
      }
      case 'live-stopped': {
        const known = this.streams.get(m.payload.streamId);
        if (known && known.hostId !== m.senderId) return;
        if (this.streams.delete(m.payload.streamId)) this.emitStreams();
        break;
      }
      case 'live-viewer-added': {
        if (m.payload.targetUserId !== me) return;
        const known = this.streams.get(m.payload.streamId);
        if (known && known.hostId !== m.senderId) return;
        const ring = m.payload.ring === true;
        log.info(`${m.senderName} ${ring ? 'is calling you into' : 'added you to'} "${m.payload.title}"`);
        this.events.emit('invite', { streamId: m.payload.streamId, title: m.payload.title, hostId: m.senderId, hostName: m.senderName, ring });
        break;
      }
      case 'live-viewer-removed': {
        if (m.payload.targetUserId !== me) return;
        const known = this.streams.get(m.payload.streamId);
        if (known && known.hostId !== m.senderId) return;
        if (known) {
          known.allowedViewerIds = (known.allowedViewerIds ?? []).filter((id) => id !== me);
          if (!this.canWatch(known)) this.streams.delete(known.streamId);
        }
        this.kickIfWatching(m.payload.streamId, m.senderId, 'You were removed from the stream audience');
        this.emitStreams();
        break;
      }
      case 'live-viewer-joined':
        if (this.current?.streamId !== m.payload.streamId) return;
        this.calling.delete(m.senderId); // answered
        this.emitState();
        break;
      case 'live-viewer-left':
        if (this.current?.streamId !== m.payload.streamId) return;
        this.calls.viewerLeft(m.senderId);
        this.emitState();
        break;
    }
  }

  /** Leave a stream we are watching if the (verified) streamer revoked our access. */
  private kickIfWatching(streamId: string, senderId: string, detail: string): void {
    const c = this.calls.state;
    if (c?.kind === 'live' && c.role === 'viewer' && c.callId === streamId && c.hostId === senderId && !isTerminal(c.status)) {
      this.watching = null;
      this.calls.terminate(detail);
    }
  }

  private onCallState(s: CallState | null): void {
    // Viewer: tell the streamer we left.
    if (this.watching && (!s || s.callId !== this.watching.streamId || isTerminal(s.status))) {
      this.signaling.send(this.watching.hostId, 'live-viewer-left', { streamId: this.watching.streamId }, { callId: this.watching.streamId });
      this.watching = null;
    }
    const cur = this.current;
    if (!cur?.streamId) return;
    if (!s || s.callId !== cur.streamId || isTerminal(s.status)) {
      this.signaling.broadcast(this.lobby(), 'live-stopped', { streamId: cur.streamId }, { callId: cur.streamId });
      log.info('Stream ended');
      if (this.announceTimer) clearInterval(this.announceTimer);
      this.announceTimer = null;
      this.current = null;
      this.calling.clear();
      this.uploadByViewer.clear();
      this.events.emit('state', null);
      return;
    }
    const count = this.connectedViewerIds().length;
    if (count !== this.lastViewerCount) {
      this.lastViewerCount = count;
      this.announce(true); // keep the room's viewer counter current
    }
    this.emitState();
  }

  private onUsage(peers: Array<{ remoteId: string; sendBps: number }>): void {
    if (!this.current) return;
    this.uploadByViewer = new Map(peers.map((p) => [p.remoteId, p.sendBps]));
    this.emitState();
  }

  /** Everyone the streamer could pick from: room users + anyone currently connected. */
  private audienceUniverse(): string[] {
    const ids = new Set(this.presence.contacts().filter((u) => u.status === 'online').map((u) => u.deviceId));
    for (const id of this.connectedViewerIds()) ids.add(id);
    for (const id of this.current?.selectedViewerIds ?? []) ids.add(id);
    ids.delete(this.identity.deviceId);
    return [...ids];
  }

  private connectedViewerIds(): string[] {
    const c = this.calls.state;
    return c && c.kind === 'live' && c.role === 'broadcaster' ? [...c.participants.keys()] : [];
  }

  private emitState(): void {
    const cur = this.current;
    if (!cur) return;
    const c = this.calls.state;
    const participants = c?.callId === cur.streamId ? c.participants : new Map();
    const viewers = new Map<string, StreamViewerState>();
    for (const id of this.audienceUniverse()) {
      const allowed = this.isAllowed(id);
      const p = participants.get(id);
      const connected = p?.peer?.connectionState === 'connected';
      const status: ViewerStatus = !allowed
        ? 'not-selected'
        : connected
          ? 'streaming'
          : p
            ? p.peer && p.peer.connectionState !== 'new' && p.peer.connectionState !== 'connecting'
              ? 'disconnected'
              : 'connecting'
            : cur.audienceMode === 'everyone'
              ? 'available'
              : 'invited';
      viewers.set(id, {
        userId: id,
        name: p?.name ?? this.nameOf(id),
        allowed,
        connected,
        streamActive: connected && allowed,
        status,
        uploadBps: connected ? (this.uploadByViewer.get(id) ?? 0) : 0,
      });
    }
    cur.viewers = viewers;
    this.events.emit('state', cur);
  }

  private notifyAdded(id: string): void {
    const cur = this.current;
    if (!cur?.streamId) return;
    const c = this.calling.get(id);
    const ring = !!c && Date.now() <= c.until;
    this.signaling.send(id, 'live-viewer-added', { streamId: cur.streamId, title: cur.title, targetUserId: id, ring }, { callId: cur.streamId });
  }

  private info(heartbeat: boolean): PayloadOf<'live-started'> {
    const cur = this.current!;
    const viewers = this.connectedViewerIds().length;
    return {
      streamId: cur.streamId,
      title: cur.title,
      audienceMode: cur.audienceMode,
      allowedViewerIds: cur.audienceMode === 'selected' ? [...cur.selectedViewerIds] : undefined,
      viewers,
      maxViewers: this.config.mesh.maxLiveViewers,
      startedAt: cur.startedAt,
      heartbeat,
    };
  }

  private announce(heartbeat: boolean): void {
    if (!this.current?.streamId) return;
    this.signaling.broadcast(this.lobby(), 'live-started', this.info(heartbeat), { callId: this.current.streamId });
  }

  private lobby(): string {
    return lobbyRoom(this.signaling.currentRoom?.roomKey ?? '');
  }

  private nameOf(id: string): string {
    return this.presence.nameOf(id);
  }

  private expire(): void {
    let changed = false;
    for (const [id, s] of this.streams) {
      if (Date.now() - s.lastSeen > EXPIRE_MS) {
        this.streams.delete(id);
        changed = true;
      }
    }
    if (changed) this.emitStreams();
  }

  private emitStreams(): void {
    this.events.emit('streams', this.list());
  }
}
