import { describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import { CallHistoryService, callOutcome } from '../../src/services/CallHistoryService';

describe('call outcome', () => {
  it.each([
    [{ direction: 'outgoing', status: 'ended', statusDetail: 'Call ended', connectedAt: 5 }, 'answered'],
    [{ direction: 'incoming', status: 'ended', statusDetail: 'Missed call from Bob' }, 'missed'],
    [{ direction: 'incoming', status: 'ended', statusDetail: 'Declined' }, 'declined'],
    [{ direction: 'incoming', status: 'ended', statusDetail: 'Answered on another device' }, 'elsewhere'],
    [{ direction: 'outgoing', status: 'rejected', statusDetail: 'Bob declined the call' }, 'declined'],
    [{ direction: 'outgoing', status: 'busy', statusDetail: 'Bob is busy' }, 'busy'],
    [{ direction: 'outgoing', status: 'ended', statusDetail: 'No answer' }, 'no-answer'],
    [{ direction: 'outgoing', status: 'ended', statusDetail: 'Cancelled' }, 'cancelled'],
    [{ direction: 'outgoing', status: 'failed', statusDetail: 'Bob appears to be offline' }, 'failed'],
  ] as const)('%o → %s', (c, out) => expect(callOutcome(c as never)).toBe(out));
});

describe('CallHistoryService', () => {
  it('records each finished call once (with everyone who took part), newest first, per room', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    const events = new Emitter<{ state: unknown }>();
    const h = new CallHistoryService({ events } as never, { deviceId: 'me' } as never);
    h.start({ roomId: 'eng', roomName: 'Eng', roomKey: 'k' });
    const call = (status: string, extra: Record<string, unknown> = {}) => ({
      callId: 'c1', kind: 'group', direction: 'outgoing', media: 'video', status, title: 'Team', startedAt: 100,
      participants: new Map([['bob', { deviceId: 'bob', name: 'Bob' }]]), ...extra,
    });
    events.emit('state', call('connected', { connectedAt: 200 }));
    events.emit('state', call('connected', { connectedAt: 200, participants: new Map([['carol', { deviceId: 'carol', name: 'Carol' }]]) })); // Bob left
    events.emit('state', call('ended', { connectedAt: 200, endedAt: 1200, participants: new Map() }));
    events.emit('state', call('ended', { connectedAt: 200, endedAt: 1200, participants: new Map() })); // duplicate
    expect(h.list()).toHaveLength(1);
    expect(h.list()[0]).toMatchObject({ kind: 'group', outcome: 'answered', durationMs: 1000, title: 'Team', peers: [{ deviceId: 'bob' }, { deviceId: 'carol' }] });
    events.emit('state', { ...call('ended', { statusDetail: 'Missed call from Dan' }), callId: 'c2', kind: 'direct', direction: 'incoming', remoteUser: { deviceId: 'dan', name: 'Dan' }, participants: new Map() });
    expect(h.list().map((e) => e.outcome)).toEqual(['missed', 'answered']);
    events.emit('state', { ...call('ended'), callId: 'live1', kind: 'live' });
    expect(h.list()).toHaveLength(2); // live streams are not calls
    h.stop();
    h.start({ roomId: 'other', roomName: 'Other', roomKey: 'k2' });
    expect(h.list()).toHaveLength(0);
    h.start({ roomId: 'eng', roomName: 'Eng', roomKey: 'k' });
    expect(h.list()).toHaveLength(2);
    vi.unstubAllGlobals();
  });
});
