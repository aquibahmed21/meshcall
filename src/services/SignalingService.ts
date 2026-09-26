import { Backoff, BoundedSet, Timer, withTimeout } from '../core/async';
import { Emitter } from '../core/emitter';
import { uuid } from '../core/ids';
import { createLogger, errorMessage } from '../core/logger';
import type { AppConfig } from '../config';
import type { ScaledroneClient, ScaledroneConstructor, ScaledroneMember, ScaledroneMessage, ScaledroneRoom } from '../types/scaledrone';
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
const SCRIPT_URL = 'https://cdn.scaledrone.com/scaledrone.min.js';

export type SignalingStatus = 'idle' | 'loading' | 'connecting' | 'connected' | 'reconnecting' | 'unavailable';

export interface ClientData {
  deviceId: string;
  name: string;
  sessionId: string;
}
export type Member = ScaledroneMember<ClientData>;

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
  room: ScaledroneRoom | null;
}

interface Outgoing {
  room: string;
  message: SignalingMessage;
  queuedAt: number;
}

const OUTBOX_LIMIT = 300;
const OUTBOX_MAX_AGE_MS = 20_000;
const ECHO_TIMEOUT_MS = 20_000;

export const inboxRoom = (roomKey: string, deviceId: string) => `inbox-${roomKey}-${deviceId}`;
export const lobbyRoom = (roomKey: string) => `observable-room-${roomKey}`;
export const meshRoom = (callId: string) => `mesh-${callId}`;

/**
 * ScaleDrone transport.
 *
 *  - Loads the ScaleDrone client from the CDN (with timeout + retry).
 *  - Tracks connection status; relies on ScaleDrone's own reconnect for abnormal closures and
 *    re-creates the client with exponential backoff when ScaleDrone gives up ('close').
 *  - Liveness watchdog: ScaleDrone echoes our own publishes back to us. If a publish to a room we
 *    are subscribed to is not echoed within ECHO_TIMEOUT_MS the socket is presumed dead (common
 *    after Wi-Fi switches / sleep where the WebSocket never errors) and the client is re-created.
 *  - Outgoing messages are queued while disconnected and flushed (minus stale ones) on reconnect.
 *  - Incoming messages are validated, filtered to this device/session, and de-duplicated by messageId.
 */
export class SignalingService {
  readonly events = new Emitter<{
    status: SignalingStatus;
    message: { msg: SignalingMessage; room: string };
    reconnected: void;
    /** One of OUR publishes came back from ScaleDrone (i.e. the server accepted and fanned it out). */
    echo: { msg: SignalingMessage; room: string };
  }>();

  private _status: SignalingStatus = 'idle';
  private ctor: ScaledroneConstructor | null = null;
  private drone: ScaledroneClient | null = null;
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
  /** Current room scope: stamped on every outgoing message, required on every incoming one. */
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
   * messages of any other room are dropped from now on (stale-room protection).
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
    this.closeDrone();
    this.setStatus('idle');
  }

  /** Subscribe to a room. Survives client re-creation. Returns an unsubscribe function. */
  subscribe(name: string, handlers: RoomHandlers = {}): () => void {
    const entry: RoomEntry = { handlers, room: null };
    this.rooms.get(name)?.room?.unsubscribe();
    this.rooms.set(name, entry);
    if (this.drone && this._status === 'connected') this.attachRoom(name, entry);
    return () => {
      if (this.rooms.get(name) !== entry) return;
      this.rooms.delete(name);
      try {
        entry.room?.unsubscribe();
      } catch (err) {
        log.debug(`Unsubscribe ${name} failed`, errorMessage(err));
      }
    };
  }

  /** Directed message to one device (all of its sessions unless receiverSessionId is set). */
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

  /** Force a fresh ScaleDrone connection (e.g. after network change / dead socket). */
  reconnectNow(reason: string): void {
    if (this.stopped) return;
    log.info(`Re-creating signaling connection (${reason})`);
    this.generation++;
    this.closeDrone();
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
    if (this._status !== 'connected' || !this.drone) {
      this.enqueue(room, message);
      return;
    }
    try {
      this.drone.publish({ room, message });
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

  private async loadClient(): Promise<ScaledroneConstructor> {
    if (this.ctor) return this.ctor;
    if (window.Scaledrone) return (this.ctor = window.Scaledrone);
    this.setStatus('loading');
    const load = new Promise<ScaledroneConstructor>((resolve, reject) => {
      document.querySelector(`script[src="${SCRIPT_URL}"]`)?.remove();
      const s = document.createElement('script');
      s.src = SCRIPT_URL;
      s.async = true;
      s.onload = () => (window.Scaledrone ? resolve(window.Scaledrone) : reject(new Error('Scaledrone global missing')));
      s.onerror = () => reject(new Error('Failed to load ScaleDrone client'));
      document.head.appendChild(s);
    });
    this.ctor = await withTimeout(load, 15_000, 'ScaleDrone script load');
    return this.ctor;
  }

  private async connect(): Promise<void> {
    const gen = ++this.generation;
    let Ctor: ScaledroneConstructor;
    try {
      Ctor = await this.loadClient();
    } catch (err) {
      log.error('ScaleDrone unavailable', errorMessage(err));
      this.setStatus('unavailable');
      this.scheduleRetry(gen);
      return;
    }
    if (gen !== this.generation || this.stopped) return;

    this.setStatus(this.everConnected ? 'reconnecting' : 'connecting');
    const clientData: ClientData = {
      deviceId: this.identity.deviceId,
      name: this.identity.displayName,
      sessionId: this.identity.sessionId,
    };
    let drone: ScaledroneClient;
    try {
      drone = new Ctor(this.config.scaledroneChannelId, { data: clientData });
    } catch (err) {
      log.error('Could not create ScaleDrone client', errorMessage(err));
      this.setStatus('unavailable');
      this.scheduleRetry(gen);
      return;
    }
    this.drone = drone;
    const current = () => gen === this.generation && !this.stopped;
    let opened = false;

    const openTimer = new Timer();
    openTimer.start(20_000, () => {
      if (current() && this._status !== 'connected') {
        log.warn('ScaleDrone connection timed out');
        this.retryAfterFailure(gen);
      }
    });

    drone.on('open', (error) => {
      openTimer.clear();
      if (!current()) return;
      if (error) {
        log.error('ScaleDrone connection error', errorMessage(error));
        this.retryAfterFailure(gen);
        return;
      }
      opened = true;
      this.onConnected(); // attaches every room to this fresh client
    });
    drone.on('error', (error) => {
      if (current()) log.throttled('error', 10_000, 'WARN', 'ScaleDrone error', errorMessage(error));
    });
    drone.on('disconnect', () => {
      if (!current()) return;
      log.warn('Disconnected – ScaleDrone is reconnecting');
      this.setStatus('reconnecting');
    });
    drone.on('reconnect', () => {
      if (!current()) return;
      // ScaleDrone's internal reconnect only restores rooms it already knew, and a client whose
      // FIRST handshake never completed (e.g. the app started offline) cannot subscribe/publish
      // afterwards. In those cases use a brand-new client so every room is attached on 'open'.
      const pending = [...this.rooms.values()].some((e) => !e.room);
      if (!opened || pending) {
        log.info('Reconnected – switching to a fresh client to (re)attach rooms');
        this.reconnectNow(opened ? 'rooms pending after reconnect' : 'first handshake never completed');
        return;
      }
      log.info('Reconnected (ScaleDrone auto-reconnect)');
      this.onConnected();
    });
    drone.on('close', () => {
      if (!current()) return;
      log.warn('Connection closed – scheduling reconnect');
      this.retryAfterFailure(gen);
    });
  }

  private retryAfterFailure(gen: number): void {
    if (gen !== this.generation) return;
    this.generation++;
    this.closeDrone();
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
    // Rooms subscribed while we were disconnected/reconnecting were never attached to a ScaleDrone
    // client (ScaleDrone's auto-reconnect only re-subscribes rooms it already knew). Attach them
    // now – otherwise joining a room or starting a call during a network blip would silently
    // never receive anything.
    for (const [name, entry] of this.rooms) if (!entry.room) this.attachRoom(name, entry);
    const wasConnected = this.everConnected;
    this.everConnected = true;
    this.backoff.reset();
    this.pendingEchoSince = null;
    this.setStatus('connected');
    this.flushOutbox();
    if (wasConnected) this.events.emit('reconnected', undefined);
  }

  private attachRoom(name: string, entry: RoomEntry): void {
    if (!this.drone) return;
    const gen = this.generation;
    const room = this.drone.subscribe(name);
    entry.room = room;
    const live = () => gen === this.generation && this.rooms.get(name) === entry;
    room.on('open', (error) => {
      if (!live()) return;
      if (error) {
        log.error(`Room ${name} failed to open`, errorMessage(error));
        return;
      }
      log.debug(`Room open: ${name}`);
      entry.handlers.onOpen?.();
    });
    room.on('message', (m) => live() && this.handleRaw(name, m));
    if (name.startsWith('observable-')) {
      room.on('members', (ms) => live() && entry.handlers.onMembers?.(ms as Member[]));
      room.on('member_join', (m) => live() && entry.handlers.onMemberJoin?.(m as Member));
      room.on('member_leave', (m) => live() && entry.handlers.onMemberLeave?.(m as Member));
    }
  }

  private handleRaw(room: string, raw: ScaledroneMessage): void {
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
    if (Date.now() - this.pendingEchoSince > ECHO_TIMEOUT_MS) {
      log.warn('No echo of our own messages – signaling socket presumed dead');
      this.pendingEchoSince = null;
      this.reconnectNow('echo-watchdog');
    }
  }

  private closeDrone(): void {
    const d = this.drone;
    this.drone = null;
    for (const entry of this.rooms.values()) entry.room = null;
    if (!d) return;
    try {
      d.close();
    } catch (err) {
      log.debug('ScaleDrone close failed', errorMessage(err));
    }
  }

  private setStatus(status: SignalingStatus): void {
    if (status === this._status) return;
    this._status = status;
    log.info(`Status = ${status}`);
    this.events.emit('status', status);
  }
}

export type { ScaledroneMember };
