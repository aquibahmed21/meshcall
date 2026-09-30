import { createLogger } from '../core/logger';
import { parseCandidateType } from './IceStrategy';

const log = createLogger('ICE');

export interface IceServerTestResult {
  url: string;
  type: 'stun' | 'turn';
  status: 'testing' | 'success' | 'failed';
  /** Candidate type that proved the server works: srflx (STUN) / relay (TURN). */
  candidateType?: string;
  /** Candidate transport (UDP/TCP). */
  protocol?: string;
  /** TURN: transport between us and the TURN server (UDP/TCP/TLS). */
  relayProtocol?: string;
  /** STUN: our public address · TURN: the allocated relay address. */
  address?: string;
  /** Server URL WebRTC reported for the candidate (when exposed). */
  reportedUrl?: string;
  error?: string;
  causes?: string[];
  /** Raw icecandidateerror lines, for debugging. */
  errors: string[];
  testedAt: number;
  durationMs: number;
}

export interface IceServerEntry {
  url: string;
  type: 'stun' | 'turn';
  server: RTCIceServer;
}

/** Split the configured RTCIceServer list into one entry per URL (credentials kept, never shown). */
export function listIceServers(servers: RTCIceServer[]): IceServerEntry[] {
  const out: IceServerEntry[] = [];
  for (const s of servers) {
    for (const url of Array.isArray(s.urls) ? s.urls : [s.urls]) {
      out.push({ url, type: /^turns?:/i.test(url) ? 'turn' : 'stun', server: { ...s, urls: url } });
    }
  }
  return out;
}

const TURN_CAUSES = ['Server unreachable', 'Invalid credentials', 'Incorrect port', 'TURN server configuration', 'Firewall', 'TLS/UDP/TCP issue'];

/** Map ICE candidate error codes to human causes (RFC 5389/8656 + WebRTC 7xx codes). */
export function explainIceErrors(type: 'stun' | 'turn', codes: number[], gotAnyCandidate: boolean): { error: string; causes: string[] } {
  if (codes.includes(401) || codes.includes(403)) {
    return { error: 'Server rejected the credentials (401/403)', causes: ['Invalid credentials', 'Expired time-limited credential', 'Wrong realm on the server'] };
  }
  if (codes.includes(486)) return { error: 'Allocation quota reached (486)', causes: ['Too many allocations for this user'] };
  if (codes.includes(508)) return { error: 'Server has no capacity (508)', causes: ['TURN server configuration'] };
  if (codes.some((c) => c >= 700 && c < 800)) {
    return {
      error: 'Server could not be reached (DNS lookup failed or no response)',
      causes: type === 'turn' ? TURN_CAUSES : ['Server unreachable', 'Incorrect host name or port', 'Firewall / UDP blocked'],
    };
  }
  if (type === 'turn') {
    return { error: 'No relay candidate was gathered.', causes: TURN_CAUSES };
  }
  return {
    error: gotAnyCandidate ? 'No server-reflexive candidate discovered' : 'No candidates gathered at all',
    causes: ['Server unreachable', 'Incorrect port', 'Firewall / UDP blocked', 'No NAT/public mapping returned'],
  };
}

/**
 * Test ONE STUN or TURN URL with a temporary RTCPeerConnection that is configured with only that
 * server and then fully released.
 *
 *  STUN → iceTransportPolicy 'all'   : success only if a srflx candidate is gathered
 *  TURN → iceTransportPolicy 'relay' : success only if a relay candidate is gathered
 *
 * 'relay' is used ONLY by this diagnostic connection; calls keep iceTransportPolicy 'all'.
 * "Gathering completed" alone never counts as success.
 */
export async function testIceServer(entry: IceServerEntry, timeoutMs = 8000): Promise<IceServerTestResult> {
  const started = performance.now();
  const want = entry.type === 'turn' ? 'relay' : 'srflx';
  const errors: string[] = [];
  const codes: number[] = [];
  let found: RTCIceCandidate | null = null;
  let reportedUrl: string | undefined;
  let anyCandidate = false;
  let pc: RTCPeerConnection | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    pc = new RTCPeerConnection({ iceServers: [entry.server], iceTransportPolicy: entry.type === 'turn' ? 'relay' : 'all' });
    pc.createDataChannel('ice-test'); // an m-line is needed for gathering
    const done = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      pc!.onicecandidate = (e) => {
        if (!e.candidate) return resolve(); // gathering complete
        if (!e.candidate.candidate) return;
        anyCandidate = true;
        if ((e.candidate.type ?? parseCandidateType(e.candidate.candidate)) === want && !found) {
          found = e.candidate;
          reportedUrl = (e as RTCPeerConnectionIceEvent & { url?: string | null }).url ?? undefined;
          resolve();
        }
      };
      pc!.onicecandidateerror = (e) => {
        const ev = e as RTCPeerConnectionIceErrorEvent;
        codes.push(ev.errorCode);
        errors.push(`${ev.errorCode} ${ev.errorText ?? ''}`.trim());
      };
    });
    await pc.setLocalDescription();
    await done;
  } catch (err) {
    errors.push(String(err));
  } finally {
    if (timer) clearTimeout(timer);
    if (pc) {
      pc.onicecandidate = pc.onicecandidateerror = null;
      pc.close(); // releases sockets and any TURN allocation
    }
  }
  const base = { url: entry.url, type: entry.type, testedAt: Date.now(), durationMs: Math.round(performance.now() - started), errors: [...new Set(errors)] };
  const c = found as RTCIceCandidate | null;
  if (c) {
    const relayProtocol = (c as RTCIceCandidate & { relayProtocol?: string }).relayProtocol;
    const result: IceServerTestResult = {
      ...base,
      status: 'success',
      candidateType: want,
      protocol: c.protocol?.toUpperCase(),
      relayProtocol: relayProtocol?.toUpperCase() ?? (entry.type === 'turn' ? transportOf(entry.url) : undefined),
      address: c.address ? `${c.address}${c.port ? `:${c.port}` : ''}` : undefined,
      reportedUrl,
    };
    log.info(`ICE test ${entry.url}: OK (${want} ${result.address ?? ''})`);
    return result;
  }
  const { error, causes } = explainIceErrors(entry.type, codes, anyCandidate);
  log.info(`ICE test ${entry.url}: FAILED – ${error}`);
  return { ...base, status: 'failed', error, causes };
}

/** Transport requested by a TURN URL (`?transport=tcp`, `turns:` = TLS, default UDP). */
function transportOf(url: string): string {
  if (/^turns:/i.test(url)) return 'TLS';
  const m = /transport=(udp|tcp)/i.exec(url);
  return (m?.[1] ?? 'udp').toUpperCase();
}

/** Test all configured servers (in parallel). */
export async function probeIceServers(servers: RTCIceServer[], timeoutMs = 8000): Promise<IceServerTestResult[]> {
  return Promise.all(listIceServers(servers).map((e) => testIceServer(e, timeoutMs)));
}
