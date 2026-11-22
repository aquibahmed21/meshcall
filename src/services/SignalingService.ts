import { io, type Socket } from 'socket.io-client';
import { Backoff, BoundedSet, Timer } from '../core/async';
import { Emitter } from '../core/emitter';
import { uuid } from '../core/ids';
import { createLogger, errorMessage } from '../core/logger';
import type { AppConfig } from '../config';
import {
  PROTOCOL_VERSION,
  isSignalingMessage,
  type MessageType,
  type PayloadOf,
  type SignalingMessage,
} from '../types/signaling';
import type { IdentityService } from './IdentityService';
import type { RoomContext } from './RoomService';

const log = createLogger('Signaling');

export type SignalingStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

export interface ClientData {
  deviceId: string;
  name: string;
  sessionId: string;
}

export interface Member {
  id: string;
  clientData?: ClientData;
}

export interface RoomHandlers {
  onOpen?: () => void;
  onMembers?: (members: Member[]) => void;
  onMemberJoin?: (member: Member) => void;
  onMemberLeave?: (member: Member) => void;
}

export interface SendOptions {
  callId?: string | null;
  peerId?: string;
  receiverSessionId?: string;
  /** Reuse a specific messageId (e.g. retrying a chat message – receivers de-duplicate by it). */
  messageId?: string;
}

interface RoomEntry {
  handlers: RoomHandlers;
  /** Whether join_room has been sent and acknowledged for the current socket. */
  joined: boolean;
}

interface Outgoing {
  room: string;
  message: SignalingMessage;
  queuedAt: number;
}

interface ServerMessage {
  room: string;
  data: unknown;
  id: string;
  timestamp: number;
  clientId: string;
}

const OUTBOX_LIMIT = 300;
const OUTBOX_MAX_AGE_MS = 20_000;

export const inboxRoom = (roomKey: string, deviceId: string) => `inbox-${roomKey}-${deviceId}`;
export const lobbyRoom = (roomKey: string) => `observable-room-${roomKey}`;
export const meshRoom = (callId: string) => `mesh-${callId}`;

/**
 * Socket.IO transport (replaces the previous ScaleDrone transport).
 *
 *  - Connects to the self-hosted Express + Socket.IO server.
 *  - Tracks connection status; manages reconnection with exponential backoff.
 *  - Liveness watchdog: the server echoes our own publishes back to us. If a publish to a room
 *    we are subscribed to is not echoed within echoWatchdogMs the socket is presumed dead and
 *    re-created.
 *  - Outgoing messages are queued while disconnected and flushed on reconnect.
 *  - Incoming messages are validated, filtered to this device/session, and de-duplicated.
 */
export class SignalingService {
  readonly events = new Emitter<{
    status: SignalingStatus;
    message: { msg: SignalingMessage; room: string };
    reconnected: void;
    /** One of OUR publishes came back (server accepted and fanned it out). */
    echo: { msg: SignalingMessage; room: string };
    /** Server rejected our token – user must re-authenticate. */
    authFailed: void;
  }>();

  private _status: SignalingStatus = 'idle';
  private socket: Socket | null = null;
  private generation = 0;
  private everConnected = false;
  private rooms = new Map<string, RoomEntry>();
  private seen = new BoundedSet<string>(4000);
  private outbox: Outgoing[] = [];
  private backoff = new Backoff(1000, 30_000);
  private retryTimer = new Timer();
  private pendingEchoSince: number | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private room: RoomContext | null = null;

  private readonly onOnline = () => {
    if (this._status !== 'connected' && !this.stopped) {
      log.info('Browser online – reconnecting signaling immediately');
      this.backoff.reset();
      this.reconnectNow('browser-online');
    }
  };

  constructor(
    private readonly identity: IdentityService,
    private readonly config: AppConfig,
  ) {}

  get status(): SignalingStatus {
    return this._status;
  }

  get isConnected(): boolean {
    return this._status === 'connected';
  }

  get currentRoom(): RoomContext | null {
    return this.room;
  }

  /**
   * Switch room scope. Queued messages of the previous room are discarded and incoming
   * messages of any other room are dropped (stale-room protection).
   */
  setRoom(room: RoomContext | null): void {
    if (this.room?.roomId === room?.roomId) return;
    this.room = room;
    this.outbox = [];
    log.info(room ? `Room scope = "${room.roomName}" (${room.roomId})` : 'Left room scope');
  }

  async start(): Promise<void> {
    this.stopped = false;
    window.addEventListener('online', this.onOnline);
    this.watchdog = setInterval(() => this.checkLiveness(), 5_000);
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.onOnline);
    if (this.watchdog) clearInterval(this.watchdog);
    this.retryTimer.clear();
    this.generation++;
    this.closeSocket();
    this.setStatus('idle');
  }

  /** Subscribe to a room. Survives client re-creation. Returns an unsubscribe function. */
  subscribe(name: string, handlers: RoomHandlers = {}): () => void {
    const entry: RoomEntry = { handlers, joined: false };
    // If re-subscribing, leave the old entry first.
    if (this.rooms.has(name) && this.socket && this._status === 'connected') {
      this.socket.emit('leave_room', { room: name });
    }
    this.rooms.set(name, entry);
    if (this.socket && this._status === 'connected') this.attachRoom(name, entry);
    return () => {
      if (this.rooms.get(name) !== entry) return;
      this.rooms.delete(name);
      if (this.socket) {
        try { this.socket.emit('leave_room', { room: name }); } catch { /* ignore */ }
      }
    };
  }

  /** Directed message to one device (all sessions unless receiverSessionId is set). */
  send<T extends MessageType>(receiverId: string, type: T, payload: PayloadOf<T>, opts: SendOptions = {}): string {
    const msg = this.envelope(receiverId, type, payload, opts);
    if (!this.room) {
      log.warn(`Not in a room – dropping ${type} to ${receiverId.slice(0, 8)}`);
      return msg.messageId;
    }
    this.publish(inboxRoom(this.room.roomKey, receiverId), msg);
    return msg.messageId;
  }

  /** Broadcast to everyone subscribed to `room`. */
  broadcast<T extends MessageType>(room: string, type: T, payload: PayloadOf<T>, opts: SendOptions = {}): string {
    const msg = this.envelope('*', type, payload, opts);
    this.publish(room, msg);
    return msg.messageId;
  }

  /** Force a fresh connection (e.g. after network change / dead socket). */
  reconnectNow(reason: string): void {
    if (this.stopped) return;
    log.info(`Re-creating signaling connection (${reason})`);
    this.generation++;
    this.closeSocket();
    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    this.retryTimer.clear();
    void this.connect();
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private envelope<T extends MessageType>(receiverId: string, type: T, payload: PayloadOf<T>, opts: SendOptions): SignalingMessage {
    return {
      v: PROTOCOL_VERSION,
      messageType: type,
      messageId: opts.messageId ?? uuid(),
      timestamp: Date.now(),
      senderId: this.identity.deviceId,
      senderSessionId: this.identity.sessionId,
      senderName: this.identity.displayName,
      receiverId,
      receiverSessionId: opts.receiverSessionId,
      roomId: this.room?.roomId ?? '',
      callId: opts.callId ?? null,
      peerId: opts.peerId ?? this.identity.sessionId,
      payload,
    } as SignalingMessage;
  }

  private publish(room: string, message: SignalingMessage): void {
    if (this._status !== 'connected' || !this.socket) {
      this.enqueue(room, message);
      return;
    }
    try {
      this.socket.emit('publish', { room, message });
      if (this.rooms.has(room) && this.pendingEchoSince === null) this.pendingEchoSince = Date.now();
    } catch (err) {
      log.warn(`Publish failed (${message.messageType}) – queued`, errorMessage(err));
      this.enqueue(room, message);
      this.reconnectNow('publish-failed');
    }
  }

  private enqueue(room: string, message: SignalingMessage): void {
    this.outbox.push({ room, message, queuedAt: Date.now() });
    if (this.outbox.length > OUTBOX_LIMIT) this.outbox.shift();
  }

  private flushOutbox(): void {
    const now = Date.now();
    const pending = this.outbox.filter((o) => now - o.queuedAt < OUTBOX_MAX_AGE_MS);
    const dropped = this.outbox.length - pending.length;
    this.outbox = [];
    if (dropped) log.debug(`Dropped ${dropped} stale queued message(s)`);
    for (const o of pending) this.publish(o.room, o.message);
  }

  private async connect(): Promise<void> {
    const gen = ++this.generation;
    if (gen !== this.generation || this.stopped) return;

    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');

    const socket = io(this.config.serverUrl, {
      auth: { token: this.identity.token },
      reconnection: false,
      timeout: 20_000,
    });
    this.socket = socket;

    const current = () => gen === this.generation && !this.stopped;

    const openTimer = new Timer();
    openTimer.start(20_000, () => {
      if (current() && this._status !== 'connected') {
        log.warn('Socket.IO connection timed out');
        this.retryAfterFailure(gen);
      }
    });

    socket.on('connect', () => {
      openTimer.clear();
      if (!current()) return;
      this.onConnected();
    });

    socket.on('connect_error', (err: Error) => {
      openTimer.clear();
      if (!current()) return;
      if (err.message === 'unauthorized') {
        log.error('Signaling auth failed – token invalid or expired');
        this.generation++;
        this.closeSocket();
        this.setStatus('unavailable');
        this.events.emit('authFailed', undefined);
        return;
      }
      log.error('Socket.IO connect error', err.message);
      this.retryAfterFailure(gen);
    });

    socket.on('disconnect', (reason: string) => {
      if (!current()) return;
      log.warn(`Disconnected (${reason}) – scheduling reconnect`);
      this.retryAfterFailure(gen);
    });

    // ── Incoming events from server ────────────────────────────────────────

    socket.on('message', (data: ServerMessage) => {
      if (!current()) return;
      if (!this.rooms.has(data.room)) return;
      this.handleRaw(data.room, data);
    });

    socket.on('room_opened', ({ room }: { room: string }) => {
      if (!current()) return;
      const entry = this.rooms.get(room);
      if (!entry) return;
      entry.joined = true;
      log.debug(`Room open: ${room}`);
      entry.handlers.onOpen?.();
    });

    socket.on('members', ({ room, members }: { room: string; members: Member[] }) => {
      if (!current()) return;
      this.rooms.get(room)?.handlers.onMembers?.(members);
    });

    socket.on('member_join', ({ room, member }: { room: string; member: Member }) => {
      if (!current()) return;
      this.rooms.get(room)?.handlers.onMemberJoin?.(member);
    });

    socket.on('member_leave', ({ room, member }: { room: string; member: Member }) => {
      if (!current()) return;
      this.rooms.get(room)?.handlers.onMemberLeave?.(member);
    });
  }

  private retryAfterFailure(gen: number): void {
    if (gen !== this.generation) return;
    this.generation++;
    this.closeSocket();
    this.setStatus(this.everConnected ? 'reconnecting' : 'unavailable');
    this.scheduleRetry(this.generation);
  }

  private scheduleRetry(gen: number): void {
    if (this.stopped) return;
    const delay = this.backoff.next();
    log.info(`Retrying signaling in ${Math.round(delay / 1000)} s`);
    this.retryTimer.start(delay, () => {
      if (gen === this.generation && !this.stopped) void this.connect();
    });
  }

  private onConnected(): void {
    for (const [name, entry] of this.rooms) if (!entry.joined) this.attachRoom(name, entry);
    const wasConnected = this.everConnected;
    this.everConnected = true;
    this.backoff.reset();
    this.pendingEchoSince = null;
    this.setStatus('connected');
    this.flushOutbox();
    if (wasConnected) this.events.emit('reconnected', undefined);
  }

  private attachRoom(name: string, entry: RoomEntry): void {
    if (!this.socket) return;
    const gen = this.generation;
    const clientData: ClientData = {
      deviceId: this.identity.deviceId,
      name: this.identity.displayName,
      sessionId: this.identity.sessionId,
    };
    this.socket.emit('join_room', { room: name, clientData }, (ack: { ok: boolean }) => {
      if (gen !== this.generation || this.rooms.get(name) !== entry) return;
      if (!ack?.ok) log.error(`Room ${name} failed to open`);
    });
  }

  private handleRaw(room: string, raw: ServerMessage): void {
    const msg = raw.data;
    if (!isSignalingMessage(msg)) {
      log.throttled('invalid', 30_000, 'DEBUG', `Ignoring malformed message in ${room}`);
      return;
    }
    if (msg.senderSessionId === this.identity.sessionId) {
      this.pendingEchoSince = null; // our own publish came back → socket is alive
      if (this.room && msg.roomId === this.room.roomId) this.events.emit('echo', { msg, room });
      return;
    }
    if (!this.room || msg.roomId !== this.room.roomId) {
      log.debug(`Dropping ${msg.messageType} from another room`);
      return;
    }
    if (msg.receiverId !== '*' && msg.receiverId !== this.identity.deviceId) return;
    if (msg.receiverSessionId && msg.receiverSessionId !== this.identity.sessionId) return;
    if (!this.seen.add(msg.messageId)) {
      log.debug(`Duplicate ${msg.messageType} ${msg.messageId} ignored`);
      return;
    }
    this.events.emit('message', { msg, room });
  }

  private checkLiveness(): void {
    if (this._status !== 'connected' || this.pendingEchoSince === null) return;
    if (Date.now() - this.pendingEchoSince > this.config.signaling.echoWatchdogMs) {
      log.warn('No echo of our own messages – signaling socket presumed dead');
      this.pendingEchoSince = null;
      this.reconnectNow('echo-watchdog');
    }
  }

  private closeSocket(): void {
    const s = this.socket;
    this.socket = null;
    for (const entry of this.rooms.values()) entry.joined = false;
    if (!s) return;
    try {
      s.disconnect();
    } catch (err) {
      log.debug('Socket close failed', errorMessage(err));
    }
  }

  private setStatus(status: SignalingStatus): void {
    if (status === this._status) return;
    this._status = status;
    log.info(`Status = ${status}`);
    this.events.emit('status', status);
  }
}
