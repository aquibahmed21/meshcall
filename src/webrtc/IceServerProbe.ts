import { createLogger } from '../core/logger';
import { parseCandidateType } from './IceStrategy';

const log = createLogger('ICE');

export interface ProbeResult {
  url: string;
  kind: 'stun' | 'turn';
  ok: boolean;
  candidates: string[];
  errors: string[];
  ms: number;
}

/**
 * Health check for each configured STUN/TURN URL: gather candidates against that single server
 * (TURN with iceTransportPolicy "relay") and report whether it produced srflx / relay candidates.
 * Answers "is STUN reachable?" / "does TURN allocate?" independent of any call.
 */
export async function probeIceServers(servers: RTCIceServer[], timeoutMs = 6000): Promise<ProbeResult[]> {
  const jobs: Array<Promise<ProbeResult>> = [];
  for (const s of servers) {
    for (const url of Array.isArray(s.urls) ? s.urls : [s.urls]) {
      const kind = /^turns?:/i.test(url) ? 'turn' : 'stun';
      jobs.push(probeOne({ ...s, urls: url }, url, kind, timeoutMs));
    }
  }
  const results = await Promise.all(jobs);
  for (const r of results) log.info(`Probe ${r.url}: ${r.ok ? 'OK' : 'FAILED'} ${r.errors.join('; ')}`);
  return results;
}

async function probeOne(server: RTCIceServer, url: string, kind: 'stun' | 'turn', timeoutMs: number): Promise<ProbeResult> {
  const started = performance.now();
  const want = kind === 'turn' ? 'relay' : 'srflx';
  const candidates: string[] = [];
  const errors: string[] = [];
  let pc: RTCPeerConnection | null = null;
  try {
    pc = new RTCPeerConnection({ iceServers: [server], iceTransportPolicy: kind === 'turn' ? 'relay' : 'all' });
    pc.createDataChannel('probe');
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      pc!.onicecandidate = (e) => {
        if (!e.candidate) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const type = parseCandidateType(e.candidate.candidate);
        if (type) candidates.push(`${type}/${e.candidate.protocol ?? '?'}`);
        if (type === want) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    pc.onicecandidateerror = (e) => {
      const ev = e as RTCPeerConnectionIceErrorEvent;
      // 701 for IPv6 lookups is noise when IPv4 works – keep it but it does not fail the probe.
      errors.push(`${ev.errorCode} ${ev.errorText}`);
    };
    await pc.setLocalDescription();
    await done;
  } catch (err) {
    errors.push(String(err));
  } finally {
    pc?.close();
  }
  const ok = candidates.some((c) => c.startsWith(want));
  if (!ok && !errors.length) errors.push('no response (server unreachable, wrong port, or UDP blocked)');
  return { url, kind, ok, candidates: [...new Set(candidates)], errors: [...new Set(errors)], ms: Math.round(performance.now() - started) };
}
