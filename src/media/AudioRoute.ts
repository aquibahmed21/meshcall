import { createLogger, errorMessage } from '../core/logger';

const log = createLogger('AudioRoute');

/**
 * Earpiece ↔ loudspeaker for phones.
 *
 * While the microphone is in use, mobile browsers play call audio through the EARPIECE and
 * usually offer no "speaker" output to setSinkId(). Two ways to reach the loudspeaker:
 *  1. 'sink'     – the browser lists a loudspeaker output (label "Speaker…") → setSinkId(it)
 *  2. 'webaudio' – play the remote streams through Web Audio instead of the media elements;
 *                  Android routes that to the loudspeaker. (Echo control then depends on the
 *                  phone's own echo cancellation.)
 *
 * The same Web Audio graph also serves volume boost (> 100 %, which a media element cannot do)
 * and "media volume" playback on phones: sources → gain → limiter → output. The limiter keeps
 * an over-amplified voice loud instead of harshly clipped.
 */
export class AudioRoute {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private boost = 1;
  private ctxSink: string | null = null;
  /** Context became playable (or stopped): the owner re-renders so elements mute/unmute. */
  onStateChange: (() => void) | null = null;
  private readonly unlock = (): void => void this.ctx?.resume().catch(() => undefined);
  private sources = new Map<MediaStream, MediaStreamAudioSourceNode>();
  private _on = false;
  private _mode: 'sink' | 'webaudio' = 'webaudio';
  private _sinkId: string | null = null;

  get on(): boolean {
    return this._on;
  }

  get mode(): 'sink' | 'webaudio' {
    return this._mode;
  }

  /** Loudspeaker output id when the browser exposes one (mode 'sink'). */
  get sinkId(): string | null {
    return this._sinkId;
  }

  /** Switch the loudspeaker on/off. Must be called from a user gesture (AudioContext). */
  async set(on: boolean): Promise<void> {
    this._on = on;
    if (!on) return;
    this._sinkId = await this.findSpeakerOutput();
    this._mode = this._sinkId ? 'sink' : 'webaudio';
    if (this._mode === 'webaudio') {
      this.ensureContext();
      await this.ctx!.resume().catch(() => undefined);
    }
    log.info(`Loudspeaker on (${this._mode}${this._sinkId ? ` → ${this._sinkId.slice(0, 8)}` : ''})`);
  }

  /** Web Audio playback is running (only then may the media elements be muted). */
  get ready(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Playback volume factor, 1 = 100 % … 4 = 400 %. */
  setBoost(factor: number): void {
    this.boost = Math.min(4, Math.max(1, factor || 1));
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(this.boost, this.ctx.currentTime, 0.05);
  }

  /** Output device for the Web Audio path (Chrome 110+), mirrors the elements' setSinkId. */
  setOutput(sinkId: string | null): void {
    const ctx = this.ctx as (AudioContext & { setSinkId?(id: string): Promise<void> }) | null;
    if (!ctx?.setSinkId || sinkId === this.ctxSink) return;
    this.ctxSink = sinkId;
    void ctx.setSinkId(sinkId ?? '').catch((err: Error) => log.warn('AudioContext.setSinkId failed', err.message));
  }

  /** Create the graph (suspended until a user gesture when autoplay rules require one). */
  ensureContext(): void {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.gain = ctx.createGain();
      this.gain.gain.value = this.boost;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.knee.value = 6;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      this.gain.connect(limiter).connect(ctx.destination);
      ctx.onstatechange = () => this.onStateChange?.();
      document.addEventListener('pointerdown', this.unlock, true);
      document.addEventListener('keydown', this.unlock, true);
      this.ctx = ctx;
    }
    if (this.ctx.state === 'suspended') this.unlock();
  }

  /** Remote stream playing in a tile: route through Web Audio while the loudspeaker is on. */
  attach(stream: MediaStream): void {
    if (!this.ctx || !this.gain || this.sources.has(stream) || !stream.getAudioTracks().length) return;
    try {
      const src = this.ctx.createMediaStreamSource(stream);
      src.connect(this.gain);
      this.sources.set(stream, src);
    } catch (err) {
      log.warn('Web Audio routing failed', errorMessage(err));
    }
  }

  detach(stream: MediaStream): void {
    this.sources.get(stream)?.disconnect();
    this.sources.delete(stream);
  }

  dispose(): void {
    this.detachAll();
    document.removeEventListener('pointerdown', this.unlock, true);
    document.removeEventListener('keydown', this.unlock, true);
    if (this.ctx) this.ctx.onstatechange = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.gain = null;
    this.ctxSink = null;
    this._on = false;
  }

  private detachAll(): void {
    for (const s of this.sources.values()) s.disconnect();
    this.sources.clear();
  }

  private async findSpeakerOutput(): Promise<string | null> {
    try {
      const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput' && d.deviceId);
      const speaker = outs.find((d) => /speaker/i.test(d.label) && !/earpiece|headset|head ?phone|bluetooth|hands-?free/i.test(d.label));
      return speaker?.deviceId ?? null;
    } catch {
      return null;
    }
  }
}
