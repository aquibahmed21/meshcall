import { createLogger } from '../core/logger';
import { AUDIO_BITRATE, AUTO_LADDER, SCREEN_SHARE, VIDEO_PRESETS, autoStartLevel } from '../media/QualityPresets';
import type { MediaManager } from '../media/MediaManager';
import type { SettingsService } from '../services/SettingsService';
import { AdaptiveLadder } from './AdaptiveLadder';
import type { PeerSession } from './PeerSession';
import type { StatsReport } from './StatsMonitor';

const log = createLogger('Quality');

/**
 * Applies audio/video quality to every sender via RTCRtpSender.setParameters() – never by
 * renegotiating or rebuilding connections. In "Auto" each peer has its own hysteresis ladder
 * (mesh: every peer gets an independent encoding, so one weak link does not degrade the others).
 */
export class AdaptiveQualityManager {
  private ladders = new Map<string, { pcId: string; ladder: AdaptiveLadder }>();

  constructor(
    private readonly settings: SettingsService,
    private readonly media: MediaManager,
    private readonly sessions: () => PeerSession[],
  ) {}

  onStats(report: StatsReport): void {
    if (this.settings.get().videoQuality !== 'auto' || this.media.state.screenSharing) return;
    for (const s of this.sessions()) {
      const snap = report.peers.get(s.remoteId);
      if (!snap || !s.isConnected) continue;
      const entry = this.ladderFor(s);
      const changed = entry.ladder.update(snap.quality, snap.availableOutgoingBitrate);
      if (changed !== null) {
        log.info(`${s.name}: network ${snap.quality} → video ${AUTO_LADDER[changed]}`);
        void this.applyVideo(s);
      }
    }
  }

  /** (Re)apply quality to all peers – on settings change, screen share, camera change. */
  applyAll(): void {
    if (this.settings.get().videoQuality !== 'auto') this.ladders.clear();
    for (const s of this.sessions()) void this.applyTo(s);
  }

  async applyTo(s: PeerSession): Promise<void> {
    await s.setEncoding('audio', { maxBitrate: AUDIO_BITRATE[this.settings.get().audioQuality], priority: 'high', networkPriority: 'high' });
    await this.applyVideo(s);
  }

  forget(remoteId: string): void {
    this.ladders.delete(remoteId);
  }

  dispose(): void {
    this.ladders.clear();
  }

  private ladderFor(s: PeerSession) {
    let e = this.ladders.get(s.remoteId);
    if (!e || e.pcId !== s.pcId) {
      const peers = this.sessions().length;
      e = { pcId: s.pcId, ladder: new AdaptiveLadder({ levels: AUTO_LADDER.map((p) => VIDEO_PRESETS[p].maxBitrate), start: autoStartLevel(peers) }) };
      this.ladders.set(s.remoteId, e);
    }
    return e;
  }

  private async applyVideo(s: PeerSession): Promise<void> {
    if (this.media.state.screenSharing) {
      await s.setEncoding('video', {
        maxBitrate: SCREEN_SHARE.maxBitrate,
        maxFramerate: SCREEN_SHARE.frameRate,
        scaleResolutionDownBy: 1,
        degradationPreference: 'maintain-resolution',
      });
      return;
    }
    const q = this.settings.get().videoQuality;
    const preset = q === 'auto' ? VIDEO_PRESETS[AUTO_LADDER[this.ladderFor(s).ladder.level]!] : VIDEO_PRESETS[q];
    const captureHeight = this.media.captureHeight() ?? preset.height;
    await s.setEncoding('video', {
      maxBitrate: preset.maxBitrate,
      maxFramerate: preset.frameRate,
      scaleResolutionDownBy: Math.max(1, captureHeight / preset.height),
      degradationPreference: 'balanced',
    });
  }
}
