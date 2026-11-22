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
  /** Call playback volume in % (100–400; above 100 = amplified via Web Audio). */
  volumeBoost: number;
  /** Phones: play call audio as media audio. */
  mediaVolume: boolean;
  /** Do not disturb: incoming calls are declined as "busy" and recorded as missed. */
  dnd: boolean;
  /** Daily quiet hours ("HH:MM") – do not disturb switches itself on in this window. */
  dndSchedule: boolean;
  dndFrom: string;
  dndTo: string;
  /** Data saver: low video quality + 15 fps (previous values are restored when it is switched off). */
  dataSaver: boolean;
  dataSaverPrev: { quality: VideoQualityPreset; fps: FrameRatePreset } | null;
}

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Is do-not-disturb on right now (manual switch or inside the daily quiet hours)? */
export function isDndActive(s: Readonly<Settings>, now = new Date()): boolean {
  if (s.dnd) return true;
  if (!s.dndSchedule) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = toMin(s.dndFrom);
  const to = toMin(s.dndTo);
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to; // window may cross midnight
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
  volumeBoost: 100,
  mediaVolume: true,
  dnd: false,
  dndSchedule: false,
  dndFrom: '22:00',
  dndTo: '07:00',
  dataSaver: false,
  dataSaverPrev: null,
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

/** Data saver: low video quality + 15 fps now, previous values restored when switched off. */
export function setDataSaver(svc: SettingsService, on: boolean): void {
  const s = svc.get();
  if (on === s.dataSaver) return;
  if (on) svc.update({ dataSaver: true, dataSaverPrev: { quality: s.videoQuality, fps: s.frameRate }, videoQuality: 'low', frameRate: 15 });
  else svc.update({ dataSaver: false, videoQuality: s.dataSaverPrev?.quality ?? 'auto', frameRate: s.dataSaverPrev?.fps ?? 'auto', dataSaverPrev: null });
}
