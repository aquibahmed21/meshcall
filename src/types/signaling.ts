/**
 * Signaling protocol (transported over ScaleDrone).
 *
 * Every message is an envelope carrying:
 *   senderId / receiverId  – persistent device IDs (never display names)
 *   senderSessionId        – per page-load session; changes when a user reloads (= rejoin)
 *   roomId                 – room scope; messages from any other room are dropped on receipt
 *   callId                 – call / stream the message belongs to (null for presence)
 *   peerId                 – for negotiation messages: the sender's RTCPeerConnection instance id
 *                            (`pcId`); otherwise the sender's session id
 *   messageId + timestamp  – de-duplication and staleness checks
 *
 * ScaleDrone rooms (roomKey = short hash of the normalised roomId):
 *   observable-room-<roomKey>        presence (member list) + heartbeats + live-stream announcements
 *   inbox-<roomKey>-<deviceId>       directed messages (invites, SDP, ICE, welcome …)
 *   mesh-<callId>                    broadcast inside one call/stream (join/leave/heartbeat/media/chat)
 */
export const PROTOCOL_VERSION = 2;

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
  roomId: string;
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
  away?: boolean;
  dnd?: boolean;
  /** Id of the MeshCall call this device is in (lets others join it from the Calls tab). */
  callId?: string;
  /** The phone itself is in an operator / WhatsApp-style call. */
  phone?: boolean;
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
  /** Current participants (group invites) – lets the invitee see who is in the call. */
  participants?: Array<{ deviceId: string; name: string }>;
  roomName?: string;
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
  /** Group calls: which participant invited this member (join authorisation). */
  invitedBy?: string;
}
export type MeshJoinMessage = Envelope<'mesh-join', MeshMemberPayload>;
export type MeshWelcomeMessage = Envelope<'mesh-welcome', MeshMemberPayload>;
export type MeshHeartbeatMessage = Envelope<'mesh-heartbeat', MeshMemberPayload>;
export type MeshLeaveMessage = Envelope<'mesh-leave', { reason: string }>;
export type MeshRemoveMessage = Envelope<'mesh-remove', { targetId: string }>;
export type MeshRejectMessage = Envelope<'mesh-reject', { reason: 'full' | 'not-allowed' | 'ended' | 'locked' }>;
/** Host → everyone (no targetId) or one person: switch the microphone off. They may unmute again. */
export type MeshMuteMessage = Envelope<'mesh-mute', { targetId?: string }>;
/** Host → everyone: nobody new may join while locked. */
export type MeshLockMessage = Envelope<'mesh-lock', { locked: boolean }>;
export type MediaStateMessage = Envelope<'media-state', MediaStatePayload>;
/**
 * Broadcast in the call's mesh room by a CURRENT participant when it adds people.
 * Converts a 1:1 call into a group call on every client and widens the join allow-list.
 * Existing peer connections are untouched – only new links are negotiated.
 */
/** Sent to someone already in a call: "let me in" – they answer by adding us (call-participants-added + invite). */
export type CallJoinRequestMessage = Envelope<'call-join-request', Record<string, never>>;
export type DeviceLinkRequest = Envelope<'device-link-request', { code: string }>;
export type DeviceLinkAccept = Envelope<'device-link-accept', { name: string }>;
/** A linked device hands its running call to us: expect the invite and answer it automatically. */
export type CallHandoffMessage = Envelope<'call-handoff', { media: MediaKind }>;
export type CallParticipantsAddedMessage = Envelope<'call-participants-added', { participantIds: string[]; title?: string }>;

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
export type AudienceMode = 'everyone' | 'selected';
export interface LiveStreamInfo {
  streamId: string;
  title: string;
  audienceMode: AudienceMode;
  /** Present when audienceMode === 'selected'. */
  allowedViewerIds?: string[];
  viewers: number;
  maxViewers: number;
  startedAt: number;
  /** true for the periodic re-announcement, false for the initial start. */
  heartbeat?: boolean;
}
/** Room-wide (lobby): stream exists / audience changed / stream ended. */
export type LiveStreamStartedMessage = Envelope<'live-started', LiveStreamInfo>;
export type LiveStreamStoppedMessage = Envelope<'live-stopped', { streamId: string }>;
export type LiveStreamAudienceUpdatedMessage = Envelope<'live-audience-updated', LiveStreamInfo>;
/** Directed (inbox) from the streamer to the affected viewer. */
/** `ring`: the streamer is actively calling this person (ringing invitation, not just "added"). */
export type LiveStreamViewerAddedMessage = Envelope<'live-viewer-added', { streamId: string; title: string; targetUserId: string; ring?: boolean }>;
export type LiveStreamViewerRemovedMessage = Envelope<'live-viewer-removed', { streamId: string; targetUserId: string; reason: string }>;
/** Directed (inbox) from a viewer to the streamer. */
export type LiveStreamViewerJoinedMessage = Envelope<'live-viewer-joined', { streamId: string }>;
export type LiveStreamViewerLeftMessage = Envelope<'live-viewer-left', { streamId: string }>;
export type LiveStreamMessage =
  | LiveStreamStartedMessage
  | LiveStreamStoppedMessage
  | LiveStreamAudienceUpdatedMessage
  | LiveStreamViewerAddedMessage
  | LiveStreamViewerRemovedMessage
  | LiveStreamViewerJoinedMessage
  | LiveStreamViewerLeftMessage;

// ── Open invites (drop-in group calls) ──────────────────────────────────────
/**
 * An initiator opens a group call that the invited people can join, leave and rejoin at will
 * until the initiator ends it. Announced in the room lobby (re-sent as a heartbeat); the call
 * itself is an ordinary group mesh with callId = inviteId.
 */
export interface OpenInviteInfo {
  inviteId: string;
  title: string;
  media: MediaKind;
  audienceMode: AudienceMode;
  /** Present when audienceMode === 'selected' (the initiator is always allowed). */
  allowedIds?: string[];
  startedAt: number;
  heartbeat?: boolean;
}
export type InviteStartedMessage = Envelope<'invite-started', OpenInviteInfo>;
export type InviteStoppedMessage = Envelope<'invite-stopped', { inviteId: string }>;

// ── In-call text chat ───────────────────────────────────────────────────────
/**
 * Chat rides on the call's mesh room (`mesh-<callId>`), so every participant already
 * subscribed to the call receives it – no extra subscription, no DataChannel.
 * messageId / senderId / senderName / callId / timestamp come from the envelope.
 */
export interface ChatPayload {
  text: string;
}
export type ChatSignalMessage = Envelope<'chat-message', ChatPayload>;

// ── Direct (1:1) messages – room-scoped, outside calls ────────────────────────
/** Sent to the recipient's room inbox; messageId (envelope) is stable across retries. */
export interface DmReply {
  messageId: string;
  name: string;
  /** Short preview of the quoted message. */
  text: string;
}
export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
}
export type DirectMessageSignal = Envelope<'direct-message', { text: string; sentAt: number; replyTo?: DmReply; file?: FileMeta }>;
/** Peer-to-peer file transfer negotiation (offer/answer/ICE for a dedicated data channel). */
export type FileSignal = Envelope<'file-signal', { fileId: string; tid: string; kind: 'offer' | 'answer' | 'ice' | 'error'; data?: unknown }>;
export type DmTypingSignal = Envelope<'dm-typing', { typing: boolean }>;
export type DmReadSignal = Envelope<'dm-read', { messageIds: string[] }>;
export type DmReactSignal = Envelope<'dm-react', { messageId: string; emoji: string | null }>;
export type DmEditSignal = Envelope<'dm-edit', { messageId: string; text: string }>;
export type DmDeleteSignal = Envelope<'dm-delete', { messageId: string }>;
/** Recipient → sender: the message reached the recipient's app (= "Delivered"). */
export type DirectMessageAckSignal = Envelope<'direct-message-ack', { messageId: string }>;

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
  | MeshMuteMessage
  | MeshLockMessage
  | MediaStateMessage
  | OfferMessage
  | AnswerMessage
  | ICECandidateMessage
  | PeerReconnectMessage
  | CallParticipantsAddedMessage
  | CallJoinRequestMessage
  | DeviceLinkRequest
  | DeviceLinkAccept
  | CallHandoffMessage
  | FileSignal
  | LiveStreamMessage
  | InviteStartedMessage
  | InviteStoppedMessage
  | ChatSignalMessage
  | DirectMessageSignal
  | DirectMessageAckSignal
  | DmTypingSignal
  | DmReadSignal
  | DmReactSignal
  | DmEditSignal
  | DmDeleteSignal;

export type MessageType = SignalingMessage['messageType'];
export type MessageOf<T extends MessageType> = Extract<SignalingMessage, { messageType: T }>;
export type PayloadOf<T extends MessageType> = MessageOf<T>['payload'];

export type NegotiationMessage = OfferMessage | AnswerMessage | ICECandidateMessage | PeerReconnectMessage;

const TYPES: ReadonlySet<string> = new Set<MessageType>([
  'presence-heartbeat', 'presence-leave', 'call-invite', 'call-ringing', 'call-accept', 'call-reject',
  'call-cancel', 'call-hangup', 'mesh-join', 'mesh-welcome', 'mesh-heartbeat', 'mesh-leave', 'mesh-remove',
  'mesh-reject', 'mesh-mute', 'mesh-lock', 'media-state', 'offer', 'answer', 'ice-candidate', 'peer-reconnect', 'call-participants-added', 'call-join-request', 'file-signal', 'device-link-request', 'device-link-accept', 'call-handoff', 'chat-message',
  'live-started', 'live-stopped', 'live-audience-updated', 'live-viewer-added', 'live-viewer-removed',
  'live-viewer-joined', 'live-viewer-left', 'direct-message', 'direct-message-ack', 'invite-started', 'invite-stopped',
  'dm-typing', 'dm-read', 'dm-react', 'dm-edit', 'dm-delete',
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
    typeof m.roomId === 'string' &&
    typeof m.peerId === 'string' &&
    (m.callId === null || typeof m.callId === 'string') &&
    !!m.payload &&
    typeof m.payload === 'object'
  );
}

export function isNegotiationMessage(m: SignalingMessage): m is NegotiationMessage {
  return m.messageType === 'offer' || m.messageType === 'answer' || m.messageType === 'ice-candidate' || m.messageType === 'peer-reconnect';
}
