import type { NetworkQuality } from '../types/state';

export interface LadderOptions {
  levels: number[]; // bitrate per level, ascending
  start: number;
  downSamples: number; // consecutive bad samples before stepping down
  upSamples: number; // consecutive good samples before stepping up
  minDwellMs: number; // min time at a level before stepping up
  upCooldownBaseMs: number; // base cooldown after a down-step
  maxUpCooldownMs: number;
  oscillationWindowMs: number;
}

export const DEFAULT_LADDER_OPTIONS: Omit<LadderOptions, 'levels' | 'start'> = {
  downSamples: 2,
  upSamples: 5,
  minDwellMs: 8_000,
  upCooldownBaseMs: 10_000,
  maxUpCooldownMs: 120_000,
  oscillationWindowMs: 20_000,
};

/**
 * Hysteresis controller for adaptive video quality.
 *  - down fast (2 bad samples), up slow (5 good samples + dwell + cooldown)
 *  - bandwidth headroom required before going up (1.3× the next level's bitrate)
 *  - if an up-step is followed quickly by a down-step (oscillation) the up-cooldown doubles
 */
export class AdaptiveLadder {
  private _level: number;
  private bad = 0;
  private good = 0;
  private lastChange = 0;
  private lastUp = -Infinity;
  private cooldown: number;
  private opts: LadderOptions;

  constructor(opts: Partial<LadderOptions> & Pick<LadderOptions, 'levels' | 'start'>, now = Date.now()) {
    this.opts = { ...DEFAULT_LADDER_OPTIONS, ...opts };
    this._level = Math.max(0, Math.min(opts.start, opts.levels.length - 1));
    this.cooldown = this.opts.upCooldownBaseMs;
    this.lastChange = now;
  }

  get level(): number {
    return this._level;
  }

  /** Returns the new level if it changed, else null. */
  update(quality: NetworkQuality, availableOutgoingBps: number | undefined, now = Date.now()): number | null {
    if (quality === 'unknown') return null;
    const { levels } = this.opts;
    const current = levels[this._level]!;
    const isBad = quality === 'poor' || quality === 'critical' || (availableOutgoingBps !== undefined && availableOutgoingBps < current * 0.8);
    const next = levels[this._level + 1];
    const headroom = next === undefined || availableOutgoingBps === undefined || availableOutgoingBps > next * 1.3;
    const isGood = (quality === 'excellent' || quality === 'good') && headroom;

    if (isBad) {
      this.good = 0;
      this.bad++;
      if (this.bad >= this.opts.downSamples && this._level > 0) {
        const steps = quality === 'critical' ? 2 : 1;
        if (now - this.lastUp < this.opts.oscillationWindowMs) {
          this.cooldown = Math.min(this.opts.maxUpCooldownMs, this.cooldown * 2);
        }
        return this.set(Math.max(0, this._level - steps), now);
      }
      return null;
    }
    this.bad = 0;
    if (!isGood) {
      this.good = 0;
      return null;
    }
    this.good++;
    if (now - this.lastChange > 60_000) this.cooldown = this.opts.upCooldownBaseMs; // long stability resets backoff
    if (
      this.good >= this.opts.upSamples &&
      this._level < levels.length - 1 &&
      now - this.lastChange >= Math.max(this.opts.minDwellMs, this.cooldown)
    ) {
      this.lastUp = now;
      return this.set(this._level + 1, now);
    }
    return null;
  }

  private set(level: number, now: number): number | null {
    this.bad = 0;
    this.good = 0;
    if (level === this._level) return null;
    this._level = level;
    this.lastChange = now;
    return level;
  }
}
