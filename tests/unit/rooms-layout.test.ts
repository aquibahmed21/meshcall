import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ROOM_NAME_LENGTH, roomKey, validateRoomName } from '../../src/services/RoomService';
import { isSignalingMessage } from '../../src/types/signaling';
import { SpeakerSelector } from '../../src/webrtc/ActiveSpeaker';

// CallLayoutManager persists the preference – give it a storage.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
});

describe('room names', () => {
  it('trims, collapses whitespace and normalises the id', () => {
    const r = validateRoomName('  Engineering    Team ');
    expect(r.ok && r.room.roomName).toBe('Engineering Team');
    expect(r.ok && r.room.roomId).toBe('engineering-team');
  });

  it('treats case/spacing variants as the same room, different names as different rooms', () => {
    const a = validateRoomName('Engineering Team');
    const b = validateRoomName('engineering   team');
    const c = validateRoomName('Engineering Team 2');
    expect(a.ok && b.ok && a.room.roomKey === b.room.roomKey).toBe(true);
    expect(a.ok && c.ok && a.room.roomKey !== c.room.roomKey).toBe(true);
  });

  it('rejects empty, too long and unsafe names', () => {
    expect(validateRoomName('   ').ok).toBe(false);
    expect(validateRoomName('x'.repeat(MAX_ROOM_NAME_LENGTH + 1)).ok).toBe(false);
    expect(validateRoomName('a/b').ok).toBe(false);
    expect(validateRoomName('room<script>').ok).toBe(false);
    expect(validateRoomName('---').ok).toBe(false);
  });

  it('accepts unicode letters and yields an ASCII-safe key', () => {
    const r = validateRoomName('Café Zürich');
    expect(r.ok).toBe(true);
    expect(r.ok && /^[0-9a-f]{16}$/.test(r.room.roomKey)).toBe(true);
    expect(roomKey('a')).not.toBe(roomKey('b'));
  });

  it('protocol v2 requires a roomId on every message', () => {
    const base = { v: 2, messageType: 'presence-heartbeat', messageId: 'm', timestamp: 1, senderId: 'a', senderSessionId: 's', senderName: 'A', receiverId: '*', peerId: 'p', callId: null, payload: {} };
    expect(isSignalingMessage(base)).toBe(false);
    expect(isSignalingMessage({ ...base, roomId: 'eng' })).toBe(true);
    expect(isSignalingMessage({ ...base, v: 1, roomId: 'eng' })).toBe(false); // old clients are ignored
  });
});

describe('CallLayoutManager', async () => {
  const { CallLayoutManager } = await import('../../src/ui/layout/CallLayoutManager');
  const tile = (id: string, extra: Partial<{ local: boolean; hasVideo: boolean; screen: boolean }> = {}) => ({ id, local: false, hasVideo: true, screen: false, ...extra });
  const me = tile('me', { local: true });

  it('1 participant → full-size grid whatever the layout', () => {
    const m = new CallLayoutManager();
    m.setLayout('sidebar');
    expect(m.plan([me])).toMatchObject({ layout: 'grid', main: ['me'], strip: [] });
  });

  it('grid keeps everyone in the main area (remotes first, you last)', () => {
    const m = new CallLayoutManager();
    expect(m.plan([tile('a'), me, tile('b')])).toMatchObject({ layout: 'grid', main: ['a', 'me', 'b'], strip: [] });
  });

  it.each(['speaker', 'spotlight', 'sidebar', 'filmstrip'] as const)('%s: one main tile, the rest in the strip (5+ participants)', (layout) => {
    const m = new CallLayoutManager();
    m.setLayout(layout);
    const p = m.plan([tile('a'), tile('b'), tile('c'), tile('d'), me]);
    expect(p.layout).toBe(layout);
    expect(p.main).toEqual(['a']);
    expect(p.strip).toEqual(['b', 'c', 'd', 'me']);
  });

  it('speaker layout follows the active speaker; a pin overrides it', () => {
    const m = new CallLayoutManager();
    m.setLayout('speaker');
    m.setActiveSpeaker('c');
    expect(m.plan([tile('a'), tile('b'), tile('c'), me]).mainId).toBe('c');
    m.togglePin('b');
    expect(m.plan([tile('a'), tile('b'), tile('c'), me])).toMatchObject({ mainId: 'b', reason: 'pinned' });
    m.togglePin('b'); // click again → unpin
    expect(m.plan([tile('a'), tile('b'), tile('c'), me]).mainId).toBe('c');
  });

  it('screen share wins over plain video in focus layouts; pinned participant leaving → automatic', () => {
    const m = new CallLayoutManager();
    m.setLayout('filmstrip');
    expect(m.plan([tile('a'), tile('b', { screen: true }), me]).mainId).toBe('b');
    m.pin('x');
    expect(m.plan([tile('a'), me]).mainId).toBe('a');
    expect(m.pinned).toBeNull();
  });

  it('2 participants: you can spotlight yourself', () => {
    const m = new CallLayoutManager();
    m.setLayout('spotlight');
    m.pin('me');
    expect(m.plan([tile('a'), me])).toMatchObject({ mainId: 'me', main: ['me'], strip: ['a'] });
  });

  it('persists the layout preference', () => {
    const a = new CallLayoutManager();
    a.setLayout('sidebar');
    expect(new CallLayoutManager().layout).toBe('sidebar');
  });
});

describe('SpeakerSelector hysteresis', () => {
  const levels = (o: Record<string, number>) => new Map(Object.entries(o));

  it('needs a sustained lead before switching and ignores silence', () => {
    const s = new SpeakerSelector({ holdMs: 900, minDwellMs: 2500 });
    let t = 0;
    for (; t <= 1000; t += 250) s.update(levels({ a: 0.4, b: 0.01 }), t);
    expect(s.active).toBe('a');
    for (let i = 0; i < 20; i++) s.update(levels({ a: 0, b: 0 }), (t += 250)); // silence
    expect(s.active).toBe('a');
  });

  it('does not flicker on a short burst from someone else', () => {
    const s = new SpeakerSelector();
    let t = 0;
    for (; t <= 3000; t += 250) s.update(levels({ a: 0.3, b: 0 }), t);
    s.update(levels({ a: 0.3, b: 0.9 }), (t += 250)); // 250 ms cough
    for (let i = 0; i < 6; i++) s.update(levels({ a: 0.3, b: 0 }), (t += 250));
    expect(s.active).toBe('a');
  });

  it('switches to a clearly louder, sustained new speaker', () => {
    const s = new SpeakerSelector();
    let t = 0;
    for (; t <= 3000; t += 250) s.update(levels({ a: 0.3, b: 0 }), t);
    for (let i = 0; i < 12; i++) s.update(levels({ a: 0.02, b: 0.5 }), (t += 250));
    expect(s.active).toBe('b');
  });

  it('picks someone when several people talk equally loud (no current speaker yet)', () => {
    const s = new SpeakerSelector();
    let t = 0;
    for (let i = 0; i < 12; i++) {
      // the loudest id alternates every sample
      const lead = ['a', 'b', 'c', 'd'][i % 4]!;
      s.update(levels({ a: 0.2, b: 0.2, c: 0.2, d: 0.2, [lead]: 0.21 }), (t += 250));
    }
    expect(s.active).not.toBeNull();
  });

  it('forgets a speaker who left', () => {
    const s = new SpeakerSelector({ holdMs: 0 });
    s.update(levels({ a: 0.5 }), 0);
    s.update(levels({ a: 0.5 }), 250);
    expect(s.active).toBe('a');
    s.update(levels({ b: 0 }), 500);
    expect(s.active).toBeNull();
  });
});
