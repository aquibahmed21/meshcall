export interface VideoEffectOptions {
  /** Brighten + lift contrast for dark rooms. */
  lowLight: boolean;
}

const OUT_FPS = 30;
/** Processing is capped at this width (720p); larger cameras are scaled down. */
const MAX_W = 1280;

export function effectsActive(o: VideoEffectOptions): boolean {
  return o.lowLight;
}

/**
 * Camera effects pipeline (low-light boost): raw camera track → <video> → canvas filter →
 * canvas.captureStream() track. The OUTPUT track stays the same while the camera changes
 * (device switch / flip / reacquire), so peers keep one track and nothing renegotiates.
 */
export class VideoEffects {
  private opts: VideoEffectOptions = { lowLight: false };
  private source: MediaStreamTrack | null = null;
  private video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { alpha: false })!;
  private output: MediaStreamTrack | null = null;
  private running = false;
  private frameHandle = 0;

  /** Apply options; returns the output track to send, or null when no effect is active. */
  async configure(opts: VideoEffectOptions, source: MediaStreamTrack | null): Promise<MediaStreamTrack | null> {
    this.opts = { ...opts };
    if (!effectsActive(this.opts) || !source) {
      this.pause();
      return effectsActive(this.opts) ? this.output : null;
    }
    this.setSource(source);
    return this.ensureOutput();
  }

  /** The camera changed (or went away while muted). */
  setSource(track: MediaStreamTrack | null): void {
    if (track === this.source) return this.start();
    this.source = track;
    if (!track) return this.pause();
    this.video.srcObject = new MediaStream([track]);
    void this.video.play().catch(() => undefined);
    this.start();
  }

  stop(): void {
    this.pause();
    this.output?.stop();
    this.output = null;
    this.video.srcObject = null;
    this.source = null;
  }

  private ensureOutput(): MediaStreamTrack {
    if (this.output && this.output.readyState === 'live') return this.output;
    const s = this.source?.getSettings();
    this.canvas.width = s?.width ?? 640;
    this.canvas.height = s?.height ?? 480;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); // first frame: black, not transparent
    this.output = this.canvas.captureStream(OUT_FPS).getVideoTracks()[0]!;
    this.output.contentHint = 'motion';
    return this.output;
  }

  private start(): void {
    if (this.running || !this.source || !effectsActive(this.opts)) return;
    this.running = true;
    this.schedule();
  }

  private pause(): void {
    this.running = false;
    const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?(h: number): void };
    if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.frameHandle);
    else cancelAnimationFrame(this.frameHandle);
  }

  private schedule(): void {
    if (!this.running) return;
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?(cb: () => void): number };
    this.frameHandle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => this.frame()) : requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    if (!this.running) return;
    const v = this.video;
    if (v.videoWidth && v.videoHeight) {
      const scale = Math.min(1, MAX_W / v.videoWidth);
      const w = Math.round(v.videoWidth * scale);
      const h = Math.round(v.videoHeight * scale);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.ctx.filter = this.opts.lowLight ? 'brightness(1.3) contrast(1.12) saturate(1.08)' : 'none';
      this.ctx.drawImage(v, 0, 0, w, h);
      this.ctx.filter = 'none';
    }
    this.schedule();
  }
}
