import { Emitter } from '../core/emitter';
import { storage } from '../core/storage';

export const MAX_ROOM_NAME_LENGTH = 64;
const RECENT_KEY = 'voip.recentRooms';
const MAX_RECENT = 5;
/** The room to reopen on the next launch (cleared only by an explicit "Leave room"). */
const ACTIVE_KEY = 'voip.activeRoom';

/** Room scope carried by the app. The deviceId (not the room) remains the user identity. */
export interface RoomContext {
  /** Normalised identifier used in every signaling message (case/whitespace-insensitive). */
  roomId: string;
  /** Display name exactly as the user typed it (trimmed, whitespace collapsed). */
  roomName: string;
  /** Short ASCII hash of roomId – safe to embed in ScaleDrone room names. */
  roomKey: string;
}

export type RoomValidation = { ok: true; room: RoomContext } | { ok: false; error: string };

/** Letters (any script), digits, spaces and - _ . ' */
const ALLOWED = /^[\p{L}\p{N} _.'-]+$/u;

/**
 * Normalise + validate a room name.
 *   "  Engineering   Team " → name "Engineering Team", roomId "engineering-team"
 * Characters that could confuse signaling/room naming are rejected; the ScaleDrone room
 * names use a hash (roomKey) so any allowed Unicode name maps to a safe ASCII key.
 */
export function validateRoomName(raw: string): RoomValidation {
  const roomName = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!roomName) return { ok: false, error: 'Enter a room name' };
  if (roomName.length > MAX_ROOM_NAME_LENGTH) return { ok: false, error: `Room names can be at most ${MAX_ROOM_NAME_LENGTH} characters` };
  if (!ALLOWED.test(roomName)) return { ok: false, error: "Use letters, numbers, spaces and - _ . ' only" };
  const roomId = roomName
    .toLocaleLowerCase('en-US')
    .replace(/[\s_.']+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!roomId) return { ok: false, error: 'Room name must contain a letter or number' };
  return { ok: true, room: { roomId, roomName, roomKey: roomKey(roomId) } };
}

/** 64-bit FNV-1a (two 32-bit lanes) → 16 hex chars. Collisions are also guarded by roomId checks. */
export function roomKey(roomId: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x9e3779b9;
  for (const ch of roomId) {
    const c = ch.codePointAt(0)!;
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000197) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Holds the current room (state only – joining/leaving is orchestrated in app.ts). */
export class RoomService {
  readonly events = new Emitter<{ change: RoomContext | null }>();
  private _current: RoomContext | null = null;

  get current(): RoomContext | null {
    return this._current;
  }

  set(room: RoomContext | null): void {
    this._current = room;
    if (room) {
      const recent = [room.roomName, ...this.recent().filter((r) => validateRoomName(r).ok && (validateRoomName(r) as { room: RoomContext }).room.roomId !== room.roomId)];
      storage.set(RECENT_KEY, recent.slice(0, MAX_RECENT));
    }
    this.events.emit('change', room);
  }

  /** Remember the room that is active now, so the next launch reopens it. */
  saveActive(room: RoomContext): void {
    storage.set(ACTIVE_KEY, room.roomName);
  }

  /** The user explicitly left: the next launch asks which room to join. */
  clearActive(): void {
    storage.remove(ACTIVE_KEY);
  }

  /** Room to reopen on launch, if one was active when the app was closed (validated again). */
  savedActive(): RoomContext | null {
    const name = storage.get<unknown>(ACTIVE_KEY, null);
    if (typeof name !== 'string') return null;
    const v = validateRoomName(name);
    return v.ok ? v.room : null;
  }

  /** Recently used room names – offered as shortcuts. */
  recent(): string[] {
    const list = storage.get<unknown>(RECENT_KEY, []);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [];
  }
}
