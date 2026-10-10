import { createLogger, errorMessage } from '../core/logger';

const log = createLogger('Effects');

/** Background treatment. 'blur-*' blur the real background; the others replace it. */
export type VideoBackground = 'none' | 'blur-light' | 'blur-strong' | 'studio' | 'ocean' | 'sunset';

export interface VideoEffectOptions {
  background: VideoBackground;
  /** Brighten + lift contrast for dark rooms. */
  lowLight: boolean;
}

export const BACKGROUND_LABEL: Record<VideoBackground, string> = {
  none: 'None',
  'blur-light': 'Light blur',
  'blur-strong': 'Strong blur',
  studio: 'Studio',
  ocean: 'Ocean',
  sunset: 'Sunset',
};

const TASKS_VERSION = '1.1.0'; // keep in sync with package.json (@mediapipe/tasks-vision)
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}/wasm`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';
/** Segmentation runs on a small copy of the frame; the mask is scaled up with feathering. */
const MASK_W = 256;
const MASK_H = 144;
const OUT_FPS = 30;
/** Processing is capped at this width (720p); larger cameras are scaled down. */
const MAX_W = 1280;
/** The blurred background is rendered this many times smaller, then scaled up (cheap blur). */
const BLUR_DOWNSCALE = 8;
/** Average frame cost above which background effects are switched off (device too slow). */
const SLOW_FRAME_MS = 55;

type Segmenter = {
  segmentForVideo(frame: CanvasImageSource, ts: number): { confidenceMasks?: Array<{ getAsFloat32Array(): Float32Array; close(): void }>; close?(): void };
  close(): void;
};

export function effectsActive(o: VideoEffectOptions): boolean {
  return o.background !== 'none' || o.lowLight;
}

const needsMask = (b: VideoBackground) => b !== 'none';

/**
 * Camera effects pipeline: raw camera track → <video> → canvas (segmentation + compositing) →
 * canvas.captureStream() track. The OUTPUT track stays the same while the camera changes
 * (device switch / flip / reacquire), so peers keep one track and nothing renegotiates.
 *
 * Everything runs on this device; the segmentation model is downloaded once, only when a
 * background effect is first used.
 */
export class VideoEffects {
  /** Called when background effects had to be turned off (load failure / too slow). */
  onDisabled: ((reason: string) => void) | null = null;

  private opts: VideoEffectOptions = { background: 'none', lowLight: false };
  private source: MediaStreamTrack | null = null;
  private video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { alpha: false })!;
  private small = Object.assign(document.createElement('canvas'), { width: MASK_W, height: MASK_H });
  private smallCtx = this.small.getContext('2d', { willReadFrequently: true })!;
  private mask = Object.assign(document.createElement('canvas'), { width: MASK_W, height: MASK_H });
  private maskCtx = this.mask.getContext('2d')!;
  private maskData = this.maskCtx.createImageData(MASK_W, MASK_H);
  private layer = document.createElement('canvas');
  private layerCtx = this.layer.getContext('2d')!;
  /** Feathered copy of the mask (blurred at mask size – cheap). */
  private soft = Object.assign(document.createElement('canvas'), { width: MASK_W, height: MASK_H });
  private softCtx = this.soft.getContext('2d')!;
  private bg = document.createElement('canvas');
  private bgCtx = this.bg.getContext('2d')!;
  private frameNo = 0;
  private delegate: 'GPU' | 'CPU' = 'GPU';
  private output: MediaStreamTrack | null = null;
  private segmenter: Segmenter | null = null;
  private loading: Promise<Segmenter | null> | null = null;
  private running = false;
  private frameHandle = 0;
  private costs: number[] = [];

  /** The processed track (created on first use, reused for the whole session). */
  get track(): MediaStreamTrack | null {
    return this.output;
  }

  get options(): VideoEffectOptions {
    return this.opts;
  }

  /** Apply options; returns the output track to send, or null when no effect is active. */
  async configure(opts: VideoEffectOptions, source: MediaStreamTrack | null): Promise<MediaStreamTrack | null> {
    this.opts = { ...opts };
    if (!effectsActive(this.opts) || !source) {
      this.pause();
      return effectsActive(this.opts) ? this.output : null;
    }
    if (needsMask(this.opts.background)) void this.loadSegmenter();
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
    this.segmenter?.close();
    this.segmenter = null;
    this.loading = null;
  }

  // ── internals ────────────────────────────────────────────────────────────

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
    // One processed frame per camera frame where supported; animation frames elsewhere.
    this.frameHandle = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(() => this.frame()) : requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    if (!this.running) return;
    const t0 = performance.now();
    try {
      this.draw();
    } catch (err) {
      log.warn('Effects frame failed', errorMessage(err));
    }
    this.watchCost(performance.now() - t0);
    this.schedule();
  }

  private draw(): void {
    const v = this.video;
    if (!v.videoWidth || !v.videoHeight) return;
    const scale = Math.min(1, MAX_W / v.videoWidth);
    const w = Math.round(v.videoWidth * scale);
    const hgt = Math.round(v.videoHeight * scale);
    if (this.canvas.width !== w || this.canvas.height !== hgt) {
      this.canvas.width = this.layer.width = w;
      this.canvas.height = this.layer.height = hgt;
    }
    const ctx = this.ctx;
    const tone = this.opts.lowLight ? 'brightness(1.3) contrast(1.12) saturate(1.08)' : 'none';
    const seg = needsMask(this.opts.background) ? this.segmenter : null;
    if (!seg) {
      // Low-light only (or the model is still loading): just the tone filter.
      ctx.filter = tone;
      ctx.drawImage(v, 0, 0, w, hgt);
      ctx.filter = 'none';
      return;
    }
    // 1) person mask on a small frame (every other frame – people move slower than 15 Hz)
    if (this.frameNo++ % 2 === 0) {
      this.smallCtx.drawImage(v, 0, 0, MASK_W, MASK_H);
      const res = seg.segmentForVideo(this.small, performance.now());
      const conf = res.confidenceMasks?.[0];
      if (conf) {
        const values = conf.getAsFloat32Array();
        const px = this.maskData.data;
        for (let i = 0, j = 3; i < values.length; i++, j += 4) px[j] = values[i]! * 255;
        this.maskCtx.putImageData(this.maskData, 0, 0);
        // Feather the edge at mask resolution; upscaling smooths it further.
        this.softCtx.globalCompositeOperation = 'copy';
        this.softCtx.filter = 'blur(1.5px)';
        this.softCtx.drawImage(this.mask, 0, 0);
        this.softCtx.filter = 'none';
      }
      res.confidenceMasks?.forEach((m) => m.close());
      res.close?.();
    }
    // 2) person layer = camera frame clipped by the (feathered, upscaled) mask
    const lc = this.layerCtx;
    lc.globalCompositeOperation = 'copy';
    lc.imageSmoothingQuality = 'high';
    lc.drawImage(this.soft, 0, 0, w, hgt);
    lc.filter = tone;
    lc.globalCompositeOperation = 'source-in';
    lc.drawImage(v, 0, 0, w, hgt);
    lc.filter = 'none';
    lc.globalCompositeOperation = 'source-over';
    // 3) background, then the person on top
    this.drawBackground(ctx, v, w, hgt, tone);
    ctx.drawImage(this.layer, 0, 0);
  }

  private drawBackground(ctx: CanvasRenderingContext2D, v: HTMLVideoElement, w: number, h: number, tone: string): void {
    const b = this.opts.background;
    if (b === 'blur-light' || b === 'blur-strong') {
      // Blur a tiny copy and scale it up: far cheaper than a full-resolution blur filter.
      const down = b === 'blur-light' ? BLUR_DOWNSCALE / 2 : BLUR_DOWNSCALE;
      const sw = Math.max(16, Math.round(w / down));
      const sh = Math.max(9, Math.round(h / down));
      if (this.bg.width !== sw || this.bg.height !== sh) {
        this.bg.width = sw;
        this.bg.height = sh;
      }
      this.bgCtx.filter = `${tone === 'none' ? '' : tone + ' '}blur(${b === 'blur-light' ? 1.5 : 2.5}px)`;
      this.bgCtx.drawImage(v, -2, -2, sw + 4, sh + 4); // overscan hides the blurred edge
      this.bgCtx.filter = 'none';
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.bg, 0, 0, w, h);
      return;
    }
    const g = ctx.createLinearGradient(0, 0, w, h);
    const stops: Record<string, [string, string, string]> = {
      studio: ['#2b2f36', '#3c4350', '#1b1e23'],
      ocean: ['#0f4c75', '#1b6ca8', '#0a2342'],
      sunset: ['#ff7e5f', '#c0476d', '#2e1f4f'],
    };
    const [a, m, z] = stops[b] ?? stops.studio!;
    g.addColorStop(0, a);
    g.addColorStop(0.55, m);
    g.addColorStop(1, z);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  private watchCost(ms: number): void {
    if (!needsMask(this.opts.background) || !this.segmenter) return;
    this.costs.push(ms);
    if (this.costs.length < 45) return;
    const avg = this.costs.reduce((s, x) => s + x, 0) / this.costs.length;
    this.costs = [];
    if (avg > SLOW_FRAME_MS && this.delegate === 'GPU') {
      // Some GPUs (or software GL) are slower than WebAssembly for this tiny model: retry on CPU.
      log.warn(`Background effect slow on GPU (${avg.toFixed(0)} ms/frame) – trying CPU`);
      this.delegate = 'CPU';
      this.segmenter?.close();
      this.segmenter = null;
      this.loading = null;
      void this.loadSegmenter();
      return;
    }
    if (avg > SLOW_FRAME_MS) {
      log.warn(`Background effect too slow (${avg.toFixed(0)} ms/frame) – turning it off`);
      this.opts.background = 'none';
      this.onDisabled?.('Background effects were turned off – this device is too slow for them');
    }
  }

  private loadSegmenter(): Promise<Segmenter | null> {
    this.loading ??= (async () => {
      try {
        const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
        const files = await FilesetResolver.forVisionTasks(WASM_URL);
        const create = (delegate: 'GPU' | 'CPU') =>
          ImageSegmenter.createFromOptions(files, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate },
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          });
        const seg = (await (this.delegate === 'GPU' ? create('GPU').catch(() => ((this.delegate = 'CPU'), create('CPU'))) : create('CPU'))) as unknown as Segmenter;
        log.info(`Background segmentation ready (${this.delegate})`);
        this.segmenter = seg;
        return seg;
      } catch (err) {
        log.warn('Background effects unavailable', errorMessage(err));
        this.loading = null;
        if (needsMask(this.opts.background)) {
          this.opts.background = 'none';
          this.onDisabled?.('Background effects could not be loaded (check your connection)');
        }
        return null;
      }
    })();
    return this.loading;
  }
}
