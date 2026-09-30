import type { CallKind, MediaKind, MediaStatePayload, MeshRole } from './signaling';

export type PresenceStatus = 'online' | 'offline' | 'connecting' | 'unknown';

export interface UserPresence {
  deviceId: string;
  name: string;
  status: PresenceStatus;
  busy: boolean;
  pushEnabled: boolean;
  lastSeen: number;
}

export type CallStatus =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended'
  | 'failed'
  | 'rejected'
  | 'busy';

export type CallType = 'audio' | 'video' | 'group' | 'live';

export type IceCandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

/** Active path of a peer connection – from the SELECTED candidate pair in getStats(). */
export type ConnectionPath = 'p2p' | 'stun' | 'turn' | 'unknown';

/**
 * Which STUN/TURN server a selected candidate came from. `url` is only set when WebRTC itself
 * reported it (stats `url` or the gathering event's `url`); otherwise `source` is 'unknown' and
 * the UI lists the configured servers instead of guessing.
 */
export interface ServerIdentification {
  role: 'stun' | 'turn' | 'none';
  /** Whose candidate involves the server: ours (identifiable) or the peer's (not visible here). */
  side: 'local' | 'remote' | 'none';
  url?: string;
  source: 'stats' | 'gathering' | 'unknown' | 'n/a';
  note: string;
}

/** Network path of the selected ICE candidate pair – derived ONLY from getStats(). */
export type PathCategory = 'direct-host' | 'direct-stun' | 'relay';

export interface SelectedPathInfo {
  localType: IceCandidateType;
  remoteType: IceCandidateType;
  /** "host → host" etc. */
  pairLabel: string;
  /** P2P / STUN / TURN */
  connectionType: 'P2P' | 'STUN' | 'TURN';
  connectionPath: Exclude<ConnectionPath, 'unknown'>;
  path: PathCategory;
  /** Human description, e.g. "Direct P2P (LAN)". */
  pathLabel: string;
  /** Transport between the peers (candidate protocol). */
  transport: string;
  /** For relay: protocol between us and the TURN server (udp/tcp/tls). */
  relayProtocol?: string;
  localAddress?: string;
  localPort?: number;
  remoteAddress?: string;
  /** Raw `url` of the local candidate from getStats (Chromium: set for srflx/relay). */
  localUrl?: string;
  turnUrl?: string;
  /** Filled in by PeerSession (stats url → gathering-event url → unknown). */
  server?: ServerIdentification;
}

export type GateState = 'holding' | 'released-connected' | 'released-timeout' | 'released-failure' | 'released-gathering' | 'native';

export interface CandidateCounts {
  host: number;
  srflx: number;
  prflx: number;
  relay: number;
}

export interface PeerConnectionState {
  peerId: string;
  pcId: string;
  generation: number;
  polite: boolean;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  selectedCandidateType?: IceCandidateType;
  selectedPath?: SelectedPathInfo;
  reconnectAttempts: number;
  iceRestarts: number;
  recreations: number;
  gate: GateState;
  localCandidates: CandidateCounts;
  remoteCandidates: CandidateCounts;
  iceErrors: string[];
  createdAt: number;
  connectedAt?: number;
  timeToConnectMs?: number;
  lastError?: string;
}

export interface ParticipantState {
  deviceId: string;
  sessionId: string;
  name: string;
  role: MeshRole;
  media: MediaStatePayload;
  joinedAt: number;
  lastSeen: number;
  peer: PeerConnectionState | null;
}

export interface CallState {
  callId: string;
  kind: CallKind;
  type: CallType;
  media: MediaKind;
  direction: 'outgoing' | 'incoming';
  role: MeshRole;
  hostId: string;
  status: CallStatus;
  statusDetail?: string;
  remoteUser?: { deviceId: string; name: string };
  title?: string;
  participants: Map<string, ParticipantState>;
  startedAt: number;
  connectedAt?: number;
  endedAt?: number;
}

export type NetworkQuality = 'excellent' | 'good' | 'poor' | 'critical' | 'unknown';
