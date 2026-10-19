import { Disposer, Emitter } from '../core/emitter';
import { uuid } from '../core/ids';
import { createLogger } from '../core/logger';
import { storage } from '../core/storage';
import type { IdentityService } from '../services/IdentityService';
import { lobbyRoom, type SignalingService } from '../services/SignalingService';
import type { AudienceMode, MediaKind, OpenInviteInfo, SignalingMessage } from '../types/signaling';
import type { CallState } from '../types/state';
import type { CallManager } from './CallManager';
import { isTerminal } from './CallStateMachine';

const log = createLogger('Invite');
const ANNOUNCE_MS = 10_000;
const EXPIRE_MS = 35_000;
/** Survives a reload of the initiator's tab (sessionStorage), so the invite is not lost. */
const HOSTED_KEY = 'voip.hostedInvite';

/** An open invite visible to this user. */
export interface OpenInvite extends OpenInviteInfo {
  hostId: string;
  hostName: string;
  lastSeen: number;
}

/**
 * Open invites – drop-in group calls.
 *
 * The initiator picks everyone or specific people and opens the invite; it is announced in the
 * room lobby (`invite-started`, re-sent every ANNOUNCE_MS). Invited people see a Join button and
 * can join, leave and rejoin as often as they like. The call is an ordinary group mesh with
 * callId = inviteId, so joining is just a `mesh-join` and every pair negotiates its own link.
 * The invite (and the call for everyone) ends only when the initiator ends it (`invite-stopped`),
 * leaves the room, or stops announcing (tab closed → expires after EXPIRE_MS).
 *
 * Access is enforced by every participant's MeshSession (allow-list = initiator + selected
 * people), not by hiding the Join button.
 */
export class InviteManager {
  readonly events = new Emitter<{
    change: OpenInvite[];
    /** An invite for us appeared (show a Join prompt). */
    new: OpenInvite;
    /** The initiator left the call of their own invite – it is still open. */
    hostLeft: OpenInvite;
  }>();
  private invites = new Map<string, OpenInvite>();
  private hosted: OpenInviteInfo | null = null;
  private disposer = new Disposer();
  private lastCall: CallState | null = null;

  constructor(
    private readonly calls: CallManager,
    private readonly signaling: SignalingService,
    private readonly identity: IdentityService,
  ) {}

  /** Enter the room: listen for invites of THIS room; resume our own invite after a reload. */
  start(): void {
    this.stop();
    this.disposer.add(this.signaling.events.on('message', ({ msg }) => this.onMessage(msg)));
    this.disposer.add(this.calls.events.on('state', (s) => this.onCallState(s)));
    this.disposer.interval(() => {
      this.announce(true);
      this.expire();
    }, ANNOUNCE_MS);
    const room = this.signaling.currentRoom;
    const saved = storage.get<{ roomId: string; info: OpenInviteInfo } | null>(HOSTED_KEY, null, 'session');
    if (saved && room && saved.roomId === room.roomId) {
      this.hosted = saved.info;
      log.info(`Resuming your invite "${saved.info.title}"`);
      this.announce(true);
      this.emit();
    }
  }

  /** Leave the room: our invite ends (told to everyone while signaling is still scoped). */
  stop(): void {
    if (this.hosted) this.endInvite();
    this.disposer.dispose();
    this.invites.clear();
    this.lastCall = null;
    this.emit();
  }

  /** Visible invites, own first, then newest. */
  list(): OpenInvite[] {
    const own = this.hosted ? [{ ...this.hosted, hostId: this.identity.deviceId, hostName: this.identity.displayName, lastSeen: Date.now() }] : [];
    return [...own, ...[...this.invites.values()].sort((a, b) => b.startedAt - a.startedAt)];
  }

  get hostedInvite(): OpenInviteInfo | null {
    return this.hosted;
  }

  isHostOf(callId: string | undefined): boolean {
    return !!callId && this.hosted?.inviteId === callId;
  }

  /** Initiator: open an invite and join its call right away. */
  async startInvite(title: string, media: MediaKind, audience: { mode: AudienceMode; ids?: string[] }): Promise<void> {
    if (this.hosted) return this.join(this.hosted.inviteId);
    const info: OpenInviteInfo = {
      inviteId: uuid(),
      title: title.trim() || `${this.identity.displayName}'s invite`,
      media,
      audienceMode: audience.mode,
      allowedIds: audience.mode === 'selected' ? [...new Set(audience.ids ?? [])].filter((id) => id !== this.identity.deviceId) : undefined,
      startedAt: Date.now(),
    };
    this.hosted = info;
    this.persist();
    log.info(`Invite opened: "${info.title}" (${info.audienceMode === 'everyone' ? 'everyone' : `${info.allowedIds!.length} people`})`);
    this.announce(false);
    this.emit();
    await this.join(info.inviteId);
  }

  /** Initiator: close the invite – the call ends for everyone. */
  endInvite(): void {
    const h = this.hosted;
    if (!h) return;
    this.hosted = null;
    storage.remove(HOSTED_KEY, 'session');
    this.signaling.broadcast(this.lobby(), 'invite-stopped', { inviteId: h.inviteId }, { callId: h.inviteId });
    log.info(`Invite ended: "${h.title}"`);
    const c = this.calls.state;
    if (c?.callId === h.inviteId && !isTerminal(c.status)) this.calls.terminate('You ended the invite');
    this.emit();
  }

  /** Join / rejoin an invite's call. */
  async join(inviteId: string): Promise<void> {
    const inv = this.list().find((i) => i.inviteId === inviteId);
    if (!inv || !this.canJoin(inv)) return;
    await this.calls.joinInvite({ callId: inv.inviteId, hostId: inv.hostId, title: inv.title, media: inv.media, allowIds: this.accessOf(inv) ?? undefined });
  }

  /** In this invite's call right now. */
  isIn(inviteId: string): boolean {
    const c = this.calls.state;
    return !!c && c.callId === inviteId && !isTerminal(c.status);
  }

  canJoin(inv: OpenInviteInfo & { hostId: string }): boolean {
    const me = this.identity.deviceId;
    return inv.hostId === me || inv.audienceMode === 'everyone' || (inv.allowedIds ?? []).includes(me);
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Allow-list for the call: null = everyone in the room. */
  private accessOf(inv: OpenInviteInfo & { hostId: string }): string[] | null {
    return inv.audienceMode === 'everyone' ? null : [inv.hostId, ...(inv.allowedIds ?? [])];
  }

  private onMessage(msg: SignalingMessage): void {
    if (msg.messageType === 'invite-started') {
      const p = msg.payload;
      if (!p || typeof p.inviteId !== 'string' || msg.senderId === this.identity.deviceId) return;
      const known = this.invites.get(p.inviteId);
      if (known && known.hostId !== msg.senderId) return; // only the initiator may update it
      const inv: OpenInvite = {
        inviteId: p.inviteId,
        title: String(p.title ?? '').slice(0, 80) || `${msg.senderName}'s invite`,
        media: p.media === 'audio' ? 'audio' : 'video',
        audienceMode: p.audienceMode === 'selected' ? 'selected' : 'everyone',
        allowedIds: Array.isArray(p.allowedIds) ? p.allowedIds.filter((x): x is string => typeof x === 'string') : undefined,
        startedAt: typeof p.startedAt === 'number' ? p.startedAt : Date.now(),
        hostId: msg.senderId,
        hostName: msg.senderName,
        lastSeen: Date.now(),
      };
      if (!this.canJoin(inv)) {
        // Not (or no longer) invited: never listed; leave its call if we are in it.
        if (this.invites.delete(inv.inviteId)) this.emit();
        if (this.isIn(inv.inviteId)) this.calls.terminate('You are no longer invited');
        return;
      }
      this.invites.set(inv.inviteId, inv);
      // Keep a running call's access list in sync (e.g. after our own reload/rejoin).
      if (this.isIn(inv.inviteId)) this.calls.session?.setAccess(this.accessOf(inv));
      this.emit();
      if (!known) {
        log.info(`${msg.senderName} invited you to "${inv.title}"`);
        this.events.emit('new', inv);
      }
      return;
    }
    if (msg.messageType === 'invite-stopped') {
      const id = msg.payload?.inviteId;
      const known = this.invites.get(id);
      if (!known || known.hostId !== msg.senderId) return;
      this.invites.delete(id);
      log.info(`${msg.senderName} ended the invite "${known.title}"`);
      if (this.isIn(id)) this.calls.terminate(`${msg.senderName} ended the invite`);
      this.emit();
    }
  }

  private onCallState(s: CallState | null): void {
    const prev = this.lastCall;
    this.lastCall = s && !isTerminal(s.status) ? s : null;
    // The initiator left the call but the invite stays open → remind them it is still running.
    if (prev && this.hosted?.inviteId === prev.callId && !this.lastCall) {
      const own = this.list()[0];
      if (own) this.events.emit('hostLeft', own);
    }
    if (!!prev !== !!this.lastCall) this.emit();
  }

  private announce(heartbeat: boolean): void {
    const h = this.hosted;
    if (!h || !this.signaling.currentRoom) return;
    this.signaling.broadcast(this.lobby(), 'invite-started', { ...h, heartbeat }, { callId: h.inviteId });
  }

  private expire(): void {
    let changed = false;
    for (const [id, inv] of this.invites) {
      if (Date.now() - inv.lastSeen < EXPIRE_MS) continue;
      this.invites.delete(id);
      changed = true;
      // Initiator vanished (closed the app): the call itself continues until people leave.
      log.info(`Invite "${inv.title}" expired (initiator stopped announcing)`);
    }
    if (changed) this.emit();
  }

  private persist(): void {
    const room = this.signaling.currentRoom;
    if (this.hosted && room) storage.set(HOSTED_KEY, { roomId: room.roomId, info: this.hosted }, 'session');
  }

  private lobby(): string {
    return lobbyRoom(this.signaling.currentRoom?.roomKey ?? '');
  }

  private emit(): void {
    this.events.emit('change', this.list());
  }
}
