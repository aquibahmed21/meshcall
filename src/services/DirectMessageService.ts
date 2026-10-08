import { Disposer, Emitter } from '../core/emitter';
import { uuid } from '../core/ids';
import { createLogger } from '../core/logger';
import { storage } from '../core/storage';
import type { SignalingMessage } from '../types/signaling';
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
export type DmStatus = 'sending' | 'sent' | 'delivered' | 'queued' | 'push-accepted' | 'failed';

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
}

export interface Conversation {
  peerId: string;
  peerName: string;
  messages: DirectMessage[];
  unread: number;
}

export const MAX_DM_LENGTH = 2000;
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
  readonly events = new Emitter<{ change: void; incoming: DirectMessage }>();
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

  send(peerId: string, raw: string): DmSendResult {
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
    };
    this.seen.add(msg.messageId);
    this.append(peerId, msg);
    void this.deliver(msg);
    return 'ok';
  }

  /** Retry a failed/queued message now (same messageId). */
  retry(messageId: string): void {
    const m = this.find(messageId);
    if (m?.own && m.status !== 'delivered') void this.deliver(m);
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
      this.signaling.send(m.peerId, 'direct-message', { text: m.text, sentAt: m.timestamp }, { messageId: m.messageId });
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
          text: m.text,
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
        if (m.own && (m.status === 'queued' || m.status === 'push-accepted' || m.status === 'sending')) {
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
      if (!text) return;
      this.seen.add(msg.messageId);
      this.presence.learn(msg.senderId, msg.senderName);
      const m: DirectMessage = {
        messageId: msg.messageId,
        roomId: this.room.roomId,
        peerId: msg.senderId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        text,
        timestamp: typeof msg.payload.sentAt === 'number' ? msg.payload.sentAt : msg.timestamp,
        own: false,
      };
      this.append(msg.senderId, m, msg.senderName);
      if (this.active !== msg.senderId) this.conversations.get(msg.senderId)!.unread++;
      this.persist();
      this.events.emit('incoming', m);
      this.events.emit('change', undefined);
    } else if (msg.messageType === 'direct-message-ack') {
      const m = this.find(msg.payload.messageId);
      if (!m?.own || m.peerId !== msg.senderId) return; // only the recipient can confirm
      this.clearAck(m.messageId);
      this.resends.delete(m.messageId);
      this.setStatus(m, 'delivered');
    }
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
