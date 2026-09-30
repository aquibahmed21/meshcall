import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import { classifyPath, gatheredKey, identifyServer } from '../../src/webrtc/IceStrategy';
import { explainIceErrors, listIceServers } from '../../src/webrtc/IceServerProbe';

describe('connection path from the selected pair', () => {
  it.each([
    ['host', 'host', 'p2p', 'host → host'],
    ['srflx', 'srflx', 'stun', 'srflx → srflx'],
    ['host', 'srflx', 'stun', 'host → srflx'],
    ['relay', 'srflx', 'turn', 'relay → srflx'],
    ['srflx', 'relay', 'turn', 'srflx → relay'],
    ['relay', 'relay', 'turn', 'relay → relay'],
  ] as const)('%s → %s = %s (actual pair shown, never hard-coded)', (l, r, path, pair) => {
    const p = classifyPath({ candidateType: l, address: '8.8.8.8' }, { candidateType: r, address: '1.1.1.1' });
    expect(p.connectionPath).toBe(path);
    expect(p.pairLabel).toBe(pair);
  });
  it('TURN is never reported as P2P, STUN never as TURN', () => {
    expect(classifyPath({ candidateType: 'relay', address: '10.0.0.1' }, { candidateType: 'host', address: '10.0.0.2' }).connectionPath).toBe('turn');
    expect(classifyPath({ candidateType: 'srflx', address: '8.8.8.8' }, { candidateType: 'host', address: '10.0.0.2' }).connectionPath).toBe('stun');
  });
});

describe('STUN/TURN server identification (never guessed)', () => {
  const path = (l: string, r: string, extra: Record<string, unknown> = {}) =>
    ({ ...classifyPath({ candidateType: l, address: '203.0.113.5', port: 50000, protocol: 'udp' }, { candidateType: r }), ...extra });
  const none = () => undefined;

  it('local relay: URL from getStats', () => {
    const s = identifyServer(path('relay', 'relay', { localUrl: 'turn:dev.aahlaad.in:3401' }), none);
    expect(s).toMatchObject({ role: 'turn', side: 'local', url: 'turn:dev.aahlaad.in:3401', source: 'stats' });
  });
  it('local relay: URL from the gathering event when stats lack it', () => {
    const key = gatheredKey('relay', '203.0.113.5', 50000, 'UDP');
    const s = identifyServer(path('relay', 'host'), (k) => (k === key ? 'turn:t.example:3478' : undefined));
    expect(s).toMatchObject({ url: 'turn:t.example:3478', source: 'gathering' });
  });
  it('local relay without any URL → unknown, not a guess', () => {
    const s = identifyServer(path('relay', 'host'), none);
    expect(s).toMatchObject({ role: 'turn', source: 'unknown' });
    expect(s.url).toBeUndefined();
  });
  it("peer's relay/srflx cannot be attributed from this side", () => {
    const t = identifyServer(path('host', 'relay'), none);
    const s = identifyServer(path('host', 'srflx'), none);
    expect(t).toMatchObject({ role: 'turn', side: 'remote' });
    expect(s).toMatchObject({ role: 'stun', side: 'remote' });
    expect(t.url ?? s.url).toBeUndefined();
  });
  it('local srflx: STUN server URL when reported', () => {
    expect(identifyServer(path('srflx', 'srflx', { localUrl: 'stun:stun.l.google.com:19302' }), none)).toMatchObject({ role: 'stun', side: 'local', url: 'stun:stun.l.google.com:19302' });
  });
  it('host/prflx pairs involve no server', () => {
    expect(identifyServer(path('host', 'host'), none).role).toBe('none');
    expect(identifyServer(path('prflx', 'host'), none).role).toBe('none');
  });
});

describe('ICE server test helpers', () => {
  it('lists one entry per URL and keeps credentials only in the server object', () => {
    const e = listIceServers([{ urls: ['stun:a:1', 'stun:b:2'] }, { urls: 'turn:t:3', username: 'u', credential: 'secret' }]);
    expect(e.map((x) => `${x.type} ${x.url}`)).toEqual(['stun stun:a:1', 'stun stun:b:2', 'turn turn:t:3']);
    expect(e[2]!.server).toMatchObject({ urls: 'turn:t:3', username: 'u' });
  });
  it('maps error codes to causes', () => {
    expect(explainIceErrors('turn', [401], false).error).toMatch(/credentials/);
    expect(explainIceErrors('turn', [701], false).causes).toContain('Server unreachable');
    expect(explainIceErrors('turn', [], true).error).toBe('No relay candidate was gathered.');
    expect(explainIceErrors('stun', [], true).error).toMatch(/No server-reflexive candidate/);
  });
});

describe('DirectMessageService delivery strategy', async () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const { DirectMessageService } = await import('../../src/services/DirectMessageService');

  function world(peerStatus: 'online' | 'offline' | 'unknown' = 'online') {
    const sigEvents = new Emitter<{ message: { msg: never; room: string }; status: string }>();
    const presEvents = new Emitter<{ change: void }>();
    const sent: Array<{ to: string; type: string; payload: unknown; opts: { messageId?: string } }> = [];
    const status = { john: peerStatus as string };
    const pushCalls: unknown[] = [];
    const signaling = { events: sigEvents, isConnected: true, send: (to: string, type: string, payload: unknown, opts = {}) => (sent.push({ to, type, payload, opts }), 'id') };
    const presence = { events: presEvents, status: (id: string) => (status as Record<string, string>)[id] ?? 'unknown', nameOf: () => 'John', learn: () => undefined };
    const push = { notifyChatMessage: async (...a: unknown[]) => (pushCalls.push(a), 'unsupported') };
    const dms = new DirectMessageService(signaling as never, { deviceId: 'me', displayName: 'Me' } as never, presence as never, push as never);
    dms.start({ roomId: 'eng', roomName: 'Eng', roomKey: 'k' });
    const incoming = (messageType: string, payload: unknown, senderId = 'john', messageId = 'm-1') =>
      sigEvents.emit('message', { room: 'r', msg: { messageType, messageId, senderId, senderSessionId: 's', senderName: 'John', timestamp: 1, payload } as never });
    return { dms, sent, status, pushCalls, presEvents, incoming };
  }

  it('online recipient → ScaleDrone; ack → Delivered; no push', async () => {
    const w = world('online');
    expect(w.dms.send('john', ' Hello John ')).toBe('ok');
    await Promise.resolve();
    const out = w.sent.find((x) => x.type === 'direct-message')!;
    expect(out).toMatchObject({ to: 'john', payload: { text: 'Hello John' } });
    expect(w.dms.conversation('john').messages[0]!.status).toBe('sent');
    w.incoming('direct-message-ack', { messageId: out.opts.messageId }, 'john', 'ack-1');
    expect(w.dms.conversation('john').messages[0]!.status).toBe('delivered');
    expect(w.pushCalls).toHaveLength(0);
  });

  it('no ack within the timeout → never Delivered; bounded re-sends with the same messageId', async () => {
    const w = world('online');
    w.dms.send('john', 'hi');
    await vi.advanceTimersByTimeAsync(16_000);
    expect(w.dms.conversation('john').messages[0]!.status).toBe('sent'); // re-sent, awaiting ack
    await vi.advanceTimersByTimeAsync(5 * 16_000);
    const sends = w.sent.filter((x) => x.type === 'direct-message');
    expect(sends).toHaveLength(4); // original + 3 re-sends, then it waits
    expect(new Set(sends.map((x) => x.opts.messageId)).size).toBe(1);
    expect(w.dms.conversation('john').messages[0]!.status).toBe('queued');
  });

  it('an ack from someone else cannot mark a message delivered', async () => {
    const w = world('online');
    w.dms.send('john', 'hi');
    const id = w.sent.find((x) => x.type === 'direct-message')!.opts.messageId;
    w.incoming('direct-message-ack', { messageId: id }, 'mallory', 'ack-x');
    expect(w.dms.conversation('john').messages[0]!.status).toBe('sent');
  });

  it.each(['offline', 'unknown'] as const)('%s recipient → targeted push attempt (never ScaleDrone/notifyAll) → queued', async (st) => {
    const w = world(st);
    w.dms.send('john', 'Hello');
    await Promise.resolve();
    await Promise.resolve();
    expect(w.pushCalls).toHaveLength(1);
    expect((w.pushCalls[0] as unknown[])[0]).toBe('john');
    expect(w.sent.filter((x) => x.type === 'direct-message')).toHaveLength(0);
    const m = w.dms.conversation('john').messages[0]!;
    expect(m.status).toBe('queued');
    expect(m.statusDetail).toMatch(/cannot notify one specific person/);
  });

  it('queued message is delivered (same messageId) when the recipient comes online', async () => {
    const w = world('offline');
    w.dms.send('john', 'Hello');
    await Promise.resolve();
    await Promise.resolve();
    const id = w.dms.conversation('john').messages[0]!.messageId;
    w.status.john = 'online';
    w.presEvents.emit('change', undefined);
    await Promise.resolve();
    const out = w.sent.filter((x) => x.type === 'direct-message');
    expect(out).toHaveLength(1);
    expect(out[0]!.opts.messageId).toBe(id);
  });

  it('receiving: acks every copy, shows it once, counts unread unless the conversation is open', () => {
    const w = world('online');
    w.incoming('direct-message', { text: 'Hi', sentAt: 5 });
    w.incoming('direct-message', { text: 'Hi', sentAt: 5 }); // retry of the same message
    expect(w.dms.conversation('john').messages).toHaveLength(1);
    expect(w.sent.filter((x) => x.type === 'direct-message-ack')).toHaveLength(2);
    expect(w.dms.unreadFor('john')).toBe(1);
    w.dms.setActive('john');
    expect(w.dms.unreadFor('john')).toBe(0);
    w.incoming('direct-message', { text: 'again', sentAt: 6 }, 'john', 'm-2');
    expect(w.dms.unreadFor('john')).toBe(0);
  });

  it('conversations are isolated per room', () => {
    const w = world('online');
    w.incoming('direct-message', { text: 'in eng', sentAt: 1 });
    w.dms.stop();
    w.dms.start({ roomId: 'other', roomName: 'Other', roomKey: 'k2' });
    expect(w.dms.conversation('john').messages).toHaveLength(0);
    w.dms.stop();
    w.dms.start({ roomId: 'eng', roomName: 'Eng', roomKey: 'k' });
    expect(w.dms.conversation('john').messages.map((m) => m.text)).toEqual(['in eng']);
  });
});
