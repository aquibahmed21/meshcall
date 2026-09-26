import type { AudioQualityPreset, VideoQualityPreset } from '../services/SettingsService';

export interface VideoPreset {
  width: number;
  height: number;
  frameRate: number;
  maxBitrate: number;
}

export type FixedVideoPreset = Exclude<VideoQualityPreset, 'auto'>;

export const VIDEO_PRESETS: Record<FixedVideoPreset, VideoPreset> = {
  low: { width: 320, height: 180, frameRate: 15, maxBitrate: 150_000 },
  '360p': { width: 640, height: 360, frameRate: 24, maxBitrate: 500_000 },
  '480p': { width: 854, height: 480, frameRate: 30, maxBitrate: 900_000 },
  '720p': { width: 1280, height: 720, frameRate: 30, maxBitrate: 1_600_000 },
  '1080p': { width: 1920, height: 1080, frameRate: 30, maxBitrate: 3_000_000 },
};

/** Steps the adaptive ("Auto") controller moves along. Capture stays at 720p; the encoder scales down. */
export const AUTO_LADDER: FixedVideoPreset[] = ['low', '360p', '480p', '720p'];
export const AUTO_CAPTURE: VideoPreset = VIDEO_PRESETS['720p'];

export const AUDIO_BITRATE: Record<AudioQualityPreset, number> = {
  low: 16_000, // narrow, survives 2G/3G
  standard: 32_000, // Opus wideband speech
  high: 64_000, // music-grade
};

export const SCREEN_SHARE = { maxBitrate: 1_500_000, frameRate: 15 };

/** Where "Auto" starts: every extra mesh peer costs another full upstream copy. */
export function autoStartLevel(peerCount: number): number {
  if (peerCount <= 1) return 3;
  if (peerCount <= 3) return 2;
  return 1;
}
