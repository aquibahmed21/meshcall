import { Disposer, Emitter } from '../core/emitter';
import { uuid } from '../core/ids';
import { createLogger } from '../core/logger';
import { storage } from '../core/storage';
import type { DmReply, FileMeta, SignalingMessage } from '../types/signaling';
import { isFileMeta } from './FileTransferService';
import type { IdentityService } from './IdentityService';
import type { PresenceService } from './PresenceService';
import type { NotifyResult, PushNotificationService } from './PushNotificationService';
import type { RoomContext } from './RoomService';
import type { SignalingService } from './SignalingService';

const log = createLogger('DM');

/**
 *  sending    – being handed to signaling
 *  sent       – published to the recipient's inbox (recipient was online), no ack yet
 *  delivered  – the recipient's app acknowledged it
 *  queued     – recipient offline: stored on THIS device, delivered when they come online
 *  push-accepted – the push server ACCEPTED a targeted notification (not proof of delivery)
 *  failed     – could not be sent
 */
export type DmStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'queued' | 'push-accepted' | 'failed';

export interface DirectMessage {
  messageId: string;
  roomId: string;
  /** The other participant of the conversation. */
  peerId: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  own: boolean;
  status?: DmStatus;
  statusDetail?: string;
  /** Quoted message this one answers. */
  replyTo?: DmReply;
  /** Attachment (the bytes travel peer-to-peer, see FileTransferService). */
  file?: FileMeta;
  /** Emoji reactions by user id (one each). */
  reactions?: Record<string, string>;
  edited?: boolean;
  /** Deleted for everyone – only a tombstone is shown. */
  deleted?: boolean;
  /** Incoming: a read receipt was already sent. */
  readSent?: boolean;
}

export interface Conversation {
  peerId: string;
  peerName: string;
  messages: DirectMessage[];
  unread: number;
}

export const MAX_DM_LENGTH = 2000;
export const EDIT_WINDOW_MS = 15 * 60_000;
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;
const ACK_TIMEOUT_MS = 15_000;
const MAX_PER_CONVERSATION = 300;
/** Automatic re-sends (same messageId) while the recipient stays online but no ack arrives. */
const MAX_AUTO_RESENDS = 3;

export type DmSendResult = 'ok' | 'empty' | 'too-long' | 'no-room';

/** Why a message to an offline user is queued instead of pushed (shown to the user). */
export function offlineExplanation(result: NotifyResult, name: string): string {
  if (result === 'unsupported')
    return `${name} is offline. Push delivery is unavailable (the push server cannot notify one specific person), so the message is queued on this device and delivered when ${name} comes online.`;
  if (result === 'not-subscribed')
    return `${name} is offline and hasn't enabled notifications. The message is queued on this device and delivered when ${name} comes online.`;
  if (result === 'failed') return `${name} is offline and the push request failed. The message is queued on this device and delivered when ${name} comes online.`;
  return `${name} is offline – notification sent (the push server accepted it; that does not guarantee delivery). The message is delivered when ${name} comes online.`;
}

/**
 * Room-scoped 1:1 messages, independent of calls.
 *
 * Delivery strategy:
 *   recipient ONLINE (presence)      → ScaleDrone (recipient's room inbox) → ack → "Delivered"
 *   OFFLINE / UNKNOWN / CONNECTING   → targeted push (PushNotificationService.sendToUser)
 *                                      → never /notifyAll; with the current backend 'unsupported'
 *                                      → queued on this device, flushed when they come online
 * Unknown presence is never treated as online. Retries reuse the messageId, and the recipient
 * de-duplicates, so a lost ack can never produce a duplicate message.
 */
export class DirectMessageService {
  readonly events = new Emitter<{ change: void; incoming: DirectMessage; typing: string }>();
  private typingFrom = new Map<string, ReturnType<typeof setTimeout>>();
  private lastTypingSent = 0;
  private muted = new Set<string>();
  private room: RoomContext | null = null;
  private conversations = new Map<string, Conversation>();
  private seen = new Set<string>();
  private ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private active: string | null = null;
  private inFlight = new Set<string>();
  private resends = new Map<string, number>();
  private disposer = new Disposer();

  constructor(
    private readonly signaling: SignalingService,
    private readonly identity: IdentityService,
    private readonly presence: PresenceService,
    private readonly push: PushNotificationService,
  ) {}

  start(room: RoomContext): void {
    this.stop();
    this.room = room;
    for (const c of storage.get<Conversation[]>(this.key(), [])) {
      if (!c?.peerId || !Array.isArray(c.messages)) continue;
      const messages = c.messages
        .filter((m) => m.roomId === room.roomId) // room isolation, even for persisted data
        .map((m) => (m.own && (m.status === 'sending' || m.status === 'sent') ? { ...m, status: 'queued' as DmStatus, statusDetail: 'Not confirmed before the app closed – will retry' } : m));
      this.conversations.set(c.peerId, { ...c, messages });
      for (const m of c.messages) this.seen.add(m.messageId);
    }
    this.muted = new Set(storage.get<string[]>(`voip.dm.muted.${room.roomId}`, []));
    this.disposer.add(this.signaling.events.on('message', ({ msg }) => this.onMessage(msg)));
    this.disposer.add(this.presence.events.on('change', () => this.flushQueued()));
    this.disposer.add(this.signaling.events.on('status', (s) => s === 'connected' && this.flushQueued()));
    this.events.emit('change', undefined);
  }

  /** Leave the room: persist, drop all in-memory state and listeners. */
  stop(): void {
    this.persist();
    this.disposer.dispose();
    this.ackTimers.forEach(clearTimeout);
    this.ackTimers.clear();
    this.resends.clear();
    this.typingFrom.forEach(clearTimeout);
    this.typingFrom.clear();
    this.conversations.clear();
    this.seen.clear();
    this.active = null;
    this.room = null;
    this.events.emit('change', undefined);
  }

  conversation(peerId: string): Conversation {
    return this.conversations.get(peerId) ?? { peerId, peerName: this.presence.nameOf(peerId), messages: [], unread: 0 };
  }

  unreadFor(peerId: string): number {
    return this.conversations.get(peerId)?.unread ?? 0;
  }

  /** Delete the whole conversation with someone (removing a contact). */
  deleteConversation(peerId: string): void {
    const c = this.conversations.get(peerId);
    if (!c) return;
    for (const m of c.messages) this.clearAck(m.messageId);
    this.conversations.delete(peerId);
    if (this.active === peerId) this.active = null;
    this.persist();
    this.events.emit('change', undefined);
  }

  /** The conversation the user is looking at (its incoming messages are not "unread"). */
  setActive(peerId: string | null): void {
    this.active = peerId;
    const c = peerId ? this.conversations.get(peerId) : undefined;
    if (c && c.unread) {
      c.unread = 0;
      this.persist();
      this.events.emit('change', undefined);
    }
  }

  send(peerId: string, raw: string, replyTo?: DmReply): DmSendResult {
    const text = raw.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return 'empty';
    if (text.length > MAX_DM_LENGTH) return 'too-long';
    if (!this.room) return 'no-room';
    const msg: DirectMessage = {
      messageId: uuid(),
      roomId: this.room.roomId,
      peerId,
      senderId: this.identity.deviceId,
      senderName: this.identity.displayName,
      text,
      timestamp: Date.now(),
      own: true,
      status: 'sending',
      ...(replyTo ? { replyTo } : {}),
    };
    this.seen.add(msg.messageId);
    this.append(peerId, msg);
    void this.deliver(msg);
    return 'ok';
  }

  /** Send an attachment (already stored by FileTransferService.offer) with an optional caption. */
  sendFile(peerId: string, file: FileMeta, caption = ''): DmSendResult {
    if (!this.room) return 'no-room';
    const msg: DirectMessage = {
      messageId: uuid(),
      roomId: this.room.roomId,
      peerId,
      senderId: this.identity.deviceId,
      senderName: this.identity.displayName,
      text: caption.trim().slice(0, MAX_DM_LENGTH),
      timestamp: Date.now(),
      own: true,
      status: 'sending',
      file,
    };
    this.seen.add(msg.messageId);
    this.append(peerId, msg);
    void this.deliver(msg);
    return 'ok';
  }

  /** Did we share this file with this person? (the only people allowed to fetch it) */
  sharedWith(fileId: string, peerId: string): boolean {
    return !!this.conversations.get(peerId)?.messages.some((m) => m.own && m.file?.id === fileId && !m.deleted);
  }

  /** Retry a failed/queued message now (same messageId). */
  retry(messageId: string): void {
    const m = this.find(messageId);
    if (m?.own && !m.deleted && m.status !== 'delivered' && m.status !== 'read') void this.deliver(m);
  }

  // ── delivery ─────────────────────────────────────────────────────────────

  private async deliver(m: DirectMessage): Promise<void> {
    if (this.inFlight.has(m.messageId)) return;
    this.inFlight.add(m.messageId);
    try {
      await this.deliverOnce(m);
    } finally {
      this.inFlight.delete(m.messageId);
    }
  }

  private async deliverOnce(m: DirectMessage): Promise<void> {
    const online = this.presence.status(m.peerId) === 'online';
    if (online && this.signaling.isConnected) {
      this.signaling.send(m.peerId, 'direct-message', { text: m.text, sentAt: m.timestamp, ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.file ? { file: m.file } : {}) }, { messageId: m.messageId });
      this.setStatus(m, 'sent');
      this.clearAck(m.messageId);
      this.ackTimers.set(
        m.messageId,
        setTimeout(() => {
          this.ackTimers.delete(m.messageId);
          // No ack: the recipient may have just gone offline, or the ack was lost. Keep it and
          // re-send (they de-duplicate by messageId, so a late original + retry is still one message).
          if (m.status !== 'sent') return;
          this.setStatus(m, 'queued', `Not confirmed yet – will retry when ${this.presence.nameOf(m.peerId)} is online`);
          const n = this.resends.get(m.messageId) ?? 0;
          if (n < MAX_AUTO_RESENDS && this.presence.status(m.peerId) === 'online') {
            this.resends.set(m.messageId, n + 1);
            void this.deliver(m);
          }
        }, ACK_TIMEOUT_MS),
      );
      return;
    }
    // Offline / unknown: targeted push only (never broadcast).
    const room = this.room;
    const result: NotifyResult = room
      ? await this.push.notifyChatMessage(m.peerId, {
          type: 'chat-message',
          messageId: m.messageId,
          senderId: m.senderId,
          senderName: m.senderName,
          text: m.file ? `📎 ${m.file.name}` : m.text,
          roomId: room.roomId,
          roomName: room.roomName,
          timestamp: m.timestamp,
        })
      : 'failed';
    const name = this.presence.nameOf(m.peerId);
    if (result === 'accepted') this.setStatus(m, 'push-accepted', offlineExplanation(result, name));
    else this.setStatus(m, 'queued', offlineExplanation(result, name));
  }

  /** Recipient came online (or our signaling reconnected) → send what is waiting for them. */
  private flushQueued(): void {
    if (!this.signaling.isConnected) return;
    for (const c of this.conversations.values()) {
      if (this.presence.status(c.peerId) !== 'online') continue;
      for (const m of c.messages) {
        if (m.own && !m.deleted && (m.status === 'queued' || m.status === 'push-accepted' || m.status === 'sending')) {
          log.info(`${c.peerName} is online – delivering queued message`);
          void this.deliver(m);
        }
      }
    }
  }

  // ── receiving ────────────────────────────────────────────────────────────

  private onMessage(msg: SignalingMessage): void {
    if (!this.room) return; // SignalingService already dropped other rooms' messages
    if (msg.messageType === 'direct-message') {
      // Always ack (also duplicates) so a retrying sender learns it arrived.
      this.signaling.send(msg.senderId, 'direct-message-ack', { messageId: msg.messageId }, { receiverSessionId: msg.senderSessionId });
      if (this.seen.has(msg.messageId)) return;
      const text = typeof msg.payload?.text === 'string' ? msg.payload.text.slice(0, MAX_DM_LENGTH * 2).trim() : '';
      const file = isFileMeta(msg.payload?.file) ? msg.payload.file : undefined;
      if (!text && !file) return;
      this.receive(msg.senderId, msg.senderName, msg.messageId, text, typeof msg.payload.sentAt === 'number' ? msg.payload.sentAt : msg.timestamp, msg.payload.replyTo, file);
    } else if (msg.messageType === 'direct-message-ack') {
      const m = this.find(msg.payload.messageId);
      if (!m?.own || m.peerId !== msg.senderId) return; // only the recipient can confirm
      this.clearAck(m.messageId);
      this.resends.delete(m.messageId);
      if (m.status !== 'read') this.setStatus(m, 'delivered');
    } else if (msg.messageType === 'dm-typing') {
      const peer = msg.senderId;
      const old = this.typingFrom.get(peer);
      if (old) clearTimeout(old);
      if (msg.payload.typing) {
        this.typingFrom.set(peer, setTimeout(() => (this.typingFrom.delete(peer), this.events.emit('typing', peer)), 5000));
      } else this.typingFrom.delete(peer);
      this.events.emit('typing', peer);
    } else if (msg.messageType === 'dm-read') {
      for (const id of Array.isArray(msg.payload.messageIds) ? msg.payload.messageIds : []) {
        const m = this.find(id);
        if (m?.own && m.peerId === msg.senderId && !m.deleted) {
          this.clearAck(id);
          m.status = 'read';
        }
      }
      this.persist();
      this.events.emit('change', undefined);
    } else if (msg.messageType === 'dm-react') {
      const m = this.find(msg.payload.messageId);
      if (!m || m.peerId !== msg.senderId || m.deleted) return;
      this.applyReaction(m, msg.senderId, msg.payload.emoji);
    } else if (msg.messageType === 'dm-edit') {
      const m = this.find(msg.payload.messageId);
      const text = typeof msg.payload.text === 'string' ? msg.payload.text.slice(0, MAX_DM_LENGTH).trim() : '';
      if (!m || m.own || m.peerId !== msg.senderId || m.deleted || !text) return;
      m.text = text;
      m.edited = true;
      this.persist();
      this.events.emit('change', undefined);
    } else if (msg.messageType === 'dm-delete') {
      const m = this.find(msg.payload.messageId);
      if (!m || m.own || m.peerId !== msg.senderId) return;
      this.tombstone(m);
    }
  }

  private receive(senderId: string, senderName: string, messageId: string, text: string, sentAt: number, replyTo?: DmReply, file?: FileMeta): void {
    if (!this.room) return;
    this.seen.add(messageId);
    this.presence.learn(senderId, senderName);
    this.typingFrom.delete(senderId);
    const m: DirectMessage = {
      messageId,
      roomId: this.room.roomId,
      peerId: senderId,
      senderId,
      senderName,
      text,
      timestamp: sentAt,
      own: false,
      ...(file ? { file: { id: file.id, name: file.name.slice(0, 120), size: file.size, mime: file.mime.slice(0, 100) } } : {}),
      ...(replyTo && typeof replyTo.messageId === 'string' ? { replyTo: { messageId: replyTo.messageId, name: String(replyTo.name ?? '').slice(0, 60), text: String(replyTo.text ?? '').slice(0, 120) } } : {}),
    };
    this.append(senderId, m, senderName);
    if (this.active !== senderId) this.conversations.get(senderId)!.unread++;
    this.persist();
    this.events.emit('incoming', m);
    this.events.emit('change', undefined);
  }

  // ── actions on messages ──────────────────────────────────────────────────

  /** Tell the contact we are typing (throttled; no-op while they are offline). */
  notifyTyping(peerId: string, typing: boolean): void {
    if (this.presence.status(peerId) !== 'online' || !this.signaling.isConnected) return;
    const now = Date.now();
    if (typing && now - this.lastTypingSent < 3000) return;
    this.lastTypingSent = typing ? now : 0;
    this.signaling.send(peerId, 'dm-typing', { typing }, {});
  }

  isTyping(peerId: string): boolean {
    return this.typingFrom.has(peerId);
  }

  /** The reader sees these messages now → read receipts. */
  markRead(peerId: string): void {
    const c = this.conversations.get(peerId);
    if (!c) return;
    const ids = c.messages.filter((m) => !m.own && !m.readSent && !m.deleted).map((m) => m.messageId);
    if (!ids.length) return;
    for (const m of c.messages) if (!m.own) m.readSent = true;
    this.persist();
    if (this.signaling.isConnected && this.presence.status(peerId) === 'online') this.signaling.send(peerId, 'dm-read', { messageIds: ids }, {});
  }

  react(messageId: string, emoji: string | null): void {
    const m = this.find(messageId);
    if (!m || m.deleted) return;
    const me = this.identity.deviceId;
    const next = emoji && m.reactions?.[me] === emoji ? null : emoji; // tapping your reaction again removes it
    this.applyReaction(m, me, next);
    if (this.signaling.isConnected && this.presence.status(m.peerId) === 'online') this.signaling.send(m.peerId, 'dm-react', { messageId, emoji: next }, {});
  }

  private applyReaction(m: DirectMessage, userId: string, emoji: string | null): void {
    const r = { ...(m.reactions ?? {}) };
    if (emoji && (REACTIONS as readonly string[]).includes(emoji)) r[userId] = emoji;
    else delete r[userId];
    if (Object.keys(r).length) m.reactions = r;
    else delete m.reactions;
    this.persist();
    this.events.emit('change', undefined);
  }

  canEdit(m: DirectMessage): boolean {
    return m.own && !m.deleted && Date.now() - m.timestamp < EDIT_WINDOW_MS;
  }

  private peerHasIt(m: DirectMessage): boolean {
    return m.status === 'sent' || m.status === 'delivered' || m.status === 'read';
  }

  /** Edit my message (within 15 min). Returns false if the contact must be online first. */
  edit(messageId: string, raw: string): 'ok' | 'offline' | 'invalid' {
    const m = this.find(messageId);
    const text = raw.replace(/\r\n?/g, '\n').trim();
    if (!m || !this.canEdit(m) || !text || text.length > MAX_DM_LENGTH) return 'invalid';
    const online = this.signaling.isConnected && this.presence.status(m.peerId) === 'online';
    if (this.peerHasIt(m) && !online) return 'offline';
    m.text = text;
    m.edited = true;
    this.persist();
    this.events.emit('change', undefined);
    if (this.peerHasIt(m)) this.signaling.send(m.peerId, 'dm-edit', { messageId, text }, {});
    return 'ok';
  }

  deleteForMe(messageId: string): void {
    for (const c of this.conversations.values()) {
      const i = c.messages.findIndex((x) => x.messageId === messageId);
      if (i >= 0) {
        this.clearAck(messageId);
        c.messages.splice(i, 1);
        this.persist();
        this.events.emit('change', undefined);
        return;
      }
    }
  }

  /** Remove my message for both sides. Returns false if the contact must be online first. */
  deleteForEveryone(messageId: string): boolean {
    const m = this.find(messageId);
    if (!m?.own) return false;
    const online = this.signaling.isConnected && this.presence.status(m.peerId) === 'online';
    if (this.peerHasIt(m) && !online) return false;
    this.clearAck(messageId);
    if (this.peerHasIt(m)) this.signaling.send(m.peerId, 'dm-delete', { messageId }, {});
    this.tombstone(m);
    return true;
  }

  private tombstone(m: DirectMessage): void {
    m.deleted = true;
    m.text = '';
    delete m.reactions;
    delete m.replyTo;
    this.persist();
    this.events.emit('change', undefined);
  }

  isMuted(peerId: string): boolean {
    return this.muted.has(peerId);
  }

  setMuted(peerId: string, on: boolean): void {
    if (on) this.muted.add(peerId);
    else this.muted.delete(peerId);
    if (this.room) storage.set(`voip.dm.muted.${this.room.roomId}`, [...this.muted]);
    this.events.emit('change', undefined);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private append(peerId: string, m: DirectMessage, name?: string): void {
    let c = this.conversations.get(peerId);
    if (!c) {
      c = { peerId, peerName: name ?? this.presence.nameOf(peerId), messages: [], unread: 0 };
      this.conversations.set(peerId, c);
    }
    if (name) c.peerName = name;
    let i = c.messages.length;
    while (i > 0 && c.messages[i - 1]!.timestamp > m.timestamp) i--;
    c.messages.splice(i, 0, m);
    if (c.messages.length > MAX_PER_CONVERSATION) c.messages.splice(0, c.messages.length - MAX_PER_CONVERSATION);
    this.persist();
    this.events.emit('change', undefined);
  }

  private setStatus(m: DirectMessage, status: DmStatus, detail?: string): void {
    m.status = status;
    m.statusDetail = detail;
    this.persist();
    this.events.emit('change', undefined);
  }

  private find(messageId: string): DirectMessage | undefined {
    for (const c of this.conversations.values()) {
      const m = c.messages.find((x) => x.messageId === messageId);
      if (m) return m;
    }
    return undefined;
  }

  private clearAck(id: string): void {
    const t = this.ackTimers.get(id);
    if (t) clearTimeout(t);
    this.ackTimers.delete(id);
  }

  private key(): string {
    return `voip.dm.${this.room?.roomId ?? ''}`;
  }

  private persist(): void {
    if (this.room) storage.set(this.key(), [...this.conversations.values()]);
  }
}
