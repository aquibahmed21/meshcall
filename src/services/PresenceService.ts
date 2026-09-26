import { Emitter } from '../core/emitter';
import { createLogger } from '../core/logger';
import { storage } from '../core/storage';
import type { AppConfig } from '../config';
import type { PresenceMessage, SignalingMessage } from '../types/signaling';
import type { PresenceStatus, UserPresence } from '../types/state';
import type { IdentityService } from './IdentityService';
import { LOBBY_ROOM, type Member, type SignalingService } from './SignalingService';

const log = createLogger('Presence');
const KNOWN_KEY = 'voip.knownUsers';
const MAX_KNOWN = 200;

interface UserRecord {
  deviceId: string;
  name: string;
  /** ScaleDrone clientIds currently present in the lobby for this device. */
  clients: Map<string, string>; // clientId → sessionId
  lastHeartbeat: number;
  lastSeen: number;
  /** When the last client left (grace period start). */
  leftAt: number | null;
  explicitLeaveSessions: Set<string>;
  busy: boolean;
  pushEnabled: boolean;
}

/**
 * Presence built on the ScaleDrone observable lobby room:
 *  - member list / join / leave → authoritative "connected to signaling" signal
 *  - periodic heartbeats → names, busy flag, liveness when member events are missed
 *  - leave grace period → a reload/network blip does not flash "Offline"
 *  - when OUR signaling is down every other user becomes "unknown" (we cannot know)
 */
export class PresenceService {
  readonly events = new Emitter<{ change: void }>();
  private users = new Map<string, UserRecord>();
  private busy = false;
  private pushEnabled = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private offSignal: Array<() => void> = [];
  private readonly onPageHide = () => this.sendLeave();
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.sendHeartbeat();
  };

  constructor(
    private readonly signaling: SignalingService,
    private readonly identity: IdentityService,
    private readonly config: AppConfig,
  ) {
    for (const k of storage.get<Array<{ deviceId: string; name: string; lastSeen: number }>>(KNOWN_KEY, [])) {
      if (k.deviceId && k.deviceId !== identity.deviceId) this.users.set(k.deviceId, this.blank(k.deviceId, k.name, k.lastSeen));
    }
  }

  start(): void {
    this.unsubscribe = this.signaling.subscribe(LOBBY_ROOM, {
      onOpen: () => this.sendHeartbeat(),
      onMembers: (ms) => this.onMembers(ms),
      onMemberJoin: (m) => this.onMemberJoin(m),
      onMemberLeave: (m) => this.onMemberLeave(m),
    });
    this.offSignal.push(
      this.signaling.events.on('message', ({ msg }) => this.onMessage(msg)),
      this.signaling.events.on('status', () => this.events.emit('change', undefined)),
      this.signaling.events.on('reconnected', () => this.sendHeartbeat()),
    );
    this.heartbeat = setInterval(() => {
      this.sendHeartbeat();
      this.events.emit('change', undefined); // re-evaluate staleness
    }, this.config.presence.heartbeatMs);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisible);
  }

  stop(): void {
    this.sendLeave();
    this.unsubscribe?.();
    this.offSignal.forEach((f) => f());
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timers.forEach(clearTimeout);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.sendHeartbeat();
  }

  setPushEnabled(enabled: boolean): void {
    if (this.pushEnabled === enabled) return;
    this.pushEnabled = enabled;
    this.sendHeartbeat();
  }

  list(): UserPresence[] {
    const rank: Record<PresenceStatus, number> = { online: 0, connecting: 1, unknown: 2, offline: 3 };
    return [...this.users.values()]
      .map((u) => this.toPresence(u))
      .sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name));
  }

  get(deviceId: string): UserPresence | undefined {
    const u = this.users.get(deviceId);
    return u ? this.toPresence(u) : undefined;
  }

  status(deviceId: string): PresenceStatus {
    return this.get(deviceId)?.status ?? 'unknown';
  }

  nameOf(deviceId: string): string {
    return this.users.get(deviceId)?.name ?? 'Unknown';
  }

  /** Remember a user learned from another channel (e.g. an invite). */
  learn(deviceId: string, name: string): void {
    if (deviceId === this.identity.deviceId) return;
    const u = this.users.get(deviceId) ?? this.blank(deviceId, name, Date.now());
    if (name) u.name = name;
    this.users.set(deviceId, u);
    this.persist();
  }

  // ── status derivation ─────────────────────────────────────────────────────

  private toPresence(u: UserRecord): UserPresence {
    return {
      deviceId: u.deviceId,
      name: u.name || 'Unknown',
      status: this.deriveStatus(u),
      busy: u.busy && u.clients.size > 0,
      pushEnabled: u.pushEnabled,
      lastSeen: u.lastSeen,
    };
  }

  private deriveStatus(u: UserRecord): PresenceStatus {
    const sig = this.signaling.status;
    if (sig !== 'connected') {
      // We cannot observe anyone while our own signaling is down.
      return sig === 'connecting' || sig === 'loading' ? 'connecting' : 'unknown';
    }
    if (u.clients.size > 0) return 'online';
    const now = Date.now();
    if (u.leftAt !== null && now - u.leftAt < this.config.presence.offlineGraceMs) return 'online';
    if (u.leftAt === null && now - u.lastHeartbeat < this.config.presence.staleAfterMs) return 'online';
    return 'offline';
  }

  // ── lobby events ─────────────────────────────────────────────────────────

  private onMembers(members: Member[]): void {
    for (const u of this.users.values()) u.clients.clear();
    for (const m of members) this.addMember(m, false);
    // Anyone we thought was online but is absent now left while we were disconnected.
    for (const u of this.users.values()) if (u.clients.size === 0 && u.leftAt === null) u.leftAt = Date.now() - this.config.presence.offlineGraceMs;
    log.info(`${members.length} member(s) in lobby`);
    this.persist();
    this.events.emit('change', undefined);
  }

  private onMemberJoin(m: Member): void {
    this.addMember(m, true);
    this.persist();
    this.events.emit('change', undefined);
  }

  private addMember(m: Member, announce: boolean): void {
    const d = m.clientData;
    if (!d?.deviceId || d.deviceId === this.identity.deviceId) return;
    const u = this.users.get(d.deviceId) ?? this.blank(d.deviceId, d.name, Date.now());
    const wasOnline = u.clients.size > 0;
    u.clients.set(m.id, d.sessionId);
    if (d.name) u.name = d.name;
    u.lastSeen = Date.now();
    u.leftAt = null;
    this.users.set(d.deviceId, u);
    if (announce && !wasOnline) log.info(`${u.name} online`);
  }

  private onMemberLeave(m: Member): void {
    const deviceId = m.clientData?.deviceId;
    const u = deviceId ? this.users.get(deviceId) : [...this.users.values()].find((x) => x.clients.has(m.id));
    if (!u) return;
    const sessionId = u.clients.get(m.id);
    u.clients.delete(m.id);
    if (u.clients.size > 0) return;
    const explicit = sessionId !== undefined && u.explicitLeaveSessions.delete(sessionId);
    u.leftAt = explicit ? Date.now() - this.config.presence.offlineGraceMs : Date.now();
    u.busy = false;
    log.info(explicit ? `${u.name} offline` : `${u.name} left lobby – offline after grace period`);
    this.events.emit('change', undefined);
    if (!explicit) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.events.emit('change', undefined);
      }, this.config.presence.offlineGraceMs + 50);
      this.timers.add(t);
    }
  }

  private onMessage(msg: SignalingMessage): void {
    if (msg.messageType !== 'presence-heartbeat' && msg.messageType !== 'presence-leave') return;
    const p = msg as PresenceMessage;
    if (p.senderId === this.identity.deviceId) return;
    const u = this.users.get(p.senderId) ?? this.blank(p.senderId, p.senderName, Date.now());
    if (p.senderName) u.name = p.senderName;
    u.lastSeen = Date.now();
    u.pushEnabled = p.payload.pushEnabled;
    if (p.messageType === 'presence-heartbeat') {
      u.lastHeartbeat = Date.now();
      u.busy = p.payload.busy;
      if (u.clients.size === 0 && u.leftAt !== null) u.leftAt = null; // heard from them again
    } else {
      u.explicitLeaveSessions.add(p.senderSessionId);
      if (u.explicitLeaveSessions.size > 10) u.explicitLeaveSessions.clear();
    }
    this.users.set(p.senderId, u);
    this.events.emit('change', undefined);
  }

  private sendHeartbeat(): void {
    if (!this.identity.isRegistered) return;
    this.signaling.broadcast(LOBBY_ROOM, 'presence-heartbeat', { busy: this.busy, pushEnabled: this.pushEnabled });
  }

  private sendLeave(): void {
    if (this.signaling.isConnected) this.signaling.broadcast(LOBBY_ROOM, 'presence-leave', { busy: false, pushEnabled: this.pushEnabled });
  }

  private blank(deviceId: string, name: string, lastSeen: number): UserRecord {
    return {
      deviceId,
      name,
      clients: new Map(),
      lastHeartbeat: 0,
      lastSeen,
      leftAt: null,
      explicitLeaveSessions: new Set(),
      busy: false,
      pushEnabled: false,
    };
  }

  private persist(): void {
    const known = [...this.users.values()]
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, MAX_KNOWN)
      .map((u) => ({ deviceId: u.deviceId, name: u.name, lastSeen: u.lastSeen }));
    storage.set(KNOWN_KEY, known);
  }
}
