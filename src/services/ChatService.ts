import { Disposer, Emitter } from '../core/emitter';
import { createLogger } from '../core/logger';
import type { SignalingMessage } from '../types/signaling';
import type { IdentityService } from './IdentityService';
import { meshRoom, type SendOptions, type SignalingService, type SignalingStatus } from './SignalingService';

const log = createLogger('Chat');

/** Domain chat message (built from the signaling envelope). */
export interface ChatMessage {
  type: 'chat-message';
  messageId: string;
  senderId: string;
  senderName: string;
  receiverId?: string;
  callId?: string;
  text: string;
  timestamp: number;
}

export type Delivery = 'sending' | 'sent' | 'failed' | 'received';

export interface ChatEntry extends ChatMessage {
  own: boolean;
  delivery: Delivery;
}

export type ChatStatus = 'connected' | 'connecting' | 'disconnected' | 'sending' | 'error';

export type SendResult = 'sent' | 'empty' | 'too-long' | 'unavailable' | 'no-call' | 'duplicate';

export const MAX_CHAT_LENGTH = 2000;
/** Incoming text longer than this is truncated (defensive – senders are capped at MAX_CHAT_LENGTH). */
const MAX_INCOMING_LENGTH = 4000;
const MAX_MESSAGES = 500;
/** No echo from ScaleDrone within this time → mark the message as failed (can be retried). */
const DELIVERY_TIMEOUT_MS = 12_000;
/** Same text submitted again within this window is treated as an accidental double-send. */
const DOUBLE_SEND_WINDOW_MS = 800;

/** The slice of SignalingService chat needs – keeps the service unit-testable. */
export type ChatTransport = Pick<SignalingService, 'events' | 'broadcast' | 'status'>;

/**
 * Call-scoped text chat over the existing ScaleDrone signaling channel.
 *
 * - Bound to exactly one callId at a time; messages for any other call are ignored.
 * - De-duplicates by messageId (processedMessageIds) and keeps messages ordered by
 *   (timestamp, messageId) no matter in which order they arrive.
 * - Own messages are shown immediately as "sending" and flip to "sent" when ScaleDrone echoes
 *   them back; no echo within DELIVERY_TIMEOUT_MS → "failed" (retry re-uses the same messageId,
 *   so receivers that already got it drop the duplicate).
 * - Completely independent of WebRTC: a failing peer connection does not touch chat state,
 *   and a signaling outage never touches the call. State is cleared only when the call ends.
 */
export class ChatService {
  readonly events = new Emitter<{ change: void }>();

  private callId: string | null = null;
  private entries: ChatEntry[] = [];
  private processedMessageIds = new Set<string>();
  private deliveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unreadCount = 0;
  private panelOpen = false;
  private lastError = false;
  private lastSend: { text: string; at: number } | null = null;
  private disposer = new Disposer();

  constructor(
    private readonly signaling: ChatTransport,
    private readonly identity: Pick<IdentityService, 'deviceId' | 'displayName'>,
  ) {}

  /** Attach signaling listeners exactly once for the app's lifetime. */
  start(): void {
    this.disposer.dispose();
    this.disposer.add(this.signaling.events.on('message', ({ msg }) => this.onMessage(msg)));
    this.disposer.add(this.signaling.events.on('echo', ({ msg }) => this.onEcho(msg)));
    this.disposer.add(this.signaling.events.on('status', () => this.events.emit('change', undefined)));
  }

  stop(): void {
    this.disposer.dispose();
    this.unbind();
  }

  // ── call binding ─────────────────────────────────────────────────────────

  /** Start a clean, call-specific chat. Re-binding the same call is a no-op. */
  bind(callId: string): void {
    if (this.callId === callId) return;
    this.reset();
    this.callId = callId;
    log.info(`Chat bound to call ${callId.slice(0, 8)}`);
    this.events.emit('change', undefined);
  }

  /** Call ended: drop messages, unread state, processed ids and pending timers. */
  unbind(): void {
    if (this.callId === null && this.entries.length === 0) return;
    this.reset();
    this.events.emit('change', undefined);
  }

  get boundCallId(): string | null {
    return this.callId;
  }

  // ── state ────────────────────────────────────────────────────────────────

  get messages(): readonly ChatEntry[] {
    return this.entries;
  }

  get unread(): number {
    return this.unreadCount;
  }

  get status(): ChatStatus {
    const sig: SignalingStatus = this.signaling.status;
    if (sig === 'connecting' || sig === 'reconnecting' || sig === 'loading') return 'connecting';
    if (sig !== 'connected') return 'disconnected';
    if (this.deliveryTimers.size > 0) return 'sending';
    if (this.lastError) return 'error';
    return 'connected';
  }

  get canSend(): boolean {
    return this.callId !== null && this.signaling.status === 'connected';
  }

  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
    if (open && this.unreadCount) {
      this.unreadCount = 0;
      this.events.emit('change', undefined);
    }
  }

  // ── sending ──────────────────────────────────────────────────────────────

  send(raw: string): SendResult {
    const text = normalize(raw);
    if (!text) return 'empty';
    if (text.length > MAX_CHAT_LENGTH) return 'too-long';
    if (!this.callId) return 'no-call';
    if (this.signaling.status !== 'connected') return 'unavailable';
    const now = Date.now();
    if (this.lastSend && this.lastSend.text === text && now - this.lastSend.at < DOUBLE_SEND_WINDOW_MS) return 'duplicate';
    this.lastSend = { text, at: now };

    const messageId = this.publish(text);
    const entry: ChatEntry = {
      type: 'chat-message',
      messageId,
      senderId: this.identity.deviceId,
      senderName: this.identity.displayName,
      callId: this.callId,
      text,
      timestamp: now,
      own: true,
      delivery: 'sending',
    };
    this.processedMessageIds.add(messageId);
    this.insert(entry);
    this.armDeliveryTimer(messageId);
    this.events.emit('change', undefined);
    return 'sent';
  }

  /** Re-send a failed own message with the SAME messageId (receivers de-duplicate). */
  retry(messageId: string): boolean {
    const e = this.entries.find((m) => m.messageId === messageId && m.own);
    if (!e || e.delivery !== 'failed' || !this.canSend || e.callId !== this.callId) return false;
    this.publish(e.text, messageId);
    e.delivery = 'sending';
    this.armDeliveryTimer(messageId);
    this.events.emit('change', undefined);
    return true;
  }

  // ── receiving ────────────────────────────────────────────────────────────

  private onMessage(msg: SignalingMessage): void {
    if (msg.messageType !== 'chat-message') return;
    // Never blindly append: only messages for the call we are in, once per messageId.
    if (!this.callId || msg.callId !== this.callId) {
      log.debug('Ignoring chat message for another/ended call');
      return;
    }
    if (this.processedMessageIds.has(msg.messageId)) return;
    const payload = msg.payload as { text?: unknown };
    if (typeof payload?.text !== 'string') return;
    const text = normalize(payload.text).slice(0, MAX_INCOMING_LENGTH);
    if (!text) return;
    this.processedMessageIds.add(msg.messageId);
    this.insert({
      type: 'chat-message',
      messageId: msg.messageId,
      senderId: msg.senderId,
      senderName: msg.senderName || 'Unknown',
      receiverId: msg.receiverId === '*' ? undefined : msg.receiverId,
      callId: msg.callId,
      text,
      timestamp: Number.isFinite(msg.timestamp) ? msg.timestamp : Date.now(),
      own: msg.senderId === this.identity.deviceId,
      delivery: 'received',
    });
    if (!this.panelOpen) this.unreadCount++;
    this.events.emit('change', undefined);
  }

  private onEcho(msg: SignalingMessage): void {
    if (msg.messageType !== 'chat-message') return;
    const e = this.entries.find((m) => m.messageId === msg.messageId && m.own);
    if (!e) return;
    this.clearDeliveryTimer(msg.messageId);
    e.delivery = 'sent';
    this.lastError = false;
    this.events.emit('change', undefined);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private publish(text: string, messageId?: string): string {
    const opts: SendOptions = { callId: this.callId, messageId };
    return this.signaling.broadcast(meshRoom(this.callId!), 'chat-message', { text }, opts);
  }

  /** Keep entries sorted by (timestamp, messageId) – tolerant of out-of-order arrival. */
  private insert(entry: ChatEntry): void {
    let i = this.entries.length;
    while (i > 0 && compare(this.entries[i - 1]!, entry) > 0) i--;
    this.entries.splice(i, 0, entry);
    if (this.entries.length > MAX_MESSAGES) this.entries.splice(0, this.entries.length - MAX_MESSAGES);
  }

  private armDeliveryTimer(messageId: string): void {
    this.clearDeliveryTimer(messageId);
    const callId = this.callId;
    this.deliveryTimers.set(
      messageId,
      setTimeout(() => {
        this.deliveryTimers.delete(messageId);
        if (this.callId !== callId) return;
        const e = this.entries.find((m) => m.messageId === messageId);
        if (e && e.delivery === 'sending') {
          e.delivery = 'failed';
          this.lastError = true;
          log.warn('Chat message not confirmed by the signaling server – marked as failed');
          this.events.emit('change', undefined);
        }
      }, DELIVERY_TIMEOUT_MS),
    );
  }

  private clearDeliveryTimer(messageId: string): void {
    const t = this.deliveryTimers.get(messageId);
    if (t) clearTimeout(t);
    this.deliveryTimers.delete(messageId);
  }

  private reset(): void {
    for (const t of this.deliveryTimers.values()) clearTimeout(t);
    this.deliveryTimers.clear();
    this.entries = [];
    this.processedMessageIds.clear();
    this.unreadCount = 0;
    this.lastError = false;
    this.lastSend = null;
    this.callId = null;
  }
}

/** Trim the whole message, normalise newlines, collapse runs of 3+ blank lines. */
export function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function compare(a: ChatEntry, b: ChatEntry): number {
  return a.timestamp - b.timestamp || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0);
}
