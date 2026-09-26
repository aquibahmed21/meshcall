import type { MediaKind } from '../types/signaling';
import type { ParticipantState } from '../types/state';
import type { IdentityService } from '../services/IdentityService';
import type { CallManager } from './CallManager';

/**
 * Group (mesh) call operations. Every participant keeps one RTCPeerConnection per other
 * participant (N·(N−1)/2 links); a participant leaving closes only its own links.
 */
export class GroupCallManager {
  constructor(
    private readonly calls: CallManager,
    private readonly identity: IdentityService,
  ) {}

  create(userIds: string[], media: MediaKind, name?: string): Promise<void> {
    return this.calls.startGroupCall(userIds, media, name);
  }

  /** Works for 1:1 calls too (converts them into a group call). */
  addParticipant(userId: string): void {
    this.calls.addParticipants([userId]);
  }

  /** Host only. */
  removeParticipant(userId: string): void {
    this.calls.removeParticipant(userId);
  }

  leave(): void {
    this.calls.hangup();
  }

  participants(): ParticipantState[] {
    return [...(this.calls.state?.participants.values() ?? [])];
  }

  get isHost(): boolean {
    const s = this.calls.state;
    return !!s && s.kind === 'group' && s.hostId === this.identity.deviceId;
  }
}
