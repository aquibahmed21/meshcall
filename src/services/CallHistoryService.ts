import { Disposer, Emitter } from '../core/emitter';
import { storage } from '../core/storage';
import type { CallManager } from '../calls/CallManager';
import { isTerminal } from '../calls/CallStateMachine';
import type { MediaKind } from '../types/signaling';
import type { CallState } from '../types/state';
import type { IdentityService } from './IdentityService';
import type { RoomContext } from './RoomService';

export type CallOutcome = 'answered' | 'missed' | 'declined' | 'no-answer' | 'cancelled' | 'busy' | 'failed' | 'elsewhere';

export interface CallHistoryEntry {
  callId: string;
  kind: 'direct' | 'group';
  direction: 'incoming' | 'outgoing';
  media: MediaKind;
  /** Other participants (1:1: the remote user). Names as seen during the call. */
  peers: Array<{ deviceId: string; name: string }>;
  title?: string;
  outcome: CallOutcome;
  startedAt: number;
  /** Talk time (connected → ended); 0 if never connected. */
  durationMs: number;
}

const MAX_ENTRIES = 100;

/** Classify a finished call from its final state (see CallManager.finish details). */
export function callOutcome(c: Pick<CallState, 'direction' | 'status' | 'statusDetail' | 'connectedAt'>): CallOutcome {
  if (c.connectedAt) return 'answered';
  const detail = c.statusDetail ?? '';
  if (c.direction === 'incoming') {
    if (detail === 'Declined') return 'declined';
    if (detail === 'Answered on another device') return 'elsewhere';
    return 'missed';
  }
  if (c.status === 'rejected') return 'declined';
  if (c.status === 'busy') return 'busy';
  if (c.status === 'failed') return 'failed';
  if (detail === 'Cancelled') return 'cancelled';
  return 'no-answer';
}

/**
 * Room-scoped call log (1:1 and group calls; live streams are not "calls"). One entry per call,
 * written when the call reaches a terminal state.
 */
export class CallHistoryService {
  readonly events = new Emitter<{ change: void }>();
  private room: RoomContext | null = null;
  private entries: CallHistoryEntry[] = [];
  /** Everyone who took part in the running call (participants can leave before it ends). */
  private seen = new Map<string, Map<string, string>>();
  private recorded = new Set<string>();
  private disposer = new Disposer();

  constructor(
    private readonly calls: CallManager,
    private readonly identity: IdentityService,
  ) {}

  start(room: RoomContext): void {
    this.stop();
    this.room = room;
    const stored = storage.get<unknown>(this.key(), []);
    this.entries = Array.isArray(stored) ? (stored as CallHistoryEntry[]).filter((e) => e && typeof e.callId === 'string') : [];
    for (const e of this.entries) this.recorded.add(e.callId);
    this.disposer.add(this.calls.events.on('state', (c) => c && this.observe(c)));
    this.events.emit('change', undefined);
  }

  stop(): void {
    this.disposer.dispose();
    this.room = null;
    this.entries = [];
    this.seen.clear();
    this.recorded.clear();
    this.events.emit('change', undefined);
  }

  /** Newest first. */
  list(): CallHistoryEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.persist();
    this.events.emit('change', undefined);
  }

  private observe(c: CallState): void {
    if (c.kind === 'live' || this.recorded.has(c.callId)) return;
    let peers = this.seen.get(c.callId);
    if (!peers) this.seen.set(c.callId, (peers = new Map()));
    if (c.remoteUser) peers.set(c.remoteUser.deviceId, c.remoteUser.name);
    for (const p of c.participants.values()) if (p.deviceId !== this.identity.deviceId) peers.set(p.deviceId, p.name);
    if (!isTerminal(c.status)) return;

    this.recorded.add(c.callId);
    this.seen.delete(c.callId);
    const entry: CallHistoryEntry = {
      callId: c.callId,
      kind: c.kind === 'group' ? 'group' : 'direct',
      direction: c.direction,
      media: c.media,
      peers: [...peers].map(([deviceId, name]) => ({ deviceId, name })),
      title: c.kind === 'group' ? c.title : undefined,
      outcome: callOutcome(c),
      startedAt: c.startedAt,
      durationMs: c.connectedAt ? Math.max(0, (c.endedAt ?? Date.now()) - c.connectedAt) : 0,
    };
    this.entries = [entry, ...this.entries].slice(0, MAX_ENTRIES);
    this.persist();
    this.events.emit('change', undefined);
  }

  private key(): string {
    return `voip.callHistory.${this.room?.roomId ?? ''}`;
  }

  private persist(): void {
    if (this.room) storage.set(this.key(), this.entries);
  }
}
