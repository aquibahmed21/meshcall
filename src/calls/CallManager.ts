import { BoundedSet, Timer } from '../core/async';
import { Disposer, Emitter } from '../core/emitter';
import { uuid } from '../core/ids';
import { createLogger } from '../core/logger';
import { storage } from '../core/storage';
import type { AppConfig } from '../config';
import type { MediaManager } from '../media/MediaManager';
import type { IdentityService } from '../services/IdentityService';
import type { NetworkMonitor } from '../services/NetworkMonitor';
import type { NotificationService } from '../services/NotificationService';
import type { PresenceService } from '../services/PresenceService';
import type { PushNotificationService } from '../services/PushNotificationService';
import { Ringtone } from '../services/Ringtone';
import type { SettingsService } from '../services/SettingsService';
import { inboxRoom, meshRoom, type SignalingService } from '../services/SignalingService';
import type { CallKind, InvitePayload, MediaKind, MeshRole, MessageOf, SignalingMessage } from '../types/signaling';
import type { CallState, CallStatus } from '../types/state';
import type { DataUsageSnapshot } from '../webrtc/DataUsageMonitor';
import type { StatsReport } from '../webrtc/StatsMonitor';
import type { WebRTCManager } from '../webrtc/WebRTCManager';
import { canTransition, isTerminal } from './CallStateMachine';
import { MeshSession } from './MeshSession';

const log = createLogger('Call');
const SAVED_CALL_KEY = 'voip.activeCall';
const REJOIN_WINDOW_MS = 15 * 60_000;
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

export interface CallDeps {
  identity: IdentityService;
  signaling: SignalingService;
  presence: PresenceService;
  media: MediaManager;
  settings: SettingsService;
  webrtc: WebRTCManager;
  network: NetworkMonitor;
  notifications: NotificationService;
  push: PushNotificationService;
  config: AppConfig;
}

export interface SavedCall {
  roomId: string;
  participantIds?: string[];
  callId: string;
  kind: CallKind;
  media: MediaKind;
  role: MeshRole;
  hostId: string;
  remote?: { deviceId: string; name: string };
  title?: string;
  savedAt: number;
}

export type ToastLevel = 'info' | 'warn' | 'error';

/**
 * Call orchestration and the call-level state machine
 * (Idle → Calling → Ringing → Connecting → Connected ⇄ Reconnecting → Ended/Failed/Rejected/Busy).
 *
 * Call control (invite/ringing/accept/reject/cancel/hangup) is handled here; media transport is
 * delegated to a MeshSession – a 1:1 call is simply a mesh of two with an allow-list.
 * Call state is plain data emitted to the UI; it never references DOM.
 */
export class CallManager {
  readonly events = new Emitter<{
    state: CallState | null;
    toast: { level: ToastLevel; text: string };
    stats: { report: StatsReport; usage: DataUsageSnapshot };
    rejoinAvailable: SavedCall | null;
  }>();

  private call: CallState | null = null;
  private mesh: MeshSession | null = null;
  private inviteSender: { deviceId: string; sessionId: string } | null = null;
  private acceptedSessionId: string | null = null;
  /** Opened from a call notification: the call we expect an invite for (NOT auto-accepted). */
  private expected: { callId: string; callerName?: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private pushSent = false;
  private inviteAcked = false;
  private seenInvites = new BoundedSet<string>(200);
  private ringtone = new Ringtone();
  private ringTimer = new Timer();
  private noAckTimer = new Timer();
  private connectTimer = new Timer();
  private reconnectTimer = new Timer();
  private endedTimer = new Timer();
  private acceptResend: ReturnType<typeof setInterval> | null = null;
  private disposer = new Disposer();
  private everConnectedPeer = false;
  private calleeOnline = false;
  /** Group invitations we sent that are not answered yet (duplicate/offline/decline handling). */
  private pendingInvites = new Map<string, { name: string; acked: boolean; timers: Array<ReturnType<typeof setTimeout>> }>();
  /** Invitee: participants listed in the invitation (seed for the join allow-list). */
  private inviteParticipants: string[] = [];
  private liveAuthorize: ((deviceId: string) => boolean) | undefined;
  private rejoinParticipants: string[] | null = null;
  private _rejoinOffer: SavedCall | null = null;

  constructor(private readonly d: CallDeps) {}

  /** Enter the current room: subscribe to this device's room inbox and wire listeners. */
  start(): void {
    const { signaling, identity, network, presence, media } = this.d;
    const room = signaling.currentRoom;
    if (!room) throw new Error('CallManager.start() requires a room');
    this.disposer.dispose();
    this.disposer.add(signaling.subscribe(inboxRoom(room.roomKey, identity.deviceId)));
    this.disposer.add(signaling.events.on('message', ({ msg }) => this.onMessage(msg)));
    this.disposer.add(network.events.on('change', ({ reason }) => this.mesh?.onNetworkChange(reason)));
    this.disposer.add(presence.events.on('change', () => this.onPresenceChange()));
    this.disposer.add(media.events.on('warning', (w) => this.toast('warn', w)));
    this.disposer.listen(window, 'pagehide', () => this.persistActiveCall());

    const saved = storage.get<SavedCall | null>(SAVED_CALL_KEY, null, 'session');
    this.setRejoinOffer(saved && saved.roomId === room.roomId && Date.now() - saved.savedAt < REJOIN_WINDOW_MS ? saved : null);

  }

  /**
   * Leave the room: end any call/stream (peer connections, media, mesh room), cancel pending
   * invitations, and remove every room listener/subscription.
   */
  stop(): void {
    if (this.call && !isTerminal(this.call.status)) this.hangup();
    this.reset();
    this.clearPendingInvites();
    this.disposer.dispose();
    this.clearExpected();
    this.seenInvites.clear();
    this.inviteParticipants = [];
    this.liveAuthorize = undefined;
    this.setRejoinOffer(null);
  }

  /** Current "rejoin your previous call" offer (state, so late subscribers can read it). */
  get rejoinOffer(): SavedCall | null {
    return this._rejoinOffer;
  }

  private setRejoinOffer(saved: SavedCall | null): void {
    this._rejoinOffer = saved;
    this.events.emit('rejoinAvailable', saved);
  }

  get state(): CallState | null {
    return this.call;
  }

  get session(): MeshSession | null {
    return this.mesh;
  }

  get inCall(): boolean {
    return !!this.call && !isTerminal(this.call.status);
  }

  // ── outgoing 1:1 ─────────────────────────────────────────────────────────

  async startDirectCall(userId: string, media: MediaKind): Promise<void> {
    if (!this.guardIdle()) return;
    const { presence, signaling, identity, config } = this.d;
    const user = presence.get(userId);
    const name = user?.name ?? presence.nameOf(userId);
    if (user?.busy) {
      this.toast('warn', `${name} is in another call`);
    }
    const callId = uuid();
    this.call = this.newCall({ callId, kind: 'direct', media, role: 'participant', hostId: identity.deviceId, direction: 'outgoing', status: 'calling' });
    this.call.remoteUser = { deviceId: userId, name };
    this.emit();
    await this.acquireMedia(media);
    if (this.call?.callId !== callId) return; // cancelled while waiting for permission

    this.inviteAcked = false;
    this.pushSent = false;
    this.calleeOnline = user?.status === 'online';
    this.sendInvite(userId, 'direct');
    this.ringtone.start('outgoing');
    this.d.presence.setBusy(true);
    log.info(`Calling ${name} (${media})`);

    if (user?.status !== 'online') void this.sendPush(userId);
    this.noAckTimer.start(config.timeouts.offlineNoAckMs, () => {
      if (this.call?.callId !== callId || this.call.status !== 'calling' || this.inviteAcked) return;
      if (this.pushSent || this.d.push.canTarget) {
        if (!this.pushSent) void this.sendPush(userId);
        this.setStatus('calling', `${name} is offline – sent a notification`);
      } else {
        this.finish('failed', `${name} appears to be offline`);
      }
    });
    this.ringTimer.start(config.timeouts.ringMs, () => {
      if (this.call?.callId !== callId || (this.call.status !== 'calling' && this.call.status !== 'ringing')) return;
      signaling.send(userId, 'call-cancel', { reason: 'timeout' }, { callId });
      this.finish('ended', 'No answer');
    });
  }

  // ── group ────────────────────────────────────────────────────────────────

  async startGroupCall(userIds: string[], media: MediaKind, groupName?: string): Promise<void> {
    if (!this.guardIdle()) return;
    const { identity } = this.d;
    const callId = uuid();
    this.call = this.newCall({ callId, kind: 'group', media, role: 'participant', hostId: identity.deviceId, direction: 'outgoing', status: 'connecting' });
    this.call.title = groupName || 'Group call';
    this.emit();
    await this.acquireMedia(media);
    if (this.call?.callId !== callId) return;
    this.startMesh();
    this.mesh?.allow(userIds);
    for (const id of userIds) this.inviteToCall(id);
  }

  /**
   * Add people to the running call. A 1:1 call is converted into a group call first; the
   * existing peer connection is kept – only the new participants' links get negotiated.
   * Returns the ids actually invited (duplicates / people already in the call are skipped).
   */
  addParticipants(userIds: string[]): string[] {
    const c = this.call;
    const me = this.d.identity.deviceId;
    if (!c || !this.mesh || c.kind === 'live' || (c.status !== 'connected' && c.status !== 'connecting' && c.status !== 'reconnecting')) {
      this.toast('warn', 'Unable to add participants right now');
      return [];
    }
    const added: string[] = [];
    for (const id of new Set(userIds)) {
      const name = this.d.presence.nameOf(id);
      if (id === me) continue;
      if (c.participants.has(id)) {
        this.toast('info', `${name} is already in the call`);
        continue;
      }
      if (this.pendingInvites.has(id)) {
        this.toast('info', `${name} has already been invited`);
        continue;
      }
      added.push(id);
    }
    // Mesh cap: every extra participant costs everyone another upstream copy.
    const room = this.d.config.mesh.maxParticipants - 1 - c.participants.size - this.pendingInvites.size;
    if (added.length > room) {
      this.toast('warn', room > 0 ? `Only ${room} more participant(s) fit in a mesh call` : 'The call is full');
      added.splice(Math.max(0, room));
    }
    if (!added.length) return [];
    if (c.kind === 'direct') this.convertToGroup('you added participants');
    // Tell current participants first (widens their join allow-list), then invite.
    this.d.signaling.broadcast(meshRoom(c.callId), 'call-participants-added', { participantIds: added, title: c.title }, { callId: c.callId });
    this.mesh.allow(added);
    for (const id of added) this.inviteToCall(id);
    return added;
  }

  inviteToCall(userId: string): void {
    const c = this.call;
    if (!c || c.kind !== 'group' || isTerminal(c.status)) return;
    const name = this.d.presence.nameOf(userId);
    this.clearPendingInvite(userId);
    this.sendInvite(userId, 'group');
    const online = this.d.presence.status(userId) === 'online';
    if (!online) void this.sendPush(userId);
    const entry = { name, acked: false, timers: [] as Array<ReturnType<typeof setTimeout>> };
    entry.timers.push(
      setTimeout(() => {
        if (this.pendingInvites.get(userId) !== entry || entry.acked) return;
        if (!this.d.push.canTarget) {
          this.toast('warn', `${name} appears to be offline`);
          this.clearPendingInvite(userId);
        }
      }, this.d.config.timeouts.offlineNoAckMs),
      setTimeout(() => {
        if (this.pendingInvites.get(userId) !== entry) return;
        this.toast('info', `${name} didn't answer`);
        this.clearPendingInvite(userId);
      }, this.d.config.timeouts.ringMs),
    );
    this.pendingInvites.set(userId, entry);
    this.toast('info', `Invited ${name}`);
  }

  /** People invited to the current call who have not answered yet. */
  get pendingInviteIds(): string[] {
    return [...this.pendingInvites.keys()];
  }

  private clearPendingInvite(userId: string): void {
    const e = this.pendingInvites.get(userId);
    if (!e) return;
    e.timers.forEach(clearTimeout);
    this.pendingInvites.delete(userId);
    this.emit();
  }

  private clearPendingInvites(): void {
    for (const id of [...this.pendingInvites.keys()]) this.clearPendingInvite(id);
  }

  /** 1:1 → group. Metadata + access policy only; RTCPeerConnections are not touched. */
  private convertToGroup(reason: string): void {
    const c = this.call;
    if (!c || c.kind !== 'direct') return;
    log.info(`1:1 call converted to a group call (${reason})`);
    c.kind = 'group';
    c.type = 'group';
    c.title = c.title ?? 'Group call';
    this.connectTimer.clear();
    this.reconnectTimer.clear();
    this.mesh?.convertToGroup([]);
    if (c.status === 'reconnecting' || c.status === 'connecting') this.setStatus('connected');
    this.emit();
  }

  removeParticipant(userId: string): void {
    this.mesh?.removeParticipant(userId);
  }

  // ── live ─────────────────────────────────────────────────────────────────

  /**
   * Start broadcasting. `authorize` is the streamer's audience rule – the mesh consults it before
   * accepting ANY viewer (join or negotiation), so unselected users never receive the media.
   */
  async startLive(title: string, authorize?: (deviceId: string) => boolean): Promise<string | null> {
    if (!this.guardIdle()) return null;
    this.liveAuthorize = authorize;
    const streamId = uuid();
    this.call = this.newCall({ callId: streamId, kind: 'live', media: 'video', role: 'broadcaster', hostId: this.d.identity.deviceId, direction: 'outgoing', status: 'connecting' });
    this.call.title = title;
    this.emit();
    const r = await this.acquireMedia('video');
    if (this.call?.callId !== streamId) return null;
    if (!r.audio && !r.video) {
      this.finish('failed', 'Cannot go live without a camera or microphone');
      return null;
    }
    this.startMesh();
    return streamId;
  }

  /** Streamer removed a viewer from the audience: close only that viewer's connection. */
  revokeViewer(deviceId: string, reason: string): void {
    const c = this.call;
    if (c?.kind === 'live' && c.role === 'broadcaster') this.mesh?.revoke(deviceId, reason);
  }

  /** Streamer: a viewer announced it left – free its connection immediately. */
  viewerLeft(deviceId: string): void {
    const c = this.call;
    if (c?.kind === 'live' && c.role === 'broadcaster' && c.participants.has(deviceId)) this.mesh?.dropParticipant(deviceId, 'viewer left');
  }

  reinstateViewer(deviceId: string): void {
    const c = this.call;
    if (c?.kind === 'live' && c.role === 'broadcaster') this.mesh?.reinstate(deviceId);
  }

  /**
   * The user opened MeshCall from a call notification. If that call is already ringing, the
   * normal Accept/Reject dialog is on screen. Otherwise wait for its invite (the caller re-sends
   * it when we come online) – it then rings normally; it is never auto-accepted. If nothing
   * arrives, tell the user instead of silently doing nothing.
   */
  expectCall(callId: string, callerName?: string): void {
    const c = this.call;
    if (c?.callId === callId && !isTerminal(c.status)) return;
    this.clearExpected();
    log.info('Opened from a call notification – waiting for the invite');
    const timer = setTimeout(() => {
      if (this.expected?.callId !== callId) return;
      this.expected = null;
      if (this.call?.callId !== callId) this.toast('warn', callerName ? `Missed call from ${callerName} – the call is no longer available` : 'That call is no longer available');
    }, 30_000);
    this.expected = { callId, callerName, timer };
  }

  /** Notification "Decline" for the call that is ringing now. */
  declineFromNotification(callId: string): void {
    const c = this.call;
    if (c?.callId === callId && c.status === 'ringing' && c.direction === 'incoming') this.rejectIncoming();
  }

  private clearExpected(): void {
    if (this.expected) clearTimeout(this.expected.timer);
    this.expected = null;
  }

  /** End the current call/stream locally with a reason (e.g. removed from a stream audience). */
  terminate(detail: string): void {
    this.finish('ended', detail);
  }

  joinLive(streamId: string, broadcaster: { deviceId: string; name: string }, title: string): void {
    if (!this.guardIdle()) return;
    this.call = this.newCall({ callId: streamId, kind: 'live', media: 'video', role: 'viewer', hostId: broadcaster.deviceId, direction: 'incoming', status: 'connecting' });
    this.call.remoteUser = broadcaster;
    this.call.title = title;
    this.emit();
    this.startMesh();
  }

  // ── incoming ─────────────────────────────────────────────────────────────

  async acceptIncoming(): Promise<void> {
    const c = this.call;
    if (!c || c.status !== 'ringing' || c.direction !== 'incoming' || !this.inviteSender) return;
    this.ringtone.stop();
    void this.d.notifications.close(`call-${c.callId}`);
    const sender = this.inviteSender;
    this.setStatus('connecting', 'Preparing media…');
    await this.acquireMedia(c.media);
    if (this.call?.callId !== c.callId || this.call.status !== 'connecting') return;
    const sendAccept = () =>
      this.d.signaling.send(sender.deviceId, 'call-accept', { media: c.media }, { callId: c.callId, receiverSessionId: sender.sessionId });
    sendAccept();
    log.info(`Accepted call from ${c.remoteUser?.name}`);
    this.startMesh();
    // If the accept is lost the caller would ring until timeout: re-send it (idempotent on the
    // caller side) until the caller appears in the mesh.
    let resends = 0;
    if (this.acceptResend) clearInterval(this.acceptResend);
    this.acceptResend = setInterval(() => {
      const cur = this.call;
      if (!cur || cur.callId !== c.callId || cur.participants.size > 0 || isTerminal(cur.status) || ++resends > 5) {
        if (this.acceptResend) clearInterval(this.acceptResend);
        this.acceptResend = null;
        return;
      }
      sendAccept();
    }, 3_000);
  }

  rejectIncoming(): void {
    const c = this.call;
    if (!c || c.status !== 'ringing' || c.direction !== 'incoming' || !this.inviteSender) return;
    this.d.signaling.send(this.inviteSender.deviceId, 'call-reject', { reason: 'declined' }, { callId: c.callId, receiverSessionId: this.inviteSender.sessionId });
    log.info('Call rejected');
    this.finish('ended', 'Declined', true);
  }

  // ── common controls ──────────────────────────────────────────────────────

  hangup(): void {
    const c = this.call;
    if (!c) return;
    if (isTerminal(c.status)) {
      this.reset();
      return;
    }
    if (c.status === 'ringing' && c.direction === 'incoming') return this.rejectIncoming();
    const remote = c.remoteUser;
    if (c.kind === 'direct' && remote) {
      if (c.status === 'calling' || c.status === 'ringing') {
        this.d.signaling.send(remote.deviceId, 'call-cancel', { reason: 'cancelled' }, { callId: c.callId });
        return this.finish('ended', 'Cancelled');
      }
    }
    this.finish('ended', c.kind === 'live' && c.role === 'broadcaster' ? 'Stream ended' : 'Call ended');
  }

  toggleMute(): void {
    this.d.media.setAudioMuted(!this.d.media.state.audioMuted);
  }

  async toggleCamera(): Promise<void> {
    const s = this.d.media.state;
    await this.d.media.setCameraEnabled(s.videoMuted);
  }

  async toggleScreenShare(): Promise<void> {
    if (this.d.media.state.screenSharing) await this.d.media.stopScreenShare();
    else await this.d.media.startScreenShare();
  }

  retryDirect(remoteId: string): void {
    this.mesh?.retryDirect(remoteId);
  }

  async rejoin(saved: SavedCall): Promise<void> {
    storage.remove(SAVED_CALL_KEY, 'session');
    this.setRejoinOffer(null);
    if (!this.guardIdle()) return;
    this.call = this.newCall({
      callId: saved.callId,
      kind: saved.kind,
      media: saved.media,
      role: saved.role,
      hostId: saved.hostId,
      direction: 'outgoing',
      status: 'connecting',
    });
    this.call.remoteUser = saved.remote;
    this.call.title = saved.title;
    this.rejoinParticipants = saved.participantIds ?? [];
    this.emit();
    if (saved.role !== 'viewer') await this.acquireMedia(saved.media);
    if (this.call?.callId !== saved.callId) return;
    log.info('Rejoining previous call – fresh negotiation with every participant');
    this.startMesh();
  }

  dismissRejoin(): void {
    storage.remove(SAVED_CALL_KEY, 'session');
    this.setRejoinOffer(null);
  }

  // ── signaling ────────────────────────────────────────────────────────────

  private onMessage(msg: SignalingMessage): void {
    switch (msg.messageType) {
      case 'call-invite':
        return this.onInvite(msg);
      case 'call-ringing':
        return this.onRinging(msg);
      case 'call-accept':
        return this.onAccept(msg);
      case 'call-reject':
        return this.onReject(msg);
      case 'call-cancel':
        return this.onCancel(msg);
      case 'call-hangup':
        return this.onHangup(msg);
      case 'call-participants-added':
        return this.onParticipantsAdded(msg);
      default:
        if (msg.callId && this.mesh && msg.callId === this.mesh.callId) this.mesh.handleMessage(msg);
    }
  }

  private onInvite(msg: MessageOf<'call-invite'>): void {
    const { signaling, presence, notifications } = this.d;
    presence.learn(msg.senderId, msg.senderName);
    const callId = msg.callId;
    if (!callId) return;
    const p = msg.payload;
    const reply = (type: 'call-reject' | 'call-ringing', payload: MessageOf<'call-reject'>['payload'] | Record<string, never>) =>
      signaling.send(msg.senderId, type, payload as never, { callId, receiverSessionId: msg.senderSessionId });

    if (this.call?.callId === callId && !isTerminal(this.call.status)) {
      // Duplicate / re-sent invite for the call we already know.
      if (this.call.status === 'ringing' && this.call.direction === 'incoming') reply('call-ringing', {});
      return;
    }
    if (Date.now() > msg.payload.expiresAt + CLOCK_SKEW_TOLERANCE_MS) {
      log.info(`Ignoring expired invite from ${msg.senderName}`);
      return;
    }
    // A 1:1 invite we already handled (declined/missed) is never re-rung; group calls may
    // legitimately re-invite someone who left.
    if (!this.seenInvites.add(callId) && p.callKind === 'direct' && this.expected?.callId !== callId) return;
    if (this.inCall) {
      log.info(`Busy – rejecting call from ${msg.senderName}`);
      reply('call-reject', { reason: 'busy' });
      this.toast('info', `Missed call from ${msg.senderName} (busy)`);
      return;
    }
    if (this.call) this.reset(); // an "ended" screen is still showing

    this.inviteSender = { deviceId: msg.senderId, sessionId: msg.senderSessionId };
    this.inviteParticipants = Array.isArray(p.participants) ? p.participants.map((x) => x.deviceId).filter((x) => typeof x === 'string') : [];
    for (const x of p.participants ?? []) if (x.deviceId !== this.d.identity.deviceId) presence.learn(x.deviceId, x.name);
    this.call = this.newCall({ callId, kind: p.callKind, media: p.media, role: 'participant', hostId: p.hostId, direction: 'incoming', status: 'ringing' });
    this.call.remoteUser = { deviceId: msg.senderId, name: msg.senderName };
    this.call.title = p.groupName;
    reply('call-ringing', {});
    log.info(`Incoming ${p.callKind === 'group' ? 'group ' : ''}${p.media} call from ${msg.senderName}`);
    this.emit();

    if (this.expected?.callId === callId) this.clearExpected(); // it rings normally below
    this.ringtone.start('incoming');
    const room = this.d.signaling.currentRoom;
    void notifications.showIncomingCall({
      callId,
      callerId: msg.senderId,
      callerName: msg.senderName,
      media: p.media,
      callKind: p.callKind,
      groupName: p.groupName,
      roomId: room?.roomId,
      roomName: room?.roomName,
    });
    this.ringTimer.start(this.d.config.timeouts.ringMs + 5_000, () => {
      if (this.call?.callId === callId && this.call.status === 'ringing') {
        void notifications.showMissedCall(callId, msg.senderName);
        this.finish('ended', `Missed call from ${msg.senderName}`, true);
      }
    });
  }

  private onParticipantsAdded(msg: MessageOf<'call-participants-added'>): void {
    const c = this.call;
    if (!c || !this.mesh || c.callId !== msg.callId || isTerminal(c.status) || c.kind === 'live') return;
    // Only a current participant of THIS call may add people.
    if (!c.participants.has(msg.senderId)) {
      log.warn(`Ignoring participant-add from non-participant ${msg.senderName}`);
      return;
    }
    const ids = (Array.isArray(msg.payload.participantIds) ? msg.payload.participantIds : []).filter(
      (id): id is string => typeof id === 'string' && id !== this.d.identity.deviceId,
    );
    if (c.kind === 'direct') this.convertToGroup(`${msg.senderName} added participants`);
    this.mesh.allow(ids);
    const names = ids.map((id) => this.d.presence.nameOf(id)).join(', ');
    if (names) this.toast('info', `${msg.senderName} added ${names}`);
  }

  private onRinging(msg: MessageOf<'call-ringing'>): void {
    const pending = this.pendingInvites.get(msg.senderId);
    if (pending && this.call?.callId === msg.callId) pending.acked = true;
    const c = this.call;
    if (!c || c.callId !== msg.callId || c.direction !== 'outgoing') return;
    this.inviteAcked = true;
    this.noAckTimer.clear();
    if (c.kind === 'direct' && c.status === 'calling') this.setStatus('ringing', `${msg.senderName}'s device is ringing`);
  }

  private onAccept(msg: MessageOf<'call-accept'>): void {
    const c = this.call;
    if (!c || c.callId !== msg.callId || isTerminal(c.status)) {
      // We no longer have this call (e.g. accepted from a stale notification).
      this.d.signaling.send(msg.senderId, 'call-hangup', { reason: 'ended' }, { callId: msg.callId, receiverSessionId: msg.senderSessionId });
      return;
    }
    if (c.kind === 'group') {
      this.clearPendingInvite(msg.senderId);
      this.mesh?.allow([msg.senderId]);
      this.toast('info', `${msg.senderName} is joining`);
      return;
    }
    if (c.direction !== 'outgoing' || c.remoteUser?.deviceId !== msg.senderId) return;
    if (c.status !== 'calling' && c.status !== 'ringing') return; // duplicate accept
    this.acceptedSessionId = msg.senderSessionId;
    this.noAckTimer.clear();
    this.ringTimer.clear();
    this.ringtone.stop();
    // Stop other tabs/devices of the callee from ringing.
    this.d.signaling.send(msg.senderId, 'call-cancel', { reason: 'answered-elsewhere', answeredBySessionId: msg.senderSessionId }, { callId: c.callId });
    log.info(`${msg.senderName} accepted`);
    this.setStatus('connecting');
    this.startMesh();
  }

  private onReject(msg: MessageOf<'call-reject'>): void {
    const c = this.call;
    if (!c || c.callId !== msg.callId) return;
    if (c.kind === 'group') {
      this.clearPendingInvite(msg.senderId);
      this.toast('info', `${msg.senderName} ${msg.payload.reason === 'busy' ? 'is busy' : 'declined the invitation'}`);
      return;
    }
    if (c.direction !== 'outgoing' || (c.status !== 'calling' && c.status !== 'ringing')) return;
    if (msg.payload.reason === 'busy') this.finish('busy', `${msg.senderName} is busy`);
    else this.finish('rejected', `${msg.senderName} declined the call`);
  }

  private onCancel(msg: MessageOf<'call-cancel'>): void {
    const c = this.call;
    if (!c || c.callId !== msg.callId || c.direction !== 'incoming' || c.status !== 'ringing') return;
    if (msg.payload.reason === 'answered-elsewhere') {
      if (msg.payload.answeredBySessionId === this.d.identity.sessionId) return;
      this.finish('ended', 'Answered on another device', true);
      return;
    }
    void this.d.notifications.showMissedCall(c.callId, msg.senderName);
    this.finish('ended', `Missed call from ${msg.senderName}`, true);
  }

  private onHangup(msg: MessageOf<'call-hangup'>): void {
    const c = this.call;
    if (!c || c.callId !== msg.callId || c.kind !== 'direct' || isTerminal(c.status)) return;
    if (c.status === 'connecting' && !this.everConnectedPeer && msg.payload.reason === 'ended') {
      this.finish('failed', 'That call is no longer available');
    } else {
      this.finish('ended', `${msg.senderName} ended the call`);
    }
  }

  private onPresenceChange(): void {
    const c = this.call;
    // Callee came online (e.g. opened the app from a push) → re-deliver the invite.
    if (c && c.kind === 'direct' && c.direction === 'outgoing' && c.status === 'calling' && !this.inviteAcked && c.remoteUser) {
      const online = this.d.presence.status(c.remoteUser.deviceId) === 'online';
      if (online && !this.calleeOnline) {
        log.info(`${c.remoteUser.name} came online – re-sending invite`);
        this.sendInvite(c.remoteUser.deviceId, 'direct');
      }
      this.calleeOnline = online;
    }
  }



  // ── mesh / status ────────────────────────────────────────────────────────

  private startMesh(): void {
    const c = this.call;
    if (!c) return;
    this.mesh?.leave('replaced');
    this.everConnectedPeer = false;
    const me = this.d.identity.deviceId;
    // Join allow-lists: 1:1 → exactly the two; group → me, host, known participants/invitees
    // (grown later by call-participants-added and vouched joins); live → audience callback.
    const allowList =
      c.kind === 'direct' && c.remoteUser
        ? [me, c.remoteUser.deviceId]
        : c.kind === 'group'
          ? [me, c.hostId, ...(this.inviteSender ? [this.inviteSender.deviceId] : []), ...this.inviteParticipants, ...(this.rejoinParticipants ?? [])]
          : undefined;
    const invitedBy = c.kind === 'group' && c.direction === 'incoming' ? this.inviteSender?.deviceId : undefined;
    const mesh = new MeshSession(this.d, {
      callId: c.callId,
      kind: c.kind,
      role: c.role,
      hostId: c.hostId,
      allowList,
      invitedBy,
      authorize: c.kind === 'live' && c.role === 'broadcaster' ? this.liveAuthorize : undefined,
    });
    this.mesh = mesh;
    this.rejoinParticipants = null;
    mesh.events.on('converted', () => {
      if (this.mesh === mesh) this.convertToGroup('a participant added someone');
    });
    mesh.events.on('participants', () => {
      if (this.mesh !== mesh || !this.call) return;
      this.call.participants = mesh.participants;
      this.recomputeStatus();
      this.emit();
    });
    mesh.events.on('left', ({ name, role, reason }) => {
      if (this.mesh !== mesh || !this.call) return;
      if (this.call.kind === 'direct') this.finish('ended', reason === 'timed out' ? 'Connection lost' : `${name} left the call`);
      else if (this.call.kind === 'live' && role === 'broadcaster') this.finish('ended', 'Stream ended');
      else this.toast('info', `${name} left`);
    });
    mesh.events.on('removed', () => this.finish('ended', 'You were removed from the call'));
    mesh.events.on('rejected', ({ reason }) => this.finish('failed', reason === 'full' ? 'The stream is full' : 'Not allowed to join this call'));
    mesh.events.on('stats', (s) => this.events.emit('stats', s));
    mesh.join();
    this.d.presence.setBusy(true);
    this.persistActiveCall();

    if (c.kind === 'group' || c.role === 'broadcaster') {
      this.setStatus('connected', c.role === 'broadcaster' ? 'Live – waiting for viewers' : 'Waiting for participants');
    } else {
      if (c.status !== 'connecting') this.setStatus('connecting');
      this.connectTimer.start(this.d.config.timeouts.acceptConnectMs, () => {
        if (this.mesh === mesh && this.call?.status === 'connecting') {
          this.finish('failed', c.kind === 'live' ? 'Could not connect to the stream' : 'Could not establish a connection');
        }
      });
    }
  }

  /** 1:1 and viewers follow their single peer; group/broadcaster stay "connected". */
  private recomputeStatus(): void {
    const c = this.call;
    if (!c || !this.mesh || isTerminal(c.status) || c.status === 'calling' || c.status === 'ringing') return;
    const peers = [...c.participants.values()].map((p) => p.peer).filter((p) => !!p);
    const anyConnected = peers.some((p) => p.connectionState === 'connected');

    if (c.kind === 'group' || c.role === 'broadcaster') {
      const n = [...c.participants.values()].length;
      c.statusDetail = n === 0 ? (c.role === 'broadcaster' ? 'Live – waiting for viewers' : 'Waiting for participants') : undefined;
      return;
    }
    if (anyConnected) {
      this.everConnectedPeer = true;
      this.connectTimer.clear();
      this.reconnectTimer.clear();
      if (c.status !== 'connected') this.setStatus('connected');
      return;
    }
    if (this.everConnectedPeer && c.status === 'connected') {
      this.setStatus('reconnecting', 'Connection interrupted – recovering…');
      this.reconnectTimer.start(this.d.config.timeouts.callReconnectMs, () => {
        if (this.call?.status === 'reconnecting') this.finish('failed', 'Connection lost');
      });
    }
  }

  private setStatus(status: CallStatus, detail?: string): void {
    const c = this.call;
    if (!c) return;
    if (!canTransition(c.status, status)) {
      log.warn(`Ignoring invalid transition ${c.status} → ${status}`);
      return;
    }
    if (c.status !== status) log.info(`Status ${c.status} → ${status}`);
    c.status = status;
    c.statusDetail = detail;
    if (status === 'connected' && !c.connectedAt) c.connectedAt = Date.now();
    this.emit();
  }

  private finish(status: 'ended' | 'failed' | 'rejected' | 'busy', detail: string, quiet = false): void {
    const c = this.call;
    if (!c || isTerminal(c.status)) return;
    log.info(`Call ${status}: ${detail}`);
    // Tell the other side of an established/connecting 1:1 call (idempotent on their end).
    if (c.kind === 'direct' && c.remoteUser && (c.status === 'connecting' || c.status === 'connected' || c.status === 'reconnecting')) {
      this.d.signaling.send(
        c.remoteUser.deviceId,
        'call-hangup',
        { reason: status === 'failed' ? 'failed' : 'hangup' },
        { callId: c.callId, receiverSessionId: this.acceptedSessionId ?? this.inviteSender?.sessionId },
      );
    }
    this.teardown(detail);
    c.status = status;
    c.statusDetail = detail;
    c.endedAt = Date.now();
    if (status === 'failed') this.toast('error', detail);
    this.emit();
    this.endedTimer.start(quiet ? 1_200 : this.d.config.timeouts.endedScreenMs, () => this.reset());
  }

  /** Release everything: timers, mesh (peer connections, stats, room), media, ringtone. */
  private teardown(reason: string): void {
    for (const t of [this.ringTimer, this.noAckTimer, this.connectTimer, this.reconnectTimer]) t.clear();
    if (this.acceptResend) clearInterval(this.acceptResend);
    this.acceptResend = null;
    this.ringtone.stop();
    if (this.call) void this.d.notifications.close(`call-${this.call.callId}`);
    this.mesh?.leave(reason);
    this.mesh = null;
    this.d.media.release();
    this.d.presence.setBusy(false);
    this.inviteSender = null;
    this.acceptedSessionId = null;
    this.inviteParticipants = [];
    this.clearPendingInvites();
    storage.remove(SAVED_CALL_KEY, 'session');
  }

  private reset(): void {
    this.endedTimer.clear();
    if (this.call && !isTerminal(this.call.status)) this.teardown('reset');
    this.call = null;
    this.emit();
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private guardIdle(): boolean {
    if (this.inCall) {
      this.toast('warn', 'Already in a call');
      return false;
    }
    if (!this.d.signaling.isConnected) {
      this.toast('error', 'Signaling unavailable – check your connection');
      return false;
    }
    if (this.call) this.reset();
    return true;
  }

  private newCall(o: {
    callId: string;
    kind: CallKind;
    media: MediaKind;
    role: MeshRole;
    hostId: string;
    direction: 'outgoing' | 'incoming';
    status: CallStatus;
  }): CallState {
    return {
      ...o,
      type: o.kind === 'group' ? 'group' : o.kind === 'live' ? 'live' : o.media,
      participants: new Map(),
      startedAt: Date.now(),
    };
  }

  private async acquireMedia(media: MediaKind) {
    this.setStatusDetail('Requesting camera/microphone…');
    const r = await this.d.media.acquire({ audio: true, video: media === 'video' });
    for (const w of r.warnings) this.toast('warn', w);
    if (!r.audio && !r.video && r.warnings.length) this.toast('warn', 'Continuing without local media (receive only)');
    this.setStatusDetail(undefined);
    return r;
  }

  private setStatusDetail(detail: string | undefined): void {
    if (!this.call) return;
    this.call.statusDetail = detail;
    this.emit();
  }

  private sendInvite(userId: string, kind: 'direct' | 'group'): void {
    const c = this.call;
    if (!c) return;
    const payload: InvitePayload = {
      callKind: kind,
      media: c.media,
      hostId: c.hostId,
      groupName: c.title,
      roomName: this.d.signaling.currentRoom?.roomName,
      participants:
        kind === 'group'
          ? [
              { deviceId: this.d.identity.deviceId, name: this.d.identity.displayName },
              ...[...c.participants.values()].map((p) => ({ deviceId: p.deviceId, name: p.name })),
            ]
          : undefined,
      expiresAt: Date.now() + this.d.config.timeouts.ringMs,
    };
    this.d.signaling.send(userId, 'call-invite', payload, { callId: c.callId });
  }

  /**
   * Wake an offline callee through Web Push – ONLY via targeted delivery. With a broadcast-only
   * backend this is a no-op ('unsupported'); a call is never broadcast to all subscribers.
   */
  private async sendPush(userId: string): Promise<void> {
    const c = this.call;
    const room = this.d.signaling.currentRoom;
    if (!c || !room || !this.d.push.canTarget) return;
    this.pushSent = true;
    const result = await this.d.push.notifyIncomingCall(userId, {
      type: 'incoming-call',
      callId: c.callId,
      roomId: room.roomId,
      roomName: room.roomName,
      callerId: this.d.identity.deviceId,
      callerName: this.d.identity.displayName,
      callType: c.kind === 'group' ? 'group' : c.media,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.d.config.timeouts.ringMs,
    });
    if (result !== 'accepted') this.pushSent = false;
  }


  private persistActiveCall(): void {
    const c = this.call;
    if (!c || !this.mesh || isTerminal(c.status)) return;
    const room = this.d.signaling.currentRoom;
    if (!room) return;
    const saved: SavedCall = {
      roomId: room.roomId,
      participantIds: [...c.participants.keys()],
      callId: c.callId,
      kind: c.kind,
      media: c.media,
      role: c.role,
      hostId: c.hostId,
      remote: c.remoteUser,
      title: c.title,
      savedAt: Date.now(),
    };
    storage.set(SAVED_CALL_KEY, saved, 'session');
  }

  private toast(level: ToastLevel, text: string): void {
    this.events.emit('toast', { level, text });
  }

  private emit(): void {
    this.events.emit('state', this.call);
  }
}
