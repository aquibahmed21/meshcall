import { describe, expect, it } from 'vitest';
import { netRows, peerNetInfo, serverRow } from '../../src/ui/netInfo';
import { classifyPath, identifyServer } from '../../src/webrtc/IceStrategy';

const path = (l: string, r: string, url?: string) => {
  const p = { ...classifyPath({ candidateType: l, address: '203.0.113.5', port: 1, protocol: 'udp' }, { candidateType: r }), localUrl: url };
  return { ...p, server: identifyServer(p, () => undefined) };
};
const participant = (connectionState: string, selectedPath?: unknown, connectedAt?: number) =>
  ({ deviceId: 'b', name: 'Bob', peer: { connectionState, selectedPath, connectedAt } }) as never;

describe('tile / panel network info', () => {
  it('path is Unknown until connected, even if an old pair is known', () => {
    for (const st of ['new', 'connecting', 'disconnected', 'failed']) {
      expect(peerNetInfo(participant(st, path('host', 'host'), st === 'disconnected' ? 1 : undefined), undefined).path).toBe('unknown');
    }
    expect(peerNetInfo(participant('disconnected', undefined, 1), undefined).statusLabel).toMatch(/Reconnecting/);
    expect(peerNetInfo({ deviceId: 'b', name: 'Bob' } as never, undefined).path).toBe('unknown');
  });
  it('connected: label from the selected pair', () => {
    const i = peerNetInfo(participant('connected', path('relay', 'srflx', 'turn:t.example:3478?transport=udp')), undefined);
    expect([i.status, i.pathLabel, i.pair]).toEqual(['connected', 'TURN', 'relay → srflx']);
    expect(serverRow(i)).toEqual(['TURN Server', 'turn:t.example:3478?transport=udp']);
  });
  it('srflx without a reported URL: says so and lists configured servers (no guess)', () => {
    const i = peerNetInfo(participant('connected', path('srflx', 'host')), undefined);
    const [k, v] = serverRow(i)!;
    expect(k).toBe('STUN Server');
    expect(v).toMatch(/did not say which server/);
    expect(v).toMatch(/Configured:/);
  });
  it('host → host: no server row, P2P', () => {
    const i = peerNetInfo(participant('connected', path('host', 'host')), undefined);
    expect(i.pathLabel).toBe('P2P');
    expect(serverRow(i)).toBeNull();
    expect(netRows(i).map(([k]) => k)).toEqual(expect.arrayContaining(['Connection', 'ICE', 'Protocol', 'RTT', 'Packet Loss', 'Upload', 'Download']));
  });
});
