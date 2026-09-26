import { describe, expect, it } from 'vitest';
import { canTransition } from '../../src/calls/CallStateMachine';
import { BoundedSet, SerialQueue } from '../../src/core/async';
import { redact } from '../../src/core/logger';
import { isSignalingMessage } from '../../src/types/signaling';
import { AdaptiveLadder } from '../../src/webrtc/AdaptiveLadder';
import { isPolite } from '../../src/webrtc/PeerConnectionManager';

describe('AdaptiveLadder hysteresis', () => {
  const levels = [150e3, 500e3, 900e3, 1600e3];

  it('steps down only after consecutive bad samples', () => {
    const l = new AdaptiveLadder({ levels, start: 3 }, 0);
    expect(l.update('poor', undefined, 1000)).toBeNull();
    expect(l.update('poor', undefined, 2000)).toBe(2);
  });

  it('critical drops two levels', () => {
    const l = new AdaptiveLadder({ levels, start: 3 }, 0);
    l.update('critical', undefined, 1000);
    expect(l.update('critical', undefined, 2000)).toBe(1);
  });

  it('steps up slowly, only with bandwidth headroom', () => {
    const l = new AdaptiveLadder({ levels, start: 1 }, 0);
    for (let t = 1; t <= 4; t++) expect(l.update('excellent', 5e6, t * 2000)).toBeNull();
    expect(l.update('excellent', 5e6, 10_000)).toBe(2);
    const l2 = new AdaptiveLadder({ levels, start: 1 }, 0);
    for (let t = 1; t <= 10; t++) expect(l2.update('excellent', 600e3, t * 2000)).toBeNull(); // no headroom for 900k
  });

  it('does not oscillate: quick up→down doubles the up-cooldown', () => {
    const l = new AdaptiveLadder({ levels, start: 1 }, 0);
    let t = 0;
    for (let i = 0; i < 5; i++) l.update('excellent', 5e6, (t += 2000));
    expect(l.level).toBe(2);
    l.update('poor', undefined, (t += 2000));
    l.update('poor', undefined, (t += 2000));
    expect(l.level).toBe(1);
    // 5 good samples after 10 s would have been enough before; now the cooldown is 20 s.
    const changes: Array<number | null> = [];
    for (let i = 0; i < 5; i++) changes.push(l.update('excellent', 5e6, (t += 2000)));
    expect(changes.every((c) => c === null)).toBe(true);
  });
});

describe('call state machine', () => {
  it('allows the normal flows and rejects invalid ones', () => {
    expect(canTransition('idle', 'calling')).toBe(true);
    expect(canTransition('calling', 'ringing')).toBe(true);
    expect(canTransition('connected', 'reconnecting')).toBe(true);
    expect(canTransition('reconnecting', 'connected')).toBe(true);
    expect(canTransition('ended', 'connected')).toBe(false);
    expect(canTransition('idle', 'reconnecting')).toBe(false);
  });
});

describe('perfect negotiation roles', () => {
  it('exactly one side of a pair is polite', () => {
    expect(isPolite('a', 's1', 'b', 's2')).not.toBe(isPolite('b', 's2', 'a', 's1'));
    // same device in two tabs is still decided by session
    expect(isPolite('a', 's1', 'a', 's2')).not.toBe(isPolite('a', 's2', 'a', 's1'));
  });
});

describe('primitives', () => {
  it('BoundedSet de-duplicates and evicts', () => {
    const s = new BoundedSet<string>(2);
    expect(s.add('a')).toBe(true);
    expect(s.add('a')).toBe(false);
    s.add('b');
    s.add('c');
    expect(s.has('a')).toBe(false);
  });

  it('SerialQueue runs tasks in order even when one fails', async () => {
    const q = new SerialQueue();
    const out: number[] = [];
    void q.run(async () => {
      await new Promise((r) => setTimeout(r, 10));
      out.push(1);
    });
    void q.run(async () => {
      throw new Error('x');
    }).catch(() => undefined);
    await q.run(async () => out.push(3));
    expect(out).toEqual([1, 3]);
  });

  it('logger redacts credentials', () => {
    expect(redact({ urls: 'turn:x', username: 'u', credential: 'secret' })).toEqual({ urls: 'turn:x', username: 'u', credential: '[redacted]' });
  });

  it('validates wire messages', () => {
    expect(isSignalingMessage({ v: 1 })).toBe(false);
    expect(
      isSignalingMessage({
        v: 1, messageType: 'offer', messageId: 'm', timestamp: 1, senderId: 'a', senderSessionId: 's', senderName: 'A',
        receiverId: 'b', peerId: 'p', callId: 'c', payload: {},
      }),
    ).toBe(true);
  });
});
