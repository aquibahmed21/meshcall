/**
 * Push notification payloads understood by the MeshCall Service Worker (public/sw.js mirrors
 * this parsing in plain JS). Only 'incoming-call' is implemented; the others are reserved.
 */
export type PushNotificationType = 'incoming-call' | 'chat-message' | 'group-invite' | 'live-stream' | 'system';

export interface IncomingCallPush {
  type: 'incoming-call';
  callId: string;
  roomId: string;
  roomName: string;
  callerId: string;
  callerName: string;
  callType: 'audio' | 'video' | 'group' | 'live';
  /** Live stream title (callType 'live'). */
  title?: string;
  timestamp: number;
  /** Absolute expiry (caller clock) – after this the Service Worker shows "Missed call". */
  expiresAt: number;
}

export interface ChatMessagePush {
  type: 'chat-message';
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
  roomId: string;
  roomName: string;
  timestamp: number;
}

/** What a targeted push carries (title/body for display + typed data for the app). */
export type TargetedPushPayload = IncomingCallPush | ChatMessagePush;

/** Context handed from a notification click to the app (never contains credentials). */
export interface CallLaunchContext {
  kind: 'incoming-call';
  action: 'open' | 'decline';
  callId: string;
  roomId?: string;
  roomName?: string;
  callerId?: string;
  callerName?: string;
  callType?: string;
  at: number;
}

export function isIncomingCallPush(v: unknown): v is IncomingCallPush {
  const p = v as Partial<IncomingCallPush> | null;
  return (
    !!p &&
    p.type === 'incoming-call' &&
    typeof p.callId === 'string' &&
    typeof p.roomName === 'string' &&
    typeof p.callerName === 'string' &&
    (p.callType === 'audio' || p.callType === 'video' || p.callType === 'group' || p.callType === 'live')
  );
}

/** A chat notification was clicked → open that conversation. */
export interface ChatLaunchContext {
  kind: 'chat-message';
  action: 'open';
  senderId: string;
  senderName?: string;
  messageId?: string;
  roomId?: string;
  roomName?: string;
  at: number;
}

export type LaunchContext = CallLaunchContext | ChatLaunchContext;

export function isChatLaunchContext(v: unknown): v is ChatLaunchContext {
  const c = v as Partial<ChatLaunchContext> | null;
  return !!c && c.kind === 'chat-message' && typeof c.senderId === 'string';
}

export function isLaunchContext(v: unknown): v is LaunchContext {
  return isCallLaunchContext(v) || isChatLaunchContext(v);
}

export function isCallLaunchContext(v: unknown): v is CallLaunchContext {
  const c = v as Partial<CallLaunchContext> | null;
  return !!c && c.kind === 'incoming-call' && typeof c.callId === 'string' && (c.action === 'open' || c.action === 'decline');
}
