import { Emitter } from '../core/emitter';

export interface SpeakerOptions {
  /** Smoothed level below this is silence (0..1, audioLevel is linear). */
  threshold: number;
  /** A challenger must be this many times louder than the current speaker. */
  switchRatio: number;
  /** …for at least this long (continuous) before the speaker changes. */
  holdMs: number;
  /** Minimum time a speaker stays active before anyone can take over. */
  minDwellMs: number;
  /** EWMA weight of the newest sample. */
  alpha: number;
}

export const DEFAULT_SPEAKER_OPTIONS: SpeakerOptions = { threshold: 0.03, switchRatio: 1.5, holdMs: 900, minDwellMs: 2500, alpha: 0.35 };

/**
 * Hysteresis-based active-speaker selection (pure – unit tested).
 *  - smoothing (EWMA) filters clicks and single loud frames
 *  - silence never changes the speaker (the last speaker stays on screen)
 *  - a challenger must be clearly louder for `holdMs`, and the current speaker must have
 *    held the floor for `minDwellMs` → no flicker between people talking over each other
 */
export class SpeakerSelector {
  private smoothed = new Map<string, number>();
  private current: string | null = null;
  private since = 0;
  private challenger: { id: string; since: number } | null = null;
  /** When the room went from silence to speech (used while nobody holds the floor). */
  private speechSince: number | null = null;
  private readonly o: SpeakerOptions;

  constructor(opts: Partial<SpeakerOptions> = {}) {
    this.o = { ...DEFAULT_SPEAKER_OPTIONS, ...opts };
  }

  get active(): string | null {
    return this.current;
  }

  update(levels: Map<string, number>, now: number): string | null {
    for (const id of [...this.smoothed.keys()]) if (!levels.has(id)) this.smoothed.delete(id);
    if (this.current && !levels.has(this.current)) this.current = null; // speaker left
    for (const [id, level] of levels) {
      const prev = this.smoothed.get(id) ?? 0;
      this.smoothed.set(id, prev + this.o.alpha * (level - prev));
    }
    let loudest: string | null = null;
    let loudestLevel = 0;
    for (const [id, v] of this.smoothed) if (v > loudestLevel) [loudest, loudestLevel] = [id, v];

    if (!loudest || loudestLevel < this.o.threshold) {
      this.challenger = null;
      this.speechSince = null;
      return this.current;
    }
    this.speechSince ??= now;
    if (!this.current) {
      // Nobody holds the floor: sustained speech from ANYONE picks the loudest. (Waiting for one
      // specific id to lead for holdMs would never fire when several people talk equally loud.)
      if (now - this.speechSince >= this.o.holdMs) {
        this.current = loudest;
        this.since = now;
        this.challenger = null;
      }
      return this.current;
    }
    if (loudest === this.current) {
      this.challenger = null;
      return this.current;
    }
    const currentLevel = this.current ? (this.smoothed.get(this.current) ?? 0) : 0;
    if (this.current && loudestLevel < currentLevel * this.o.switchRatio) {
      this.challenger = null;
      return this.current;
    }
    if (!this.challenger || this.challenger.id !== loudest) this.challenger = { id: loudest, since: now };
    const heldLongEnough = now - this.challenger.since >= this.o.holdMs;
    const dwellOver = now - this.since >= this.o.minDwellMs;
    if (heldLongEnough && dwellOver) {
      this.current = loudest;
      this.since = now;
      this.challenger = null;
    }
    return this.current;
  }

  reset(): void {
    this.smoothed.clear();
    this.current = null;
    this.challenger = null;
    this.speechSince = null;
  }
}

/** Polls audio levels of the given sources and emits when the active speaker changes. */
export class ActiveSpeakerDetector {
  readonly events = new Emitter<{ change: string | null }>();
  private selector = new SpeakerSelector();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sources: () => Array<{ id: string; level: () => number }>,
    private readonly intervalMs = 250,
  ) {}

  get active(): string | null {
    return this.selector.active;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const levels = new Map<string, number>();
      for (const s of this.sources()) levels.set(s.id, s.level());
      const before = this.selector.active;
      const after = this.selector.update(levels, Date.now());
      if (after !== before) this.events.emit('change', after);
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.selector.reset();
    this.events.removeAllListeners();
  }
}
