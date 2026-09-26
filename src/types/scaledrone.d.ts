/** Typings for the ScaleDrone browser client (https://cdn.scaledrone.com/scaledrone.min.js). */
export interface ScaledroneMember<D = unknown> {
  id: string;
  clientData?: D;
  authData?: unknown;
}

export interface ScaledroneMessage<T = unknown> {
  data: T;
  id: string;
  timestamp: number;
  clientId?: string;
  member?: ScaledroneMember;
}

export interface ScaledroneRoom {
  name: string;
  on(event: 'open', cb: (error?: unknown) => void): void;
  on(event: 'message', cb: (message: ScaledroneMessage) => void): void;
  on(event: 'members', cb: (members: ScaledroneMember[]) => void): void;
  on(event: 'member_join' | 'member_leave', cb: (member: ScaledroneMember) => void): void;
  unsubscribe(): void;
}

export interface ScaledroneClient {
  clientId: string;
  on(event: 'open', cb: (error?: unknown) => void): void;
  on(event: 'error', cb: (error: unknown) => void): void;
  on(event: 'close' | 'disconnect' | 'reconnect', cb: (event?: unknown) => void): void;
  subscribe(room: string, options?: { historyCount?: number }): ScaledroneRoom;
  publish(params: { room: string; message: unknown }): void;
  close(): void;
}

export interface ScaledroneConstructor {
  new (channelId: string, options?: { data?: unknown }): ScaledroneClient;
}

declare global {
  interface Window {
    Scaledrone?: ScaledroneConstructor;
  }
}
