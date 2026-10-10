import { VideoEffects, effectsActive } from './VideoEffects';
import { Emitter } from '../core/emitter';
import { createLogger, errorMessage } from '../core/logger';
import type { SettingsService, VideoQualityPreset } from '../services/SettingsService';
import type { MediaKind } from '../types/signaling';
import type { LocalMediaSource } from '../webrtc/PeerSession';
import { AUTO_CAPTURE, VIDEO_PRESETS, type VideoPreset } from './QualityPresets';

const log = createLogger('Media');

export interface MediaSnapshot {
  hasAudio: boolean;
  hasVideo: boolean;
  audioMuted: boolean;
  videoMuted: boolean;
  screenSharing: boolean;
  audioError?: string;
  videoError?: string;
  audioDeviceId?: string;
  videoDeviceId?: string;
  facingMode?: string;
}

export interface AcquireResult {
  audio: boolean;
  video: boolean;
  warnings: string[];
}

/** Maps getUserMedia errors to user-facing text. */
export function describeMediaError(err: unknown, kind: 'microphone' | 'camera'): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return `${kind === 'camera' ? 'Camera' : 'Microphone'} permission denied`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${kind} found`;
    case 'NotReadableError':
    case 'AbortError':
      return `${kind === 'camera' ? 'Camera' : 'Microphone'} is in use by another application or unavailable`;
    default:
      return `${kind === 'camera' ? 'Camera' : 'Microphone'} unavailable (${errorMessage(err)})`;
  }
}

/**
 * Owns local capture. Peer connections never own tracks – they ask `getSendTrack()` and are told
 * about replacements via the `track` event (→ RTCRtpSender.replaceTrack, no renegotiation).
 *
 *  mute         → track.enabled = false (sender keeps running, sends silence)
 *  camera off   → camera track STOPPED (hardware light off) and sender track set to null
 *  device swap  → new track, replaceTrack, old track stopped
 *  screen share → display track replaces the camera on the video sender
 */
export class MediaManager implements LocalMediaSource {
  readonly stream = new MediaStream();
  readonly events = new Emitter<{
    state: MediaSnapshot;
    track: { kind: MediaKind; track: MediaStreamTrack | null };
    warning: string;
  }>();

  private audioTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  /** Camera effects; when active, `effectTrack` replaces the raw camera everywhere. */
  readonly effects = new VideoEffects();
  private effectTrack: MediaStreamTrack | null = null;
  private audioMuted = false;
  private videoMuted = false;
  private wantAudio = false;
  private audioError?: string;
  private videoError?: string;
  private facingMode: 'user' | 'environment' = 'user';
  private busy: Promise<unknown> = Promise.resolve();
  /** Bumped by release(); captures that resolve after a release are stopped immediately. */
  private generation = 0;

  constructor(private readonly settings: SettingsService) {
  }

  /** What the camera contributes right now: the processed track while effects are on. */
  private cameraOut(): MediaStreamTrack | null {
    if (!this.cameraTrack) return null;
    return this.effectTrack ?? this.cameraTrack;
  }

  /** Low-light setting changed (or the camera came back): rebuild the pipeline. */
  applyEffects(): Promise<void> {
    return this.exclusive(async () => {
      const s = this.settings.get();
      const opts = { lowLight: !!s.lowLight };
      const before = this.cameraOut();
      this.effectTrack = effectsActive(opts) && this.cameraTrack ? await this.effects.configure(opts, this.cameraTrack) : null;
      if (!effectsActive(opts)) await this.effects.configure(opts, null);
      const out = this.cameraOut();
      if (out !== before && !this.screenTrack && !this.videoMuted) {
        this.replaceInPreview('video', out);
        this.events.emit('track', { kind: 'video', track: out });
      }
    });
  }

  get state(): MediaSnapshot {
    return {
      hasAudio: !!this.audioTrack,
      hasVideo: !!(this.screenTrack ?? this.cameraTrack),
      audioMuted: this.audioMuted,
      videoMuted: this.videoMuted || !this.cameraTrack,
      screenSharing: !!this.screenTrack,
      audioError: this.audioError,
      videoError: this.videoError,
      audioDeviceId: this.audioTrack?.getSettings().deviceId,
      videoDeviceId: this.cameraTrack?.getSettings().deviceId,
      facingMode: this.facingMode,
    };
  }

  get isActive(): boolean {
    return !!(this.audioTrack || this.cameraTrack || this.screenTrack);
  }

  getSendTrack(kind: MediaKind): MediaStreamTrack | null {
    if (kind === 'audio') return this.audioTrack;
    return this.screenTrack ?? (this.videoMuted ? null : this.cameraOut());
  }

  captureHeight(): number | undefined {
    return this.cameraTrack?.getSettings().height;
  }

  static screenShareSupported(): boolean {
    return !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;
  }

  /**
   * Acquire microphone and/or camera. Never throws: partial failures degrade gracefully
   * (e.g. camera denied → audio-only, both denied → receive-only) and are reported as warnings.
   */
  acquire(opts: { audio: boolean; video: boolean }): Promise<AcquireResult> {
    return this.exclusive(async () => {
      this.wantAudio = opts.audio;
      this.audioMuted = false;
      this.videoMuted = !opts.video;
      this.audioError = this.videoError = undefined;
      const warnings: string[] = [];
      if (!navigator.mediaDevices?.getUserMedia) {
        const w = 'Media capture unsupported (needs HTTPS or localhost)';
        this.audioError = this.videoError = w;
        this.emitState();
        return { audio: false, video: false, warnings: [w] };
      }
      const gen = this.generation;
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: opts.audio ? this.audioConstraints() : false,
          video: opts.video ? this.videoConstraints(this.settings.get().videoQuality) : false,
        });
        if (gen !== this.generation) {
          // The call ended while the permission prompt was open – do not leave the camera on.
          s.getTracks().forEach((t) => t.stop());
          return { audio: false, video: false, warnings: [] };
        }
        if (opts.audio) this.setAudioTrack(s.getAudioTracks()[0] ?? null);
        if (opts.video) this.setCameraTrack(s.getVideoTracks()[0] ?? null);
      } catch (err) {
        log.warn('Combined getUserMedia failed – trying devices individually', errorMessage(err));
        if (opts.audio) {
          try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
            if (gen !== this.generation) {
              s.getTracks().forEach((t) => t.stop());
              return { audio: false, video: false, warnings: [] };
            }
            this.setAudioTrack(s.getAudioTracks()[0] ?? null);
          } catch (e) {
            this.audioError = describeMediaError(e, 'microphone');
            warnings.push(this.audioError);
          }
        }
        if (opts.video) {
          try {
            const s = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints(this.settings.get().videoQuality) });
            if (gen !== this.generation) {
              s.getTracks().forEach((t) => t.stop());
              return { audio: false, video: false, warnings: [] };
            }
            this.setCameraTrack(s.getVideoTracks()[0] ?? null);
          } catch (e) {
            this.videoError = describeMediaError(e, 'camera');
            this.videoMuted = true;
            warnings.push(this.videoError);
          }
        }
      }
      for (const w of warnings) log.warn(w);
      this.emitState();
      return { audio: !!this.audioTrack, video: !!this.cameraTrack, warnings };
    });
  }

  /** Stop every local track (camera/mic lights off). */
  release(): void {
    this.generation++;
    for (const t of [this.audioTrack, this.cameraTrack, this.screenTrack]) this.stopTrack(t);
    this.audioTrack = this.cameraTrack = this.screenTrack = null;
    this.effects.stop();
    this.effectTrack = null;
    this.wantAudio = false;
    this.audioMuted = this.videoMuted = false;
    this.audioError = this.videoError = undefined;
    for (const t of this.stream.getTracks()) this.stream.removeTrack(t);
    log.info('Local media released');
    this.emitState();
  }

  setAudioMuted(muted: boolean): void {
    this.audioMuted = muted;
    if (this.audioTrack) this.audioTrack.enabled = !muted;
    log.info(muted ? 'Microphone muted' : 'Microphone unmuted');
    this.emitState();
  }

  setCameraEnabled(enabled: boolean): Promise<void> {
    return this.exclusive(async () => {
      if (!enabled) {
        this.videoMuted = true;
        const old = this.cameraTrack;
        this.cameraTrack = null;
        for (const t of this.stream.getVideoTracks()) if (t !== this.screenTrack) this.stream.removeTrack(t);
        this.stopTrack(old);
        this.effects.setSource(null); // camera off → stop processing
        if (!this.screenTrack) this.events.emit('track', { kind: 'video', track: null });
        this.emitState();
        return;
      }
      const gen = this.generation;
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: this.videoConstraints(this.settings.get().videoQuality) });
        if (gen !== this.generation) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        this.videoError = undefined;
        this.videoMuted = false;
        this.setCameraTrack(s.getVideoTracks()[0] ?? null);
      } catch (err) {
        this.videoError = describeMediaError(err, 'camera');
        this.events.emit('warning', this.videoError);
      }
      this.emitState();
    });
  }

  /** Switch mic or camera. The peer connections keep running (replaceTrack). */
  switchDevice(kind: 'audioinput' | 'videoinput', deviceId: string | null): Promise<void> {
    return this.exclusive(async () => {
      if (kind === 'audioinput') {
        this.settings.update({ audioInputId: deviceId });
        if (!this.audioTrack && !this.wantAudio) return;
        await this.reacquireAudio();
      } else {
        this.settings.update({ videoInputId: deviceId });
        if (!this.cameraTrack) return;
        await this.reacquireCamera();
      }
    });
  }

  /** Mobile convenience: toggle front/back camera. */
  flipCamera(): Promise<void> {
    return this.exclusive(async () => {
      this.facingMode = this.facingMode === 'user' ? 'environment' : 'user';
      this.settings.update({ videoInputId: null });
      if (this.cameraTrack) await this.reacquireCamera();
    });
  }

  applyAudioProcessing(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.audioTrack) return;
      const s = this.settings.get();
      try {
        await this.audioTrack.applyConstraints({
          echoCancellation: s.echoCancellation,
          noiseSuppression: s.noiseSuppression,
          autoGainControl: s.autoGainControl,
        });
      } catch (err) {
        log.warn('applyConstraints(audio) failed – reacquiring microphone', errorMessage(err));
        await this.reacquireAudio();
      }
    });
  }

  /** Adjust capture resolution; the encoder side (bitrate/scale) is handled by AdaptiveQualityManager. */
  applyVideoQuality(preset: VideoQualityPreset): Promise<void> {
    return this.exclusive(async () => {
      if (!this.cameraTrack) return;
      const p = this.capturePreset(preset);
      try {
        const fps = this.captureFps(p.frameRate);
        await this.cameraTrack.applyConstraints({ width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: fps, max: Math.max(30, fps) } });
        const st = this.cameraTrack.getSettings();
        log.info(`Camera capture now ${st.width}×${st.height}@${Math.round(st.frameRate ?? 0)}`);
      } catch (err) {
        log.warn(`Camera cannot capture ${preset}`, errorMessage(err));
      }
    });
  }

  startScreenShare(): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.screenTrack) return true;
      try {
        const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
        const track = s.getVideoTracks()[0];
        if (!track) return false;
        track.contentHint = 'detail';
        this.screenTrack = track;
        track.addEventListener('ended', () => void this.stopScreenShare(), { once: true });
        this.replaceInPreview('video', track);
        this.events.emit('track', { kind: 'video', track });
        log.info('Screen sharing started');
        this.emitState();
        return true;
      } catch (err) {
        if ((err as Error).name !== 'NotAllowedError') this.events.emit('warning', `Screen share failed: ${errorMessage(err)}`);
        return false;
      }
    });
  }

  stopScreenShare(): Promise<void> {
    return this.exclusive(async () => {
      const t = this.screenTrack;
      if (!t) return;
      this.screenTrack = null;
      this.stopTrack(t);
      this.stream.removeTrack(t);
      const cam = this.videoMuted ? null : this.cameraOut();
      if (cam) this.stream.addTrack(cam);
      this.events.emit('track', { kind: 'video', track: cam });
      log.info('Screen sharing stopped');
      this.emitState();
    });
  }

  // ── internals ───────────────────────────────────────────────────────────

  private audioConstraints(): MediaTrackConstraints {
    const s = this.settings.get();
    return {
      deviceId: s.audioInputId ? { ideal: s.audioInputId } : undefined,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
      channelCount: { ideal: 1 },
    };
  }

  private capturePreset(q: VideoQualityPreset): VideoPreset {
    return q === 'auto' ? AUTO_CAPTURE : VIDEO_PRESETS[q];
  }

  private videoConstraints(q: VideoQualityPreset): MediaTrackConstraints {
    const s = this.settings.get();
    const p = this.capturePreset(q);
    return {
      // `ideal` so a removed/unknown device falls back to the default instead of failing
      deviceId: s.videoInputId ? { ideal: s.videoInputId } : undefined,
      facingMode: s.videoInputId ? undefined : { ideal: this.facingMode },
      width: { ideal: p.width },
      height: { ideal: p.height },
      frameRate: { ideal: this.captureFps(p.frameRate), max: Math.max(30, this.captureFps(p.frameRate)) },
    };
  }

  /** Frame rate to capture: the user's choice, or the quality preset's rate for 'auto'. */
  private captureFps(presetFps: number): number {
    const f = this.settings.get().frameRate;
    return f === 'auto' || !f ? presetFps : f;
  }

  private async reacquireAudio(): Promise<void> {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints() });
      this.audioError = undefined;
      this.setAudioTrack(s.getAudioTracks()[0] ?? null);
    } catch (err) {
      this.audioError = describeMediaError(err, 'microphone');
      this.events.emit('warning', this.audioError);
    }
    this.emitState();
  }

  private async reacquireCamera(): Promise<void> {
    const opts = this.videoConstraints(this.settings.get().videoQuality);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: opts });
      this.videoError = undefined;
      this.setCameraTrack(s.getVideoTracks()[0] ?? null);
    } catch (err) {
      // Many phones cannot open two cameras at once → release the old one first and retry.
      if ((err as Error).name === 'NotReadableError' && this.cameraTrack) {
        this.stopTrack(this.cameraTrack);
        try {
          const s = await navigator.mediaDevices.getUserMedia({ video: opts });
          this.setCameraTrack(s.getVideoTracks()[0] ?? null);
          this.emitState();
          return;
        } catch (e) {
          err = e;
        }
      }
      this.videoError = describeMediaError(err, 'camera');
      this.events.emit('warning', this.videoError);
    }
    this.emitState();
  }

  private setAudioTrack(track: MediaStreamTrack | null): void {
    const old = this.audioTrack;
    this.audioTrack = track;
    if (track) {
      track.enabled = !this.audioMuted;
      track.addEventListener('ended', () => this.onTrackEnded(track), { once: true });
    }
    this.replaceInPreview('audio', track);
    this.events.emit('track', { kind: 'audio', track });
    if (old && old !== track) this.stopTrack(old);
  }

  private setCameraTrack(track: MediaStreamTrack | null): void {
    const old = this.cameraTrack;
    this.cameraTrack = track;
    if (track) {
      track.contentHint = 'motion';
      track.addEventListener('ended', () => this.onTrackEnded(track), { once: true });
    }
    // Effects keep ONE output track; a new camera just becomes its source.
    const s = this.settings.get();
    if (track && effectsActive({ lowLight: !!s.lowLight })) {
      if (this.effectTrack) this.effects.setSource(track);
      else void this.applyEffects(); // first camera of the session → build the pipeline
    }
    if (!this.screenTrack) {
      const out = this.videoMuted ? null : this.cameraOut();
      this.replaceInPreview('video', out);
      this.events.emit('track', { kind: 'video', track: out });
    }
    if (old && old !== track) this.stopTrack(old);
  }

  /** Device unplugged / revoked permission / OS took it → fall back to the default device. */
  private onTrackEnded(track: MediaStreamTrack): void {
    if (track.kind === 'audio' && track === this.audioTrack) {
      log.warn('Microphone track ended (device removed?) – switching to default microphone');
      this.events.emit('warning', 'Microphone disconnected – switching to default');
      this.settings.update({ audioInputId: null });
      void this.exclusive(() => this.reacquireAudio());
    } else if (track.kind === 'video' && track === this.cameraTrack) {
      log.warn('Camera track ended (device removed?) – switching to default camera');
      this.events.emit('warning', 'Camera disconnected – switching to default');
      this.settings.update({ videoInputId: null });
      void this.exclusive(() => this.reacquireCamera());
    }
  }

  private replaceInPreview(kind: MediaKind, track: MediaStreamTrack | null): void {
    for (const t of this.stream.getTracks()) if (t.kind === kind && t !== track) this.stream.removeTrack(t);
    if (track && !this.stream.getTrackById(track.id)) this.stream.addTrack(track);
  }

  private stopTrack(t: MediaStreamTrack | null): void {
    if (!t) return;
    try {
      t.stop();
    } catch {
      /* ignore */
    }
  }

  /** Serialise capture operations – concurrent getUserMedia calls race on mobile. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  private emitState(): void {
    this.events.emit('state', this.state);
  }
}
