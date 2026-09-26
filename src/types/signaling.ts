/**
 * Signaling protocol (transported over ScaleDrone).
 *
 * Every message is an envelope carrying:
 *   senderId / receiverId  – persistent device IDs (never display names)
 *   senderSessionId        – per page-load session; changes when a user reloads (= rejoin)
 *   callId                 – call / stream the message belongs to (null for presence)
 *   peerId                 – for negotiation messages: the sender's RTCPeerConnection instance id
 *                            (`pcId`); otherwise the sender's session id
 *   messageId + timestamp  – de-duplication and staleness checks
 *
 * Rooms:
 *   observable-lobby     presence (ScaleDrone member list) + heartbeats + live stream announcements
 *   inbox-<deviceId>     directed messages (invites, SDP, ICE, welcome …)
 *   mesh-<callId>        broadcast inside a call (join/leave/heartbeat/media state)
 */
export const PROTOCOL_VERSION = 1;

export type MediaKind = 'audio' | 'video';
export type CallKind = 'direct' | 'group' | 'live';
export type MeshRole = 'participant' | 'broadcaster' | 'viewer';

export interface Envelope<T extends string, P> {
  v: typeof PROTOCOL_VERSION;
  messageType: T;
  messageId: string;
  timestamp: number;
  senderId: string;
  senderSessionId: string;
  senderName: string;
  receiverId: string; // deviceId or '*'
  receiverSessionId?: string;
  callId: string | null;
  peerId: string;
  payload: P;
}

export interface MediaStatePayload {
  audioMuted: boolean;
  videoMuted: boolean;
  screenSharing: boolean;
}

// ── Presence ────────────────────────────────────────────────────────────────
export interface PresencePayload {
  busy: boolean;
  pushEnabled: boolean;
}
export type PresenceHeartbeatMessage = Envelope<'presence-heartbeat', PresencePayload>;
export type PresenceLeaveMessage = Envelope<'presence-leave', PresencePayload>;
export type PresenceMessage = PresenceHeartbeatMessage | PresenceLeaveMessage;

// ── Call control ────────────────────────────────────────────────────────────
export interface InvitePayload {
  callKind: CallKind;
  media: MediaKind;
  /** Initiator/host of the call (group calls). */
  hostId: string;
  groupName?: string;
  /** Absolute expiry (sender clock) – invites past this are ignored. */
  expiresAt: number;
}
export type CallInviteMessage = Envelope<'call-invite', InvitePayload>;
export type CallRingingMessage = Envelope<'call-ringing', Record<string, never>>;
export type CallAcceptMessage = Envelope<'call-accept', { media: MediaKind }>;
export type CallRejectMessage = Envelope<'call-reject', { reason: 'declined' | 'busy' | 'unavailable' }>;
export type CallCancelMessage = Envelope<'call-cancel', { reason: 'cancelled' | 'timeout' | 'answered-elsewhere'; answeredBySessionId?: string }>;
export type CallHangupMessage = Envelope<'call-hangup', { reason: 'hangup' | 'ended' | 'failed' }>;

// ── Mesh membership ─────────────────────────────────────────────────────────
export interface MeshMemberPayload {
  role: MeshRole;
  callKind: CallKind;
  media: MediaStatePayload;
  /** remoteDeviceId → our pcId for that peer; lets peers detect orphaned connections. */
  peers?: Record<string, string>;
  hostId?: string;
}
export type MeshJoinMessage = Envelope<'mesh-join', MeshMemberPayload>;
export type MeshWelcomeMessage = Envelope<'mesh-welcome', MeshMemberPayload>;
export type MeshHeartbeatMessage = Envelope<'mesh-heartbeat', MeshMemberPayload>;
export type MeshLeaveMessage = Envelope<'mesh-leave', { reason: string }>;
export type MeshRemoveMessage = Envelope<'mesh-remove', { targetId: string }>;
export type MeshRejectMessage = Envelope<'mesh-reject', { reason: 'full' | 'not-allowed' | 'ended' }>;
export type MediaStateMessage = Envelope<'media-state', MediaStatePayload>;

// ── WebRTC negotiation ──────────────────────────────────────────────────────
export interface NegotiationRouting {
  /** Sender's RTCPeerConnection instance id. */
  pcId: string;
  /** Receiver's RTCPeerConnection instance id as known by the sender (null before first answer). */
  targetPcId: string | null;
}
export type OfferMessage = Envelope<'offer', NegotiationRouting & { description: RTCSessionDescriptionInit; iceRestart: boolean }>;
export type AnswerMessage = Envelope<'answer', NegotiationRouting & { description: RTCSessionDescriptionInit }>;
export type ICECandidateMessage = Envelope<'ice-candidate', NegotiationRouting & { candidate: RTCIceCandidateInit }>;
export type PeerReconnectMessage = Envelope<'peer-reconnect', NegotiationRouting & { reason: string }>;

// ── Live streaming ──────────────────────────────────────────────────────────
export interface StreamInfoPayload {
  streamId: string;
  title: string;
  viewers: number;
  maxViewers: number;
  startedAt: number;
}
export type StreamAnnounceMessage = Envelope<'stream-announce', StreamInfoPayload>;
export type StreamEndMessage = Envelope<'stream-end', StreamInfoPayload>;
export type StreamMessage = StreamAnnounceMessage | StreamEndMessage;

export type SignalingMessage =
  | PresenceHeartbeatMessage
  | PresenceLeaveMessage
  | CallInviteMessage
  | CallRingingMessage
  | CallAcceptMessage
  | CallRejectMessage
  | CallCancelMessage
  | CallHangupMessage
  | MeshJoinMessage
  | MeshWelcomeMessage
  | MeshHeartbeatMessage
  | MeshLeaveMessage
  | MeshRemoveMessage
  | MeshRejectMessage
  | MediaStateMessage
  | OfferMessage
  | AnswerMessage
  | ICECandidateMessage
  | PeerReconnectMessage
  | StreamAnnounceMessage
  | StreamEndMessage;

export type MessageType = SignalingMessage['messageType'];
export type MessageOf<T extends MessageType> = Extract<SignalingMessage, { messageType: T }>;
export type PayloadOf<T extends MessageType> = MessageOf<T>['payload'];

export type NegotiationMessage = OfferMessage | AnswerMessage | ICECandidateMessage | PeerReconnectMessage;

const TYPES: ReadonlySet<string> = new Set<MessageType>([
  'presence-heartbeat', 'presence-leave', 'call-invite', 'call-ringing', 'call-accept', 'call-reject',
  'call-cancel', 'call-hangup', 'mesh-join', 'mesh-welcome', 'mesh-heartbeat', 'mesh-leave', 'mesh-remove',
  'mesh-reject', 'media-state', 'offer', 'answer', 'ice-candidate', 'peer-reconnect', 'stream-announce', 'stream-end',
]);

/** Structural validation of untrusted wire data. */
export function isSignalingMessage(value: unknown): value is SignalingMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    m.v === PROTOCOL_VERSION &&
    typeof m.messageType === 'string' &&
    TYPES.has(m.messageType) &&
    typeof m.messageId === 'string' &&
    typeof m.timestamp === 'number' &&
    typeof m.senderId === 'string' &&
    typeof m.senderSessionId === 'string' &&
    typeof m.senderName === 'string' &&
    typeof m.receiverId === 'string' &&
    typeof m.peerId === 'string' &&
    (m.callId === null || typeof m.callId === 'string') &&
    !!m.payload &&
    typeof m.payload === 'object'
  );
}

export function isNegotiationMessage(m: SignalingMessage): m is NegotiationMessage {
  return m.messageType === 'offer' || m.messageType === 'answer' || m.messageType === 'ice-candidate' || m.messageType === 'peer-reconnect';
}
