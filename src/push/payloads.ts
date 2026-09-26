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
  callType: 'audio' | 'video' | 'group';
  timestamp: number;
  /** Absolute expiry (caller clock) – after this the Service Worker shows "Missed call". */
  expiresAt: number;
}

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
    (p.callType === 'audio' || p.callType === 'video' || p.callType === 'group')
  );
}

export function isCallLaunchContext(v: unknown): v is CallLaunchContext {
  const c = v as Partial<CallLaunchContext> | null;
  return !!c && c.kind === 'incoming-call' && typeof c.callId === 'string' && (c.action === 'open' || c.action === 'decline');
}
