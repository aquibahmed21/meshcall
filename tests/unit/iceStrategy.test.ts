import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CandidateGate, candidateKey, classifyPath, isPrivateAddress, parseCandidateType } from '../../src/webrtc/IceStrategy';

const cand = (type: string, n = 1) => ({
  candidate: `candidate:${n} 1 udp 2122260223 192.168.1.${n} 5000${n} typ ${type} generation 0`,
  sdpMid: '0',
  sdpMLineIndex: 0,
  usernameFragment: 'abcd',
});

describe('candidate parsing', () => {
  it('parses candidate types', () => {
    expect(parseCandidateType(cand('host').candidate)).toBe('host');
    expect(parseCandidateType(cand('srflx').candidate)).toBe('srflx');
    expect(parseCandidateType(cand('relay').candidate)).toBe('relay');
    expect(parseCandidateType('garbage')).toBeNull();
  });
  it('dedupe key includes ufrag so restarts are distinct', () => {
    expect(candidateKey(cand('host'))).not.toBe(candidateKey({ ...cand('host'), usernameFragment: 'zzzz' }));
  });
  it('detects private addresses', () => {
    expect(isPrivateAddress('192.168.0.3')).toBe(true);
    expect(isPrivateAddress('abc.local')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});

describe('classifyPath – from selected candidate pair', () => {
  it('host → host is direct P2P', () => {
    const p = classifyPath({ candidateType: 'host', protocol: 'udp' }, { candidateType: 'host' });
    expect(p.connectionType).toBe('P2P');
    expect(p.pairLabel).toBe('host → host');
  });
  it('srflx involvement is STUN (still direct media)', () => {
    expect(classifyPath({ candidateType: 'host', address: '10.0.0.2' }, { candidateType: 'srflx', address: '81.2.3.4' }).connectionType).toBe('STUN');
    expect(classifyPath({ candidateType: 'srflx' }, { candidateType: 'srflx' }).path).toBe('direct-stun');
  });
  it('any relay side is TURN', () => {
    const p = classifyPath({ candidateType: 'relay', protocol: 'udp', relayProtocol: 'udp' }, { candidateType: 'srflx' });
    expect(p.connectionType).toBe('TURN');
    expect(p.relayProtocol).toBe('UDP');
    expect(classifyPath({ candidateType: 'host' }, { candidateType: 'relay' }).connectionType).toBe('TURN');
  });
  it('prflx between private addresses is a LAN path', () => {
    expect(classifyPath({ candidateType: 'host', address: '192.168.1.2' }, { candidateType: 'prflx', address: '192.168.1.3' }).connectionType).toBe('P2P');
  });
});

describe('CandidateGate – P2P window', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (opts: Partial<{ mode: 'gated' | 'native'; srflxDelayMs: number; relayDelayMs: number }> = {}) => {
    const sent: string[] = [];
    const releases: string[] = [];
    const gate = new CandidateGate(
      { mode: 'gated', srflxDelayMs: 0, relayDelayMs: 3000, ...opts },
      (c) => sent.push(parseCandidateType(c.candidate)!),
      (r) => releases.push(r),
    );
    gate.arm();
    return { gate, sent, releases };
  };

  it('sends host/srflx immediately and holds relay for the window', () => {
    const { gate, sent } = make();
    gate.offer(cand('host'));
    gate.offer(cand('srflx', 2));
    gate.offer(cand('relay', 3));
    expect(sent).toEqual(['host', 'srflx']);
    vi.advanceTimersByTime(2999);
    expect(sent).toEqual(['host', 'srflx']);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(['host', 'srflx', 'relay']);
    expect(gate.state).toBe('released-timeout');
  });

  it('releases relay as standby as soon as direct connectivity is up', () => {
    const { gate, sent, releases } = make();
    gate.offer(cand('relay'));
    gate.release('connected');
    expect(sent).toEqual(['relay']);
    expect(releases).toEqual(['connected']);
    gate.offer(cand('relay', 4));
    expect(sent).toEqual(['relay', 'relay']);
  });

  it('releases immediately when relay is the only candidate type', () => {
    const { gate, sent } = make();
    gate.offer(cand('relay'));
    gate.gatheringComplete();
    expect(sent).toEqual(['relay']);
    expect(gate.state).toBe('released-gathering');
  });

  it('re-arming (ICE restart / rejoin) drops stale held candidates and restarts the window', () => {
    const { gate, sent } = make();
    gate.offer(cand('relay'));
    gate.release('timeout');
    gate.arm();
    expect(gate.state).toBe('holding');
    gate.offer(cand('relay', 5));
    expect(sent).toEqual(['relay']);
    vi.advanceTimersByTime(3000);
    expect(sent).toEqual(['relay', 'relay']);
  });

  it('optional host-only window delays srflx', () => {
    const { gate, sent } = make({ srflxDelayMs: 500 });
    gate.offer(cand('srflx'));
    gate.offer(cand('host', 2));
    expect(sent).toEqual(['host']);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(['host', 'srflx']);
  });

  it('native mode never holds anything', () => {
    const { gate, sent } = make({ mode: 'native' });
    gate.offer(cand('relay'));
    expect(sent).toEqual(['relay']);
  });
});
