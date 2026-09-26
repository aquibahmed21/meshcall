import { createLogger } from '../core/logger';

const log = createLogger('Ringtone');

/** Generated ring / ringback tones via WebAudio (no audio assets). */
export class Ringtone {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(kind: 'incoming' | 'outgoing'): void {
    this.stop();
    try {
      this.ctx = new AudioContext();
      void this.ctx.resume().catch(() => undefined);
    } catch (err) {
      log.debug('AudioContext unavailable', err);
      return;
    }
    const play = () => {
      const ctx = this.ctx;
      if (!ctx || ctx.state === 'closed') return;
      const freqs = kind === 'incoming' ? [880, 660] : [440, 480];
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(kind === 'incoming' ? 0.12 : 0.06, now + 0.05);
      gain.gain.setValueAtTime(kind === 'incoming' ? 0.12 : 0.06, now + 1.2);
      gain.gain.linearRampToValueAtTime(0, now + 1.3);
      gain.connect(ctx.destination);
      for (const f of freqs) {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        o.connect(gain);
        o.start(now);
        o.stop(now + 1.35);
      }
    };
    play();
    this.timer = setInterval(play, kind === 'incoming' ? 2500 : 4000);
    if ('vibrate' in navigator && kind === 'incoming') {
      try {
        navigator.vibrate([400, 200, 400]);
      } catch {
        /* ignore */
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.ctx) void this.ctx.close().catch(() => undefined);
    this.ctx = null;
  }
}
