import { Emitter } from '../core/emitter';
import { storage } from '../core/storage';
import type { SignalingMessage } from '../types/signaling';
import type { IdentityService } from './IdentityService';
import type { RoomContext } from './RoomService';
import { lobbyRoom, type SignalingService } from './SignalingService';

const KEY = 'voip.linkedDevices.v1';
const CODE_TTL_MS = 2 * 60_000;

export interface LinkedDevice {
  deviceId: string;
  name: string;
}

/**
 * "My devices": pair two of your own devices with a one-time code. Linked devices may hand a
 * running call over to each other (CallManager checks `isLinked` before obeying a hand-off).
 * Pairing happens in the shared room's lobby: device A shows a code, device B enters it.
 */
export class DeviceLinkService {
  readonly events = new Emitter<{ change: void; code: string | null }>();
  private linked: LinkedDevice[] = storage.get<LinkedDevice[]>(KEY, []).filter((d) => d && typeof d.deviceId === 'string');
  private room: RoomContext | null = null;
  private code: { value: string; expires: number } | null = null;
  private off: (() => void) | null = null;
  private pending: ((name: string | null) => void) | null = null;

  constructor(
    private readonly signaling: SignalingService,
    private readonly identity: IdentityService,
  ) {}

  start(room: RoomContext): void {
    this.room = room;
    this.off?.();
    this.off = this.signaling.events.on('message', ({ msg }) => this.onMessage(msg));
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.room = null;
    this.code = null;
  }

  list(): LinkedDevice[] {
    return [...this.linked];
  }

  isLinked(deviceId: string): boolean {
    return this.linked.some((d) => d.deviceId === deviceId);
  }

  unlink(deviceId: string): void {
    this.linked = this.linked.filter((d) => d.deviceId !== deviceId);
    this.save();
  }

  /** This device shows a code; the other device types it. */
  showCode(): string {
    const value = String(Math.floor(100000 + Math.random() * 900000));
    this.code = { value, expires: Date.now() + CODE_TTL_MS };
    setTimeout(() => {
      if (this.code?.value === value) this.cancelCode();
    }, CODE_TTL_MS);
    this.events.emit('code', value);
    return value;
  }

  cancelCode(): void {
    this.code = null;
    this.events.emit('code', null);
  }

  /** Type the code shown on the other device. Resolves with its name, or null (wrong/expired/no answer). */
  pair(code: string): Promise<string | null> {
    if (!this.room || !this.signaling.isConnected) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => ((this.pending = null), resolve(null)), 8000);
      this.pending = (name) => {
        clearTimeout(timer);
        this.pending = null;
        resolve(name);
      };
      this.signaling.broadcast(lobbyRoom(this.room!.roomKey), 'device-link-request', { code: code.trim() });
    });
  }

  private onMessage(msg: SignalingMessage): void {
    if (msg.senderId === this.identity.deviceId) return;
    if (msg.messageType === 'device-link-request') {
      const c = this.code;
      if (!c || Date.now() > c.expires || msg.payload.code !== c.value) return;
      this.cancelCode(); // one use
      this.add({ deviceId: msg.senderId, name: msg.senderName });
      this.signaling.send(msg.senderId, 'device-link-accept', { name: this.identity.displayName }, {});
    } else if (msg.messageType === 'device-link-accept' && this.pending) {
      this.add({ deviceId: msg.senderId, name: msg.senderName });
      this.pending(msg.senderName);
    }
  }

  private add(d: LinkedDevice): void {
    if (!this.isLinked(d.deviceId)) this.linked.push(d);
    this.save();
  }

  private save(): void {
    storage.set(KEY, this.linked);
    this.events.emit('change', undefined);
  }
}
