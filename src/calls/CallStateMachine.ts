import type { CallStatus } from '../types/state';

/** Allowed call-status transitions. Anything not listed is rejected (and logged by the caller). */
const TRANSITIONS: Record<CallStatus, readonly CallStatus[]> = {
  idle: ['calling', 'ringing', 'connecting', 'connected'],
  calling: ['ringing', 'connecting', 'rejected', 'busy', 'ended', 'failed'],
  ringing: ['connecting', 'ended', 'rejected', 'failed'],
  connecting: ['connected', 'reconnecting', 'ended', 'failed'],
  connected: ['reconnecting', 'ended', 'failed'],
  reconnecting: ['connected', 'ended', 'failed'],
  ended: ['idle'],
  failed: ['idle'],
  rejected: ['idle'],
  busy: ['idle'],
};

export const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set(['ended', 'failed', 'rejected', 'busy']);
export const ACTIVE_STATUSES: ReadonlySet<CallStatus> = new Set(['connecting', 'connected', 'reconnecting']);

export function canTransition(from: CallStatus, to: CallStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function isTerminal(status: CallStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
