import { Emitter } from '../core/emitter';
import { storage } from '../core/storage';

export type VideoQualityPreset = 'auto' | 'low' | '360p' | '480p' | '720p' | '1080p';
export type AudioQualityPreset = 'low' | 'standard' | 'high';
/** Camera frame rate; 'auto' = the video quality preset's own rate. */
export type FrameRatePreset = 'auto' | 15 | 24 | 30 | 60;
/**
 * ICE test modes – ONLY for diagnostics. "normal" is the production flow (iceTransportPolicy "all").
 *  relay-only: iceTransportPolicy "relay" → proves the TURN server works
 *  no-relay:   TURN removed → proves direct/STUN connectivity on its own
 */
export type IceTestMode = 'normal' | 'relay-only' | 'no-relay';

export interface Settings {
  videoQuality: VideoQualityPreset;
  frameRate: FrameRatePreset;
  /** Camera effect (processed on this device). */
  lowLight: boolean;
  /** Show my own camera mirrored (only my preview – others always see the real orientation). */
  mirrorSelf: boolean;
  audioQuality: AudioQualityPreset;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  iceTestMode: IceTestMode;
  audioInputId: string | null;
  videoInputId: string | null;
  audioOutputId: string | null;
}

const KEY = 'voip.settings';
const DEFAULTS: Settings = {
  videoQuality: 'auto',
  frameRate: 'auto',
  lowLight: false,
  mirrorSelf: true,
  audioQuality: 'standard',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  iceTestMode: 'normal',
  audioInputId: null,
  videoInputId: null,
  audioOutputId: null,
};

export class SettingsService {
  readonly events = new Emitter<{ change: { settings: Settings; changed: Array<keyof Settings> } }>();
  private value: Settings;

  constructor() {
    // The ICE test mode is intentionally NOT persisted – a reload always returns to "normal".
    this.value = { ...DEFAULTS, ...storage.get<Partial<Settings>>(KEY, {}), iceTestMode: 'normal' };
  }

  get(): Readonly<Settings> {
    return this.value;
  }

  update(patch: Partial<Settings>): void {
    const changed = (Object.keys(patch) as Array<keyof Settings>).filter((k) => patch[k] !== this.value[k]);
    if (!changed.length) return;
    this.value = { ...this.value, ...patch };
    const { iceTestMode: _ignored, ...persisted } = this.value;
    storage.set(KEY, persisted);
    this.events.emit('change', { settings: this.value, changed });
  }
}
