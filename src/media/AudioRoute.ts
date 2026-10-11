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
 */
export class AudioRoute {
  private ctx: AudioContext | null = null;
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
    if (!on) {
      this.detachAll();
      return;
    }
    this._sinkId = await this.findSpeakerOutput();
    this._mode = this._sinkId ? 'sink' : 'webaudio';
    if (this._mode === 'webaudio') {
      this.ctx ??= new AudioContext({ latencyHint: 'interactive' });
      await this.ctx.resume().catch(() => undefined);
    }
    log.info(`Loudspeaker on (${this._mode}${this._sinkId ? ` → ${this._sinkId.slice(0, 8)}` : ''})`);
  }

  /** Remote stream playing in a tile: route through Web Audio while the loudspeaker is on. */
  attach(stream: MediaStream): void {
    if (!this.ctx || this.sources.has(stream) || !stream.getAudioTracks().length) return;
    try {
      const src = this.ctx.createMediaStreamSource(stream);
      src.connect(this.ctx.destination);
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
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
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
