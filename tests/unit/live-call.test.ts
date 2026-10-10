import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../../src/core/emitter';
import { LiveStreamManager } from '../../src/calls/LiveStreamManager';

const RING_MS = 45_000;

function world(mode: 'everyone' | 'selected' = 'everyone', presenceOf: Record<string, string> = {}) {
  const sent: Array<{ to: string; type: string; payload: Record<string, unknown> }> = [];
  const pushes: Array<{ to: string; payload: Record<string, unknown> }> = [];
  const status = { ...presenceOf };
  const sigEvents = new Emitter<{ message: { msg: unknown; room: string } }>();
  const presEvents = new Emitter<{ change: void }>();
  const callEvents = new Emitter<{ state: unknown; stats: unknown }>();
  const calls = {
    events: callEvents,
    state: null as unknown,
    startLive: async () => 'stream-1',
    revokeViewer: () => undefined,
    reinstateViewer: () => undefined,
    viewerLeft: () => undefined,
  };
  const signaling = {
    events: sigEvents,
    currentRoom: { roomId: 'eng', roomName: 'Eng', roomKey: 'k' },
    send: (to: string, type: string, payload: Record<string, unknown>) => void sent.push({ to, type, payload }),
    broadcast: () => undefined,
  };
  const presence = {
    events: presEvents,
    status: (id: string) => status[id] ?? 'unknown',
    nameOf: (id: string) => id,
    list: () => Object.entries(status).map(([deviceId, s]) => ({ deviceId, status: s, name: deviceId })),
    contacts: () => Object.entries(status).map(([deviceId, s]) => ({ deviceId, status: s, name: deviceId })),
  };
  const push = { notifyIncomingCall: async (to: string, payload: Record<string, unknown>) => (pushes.push({ to, payload }), 'unsupported') };
  const live = new LiveStreamManager(
    calls as never,
    signaling as never,
    { deviceId: 'host', displayName: 'Host' } as never,
    presence as never,
    { timeouts: { ringMs: RING_MS }, mesh: { maxLiveViewers: 8 } } as never,
    push as never,
  );
  live.start();
  const joined = (from: string) =>
    sigEvents.emit('message', { room: 'r', msg: { messageType: 'live-viewer-joined', senderId: from, senderName: from, payload: { streamId: 'stream-1' } } });
  return { live, sent, pushes, status, presEvents, joined, goLive: () => live.goLive('Demo', mode === 'selected' ? { mode, viewerIds: [] } : { mode }) };
}
const rings = (w: ReturnType<typeof world>, to: string) => w.sent.filter((s) => s.type === 'live-viewer-added' && s.to === to && s.payload.ring === true);

describe('calling a participant into a live stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', new EventTarget()); // LiveStreamManager listens for 'pagehide'
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('online participant → ringing invitation over signaling, no push', async () => {
    const w = world('everyone', { bob: 'online' });
    await w.goLive();
    expect(await w.live.callViewer('bob')).toBe('ringing');
    expect(rings(w, 'bob')).toHaveLength(1);
    expect(w.pushes).toHaveLength(0);
  });

  it('selected audience: calling adds them to the audience with ONE ringing invite', async () => {
    const w = world('selected', { bob: 'online' });
    await w.goLive();
    await w.live.callViewer('bob');
    expect(w.live.isAllowed('bob')).toBe(true);
    expect(w.sent.filter((s) => s.type === 'live-viewer-added' && s.to === 'bob')).toHaveLength(1);
    expect(rings(w, 'bob')).toHaveLength(1);
  });

  it.each(['offline', 'unknown'])('%s participant → targeted incoming-call push (callType live), never a broadcast', async (st) => {
    const w = world('everyone', st === 'unknown' ? {} : { bob: st });
    await w.goLive();
    expect(await w.live.callViewer('bob')).toBe('waiting'); // current backend: targeted push unsupported
    expect(w.pushes).toHaveLength(1);
    expect(w.pushes[0]).toMatchObject({ to: 'bob', payload: { type: 'incoming-call', callType: 'live', callId: 'stream-1', title: 'Demo', roomName: 'Eng', callerId: 'host' } });
    expect(rings(w, 'bob')).toHaveLength(0);
  });

  it('offline participant who comes online (e.g. opened the notification) is rung once', async () => {
    const w = world('everyone', { bob: 'offline' });
    await w.goLive();
    await w.live.callViewer('bob');
    w.status.bob = 'online';
    w.presEvents.emit('change', undefined);
    w.presEvents.emit('change', undefined);
    expect(rings(w, 'bob')).toHaveLength(1);
  });

  it('no ringing after the call expired or after they joined', async () => {
    const w = world('everyone', { bob: 'offline', carol: 'offline' });
    await w.goLive();
    await w.live.callViewer('bob');
    await w.live.callViewer('carol');
    w.joined('carol');
    vi.setSystemTime(Date.now() + RING_MS + 1);
    w.status.bob = 'online';
    w.status.carol = 'online';
    w.presEvents.emit('change', undefined);
    expect(rings(w, 'bob')).toHaveLength(0);
    expect(rings(w, 'carol')).toHaveLength(0);
  });

  it('adding someone to the audience without calling does not ring', async () => {
    const w = world('selected', { bob: 'online' });
    await w.goLive();
    w.live.updateAudience('selected', ['bob']);
    const added = w.sent.filter((s) => s.type === 'live-viewer-added' && s.to === 'bob');
    expect(added).toHaveLength(1);
    expect(added[0]!.payload.ring).toBe(false);
  });

  it('not live → nothing sent', async () => {
    const w = world('everyone', { bob: 'online' });
    expect(await w.live.callViewer('bob')).toBe('not-live');
    expect(w.sent).toHaveLength(0);
    expect(w.pushes).toHaveLength(0);
  });
});
