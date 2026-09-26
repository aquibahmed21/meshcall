import { Emitter } from '../core/emitter';
import { createLogger } from '../core/logger';

const log = createLogger('Network');

export type NetworkChangeReason = 'online' | 'offline' | 'connection-change' | 'wake' | 'resume';

export interface NetworkInfo {
  online: boolean;
  type?: string;
  effectiveType?: string;
  downlinkMbps?: number;
  rttMs?: number;
  saveData?: boolean;
}

interface NetworkInformationLike extends EventTarget {
  type?: string;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

const COALESCE_MS = 1_000;
const SLEEP_TICK_MS = 5_000;
const SLEEP_GAP_MS = 15_000;
const LONG_HIDDEN_MS = 30_000;

/**
 * Observes the local network environment and emits *hints* that existing WebRTC paths may
 * be stale. navigator.onLine === true does NOT mean WebRTC works – it is only a trigger for
 * re-validation (ICE restart), never a success signal.
 *
 * Sources: online/offline events, Network Information API (type/effectiveType changes),
 * sleep/wake detection via timer drift, long background → foreground, bfcache restore.
 */
export class NetworkMonitor {
  readonly events = new Emitter<{
    change: { reason: NetworkChangeReason; info: NetworkInfo };
    info: NetworkInfo;
  }>();

  private lastTick = Date.now();
  private hiddenAt: number | null = null;
  private pending: NetworkChangeReason | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private lastConn = '';
  private readonly conn: NetworkInformationLike | undefined = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;

  private readonly onOnline = () => this.signal('online');
  private readonly onOffline = () => this.signal('offline');
  private readonly onConnChange = () => {
    const sig = `${this.conn?.type ?? ''}/${this.conn?.effectiveType ?? ''}`;
    this.events.emit('info', this.info);
    if (sig !== this.lastConn) {
      log.info(`Connection changed ${this.lastConn || '?'} → ${sig}`);
      this.lastConn = sig;
      this.signal('connection-change');
    }
  };
  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = Date.now();
    } else if (this.hiddenAt !== null) {
      const hiddenFor = Date.now() - this.hiddenAt;
      this.hiddenAt = null;
      if (hiddenFor > LONG_HIDDEN_MS) this.signal('resume');
    }
  };
  private readonly onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) this.signal('resume');
  };

  start(): void {
    this.lastConn = `${this.conn?.type ?? ''}/${this.conn?.effectiveType ?? ''}`;
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('pageshow', this.onPageShow);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.conn?.addEventListener('change', this.onConnChange);
    this.tick = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastTick;
      this.lastTick = now;
      if (gap > SLEEP_GAP_MS) {
        log.info(`Timer gap of ${Math.round(gap / 1000)} s – device probably slept`);
        this.signal('wake');
      }
    }, SLEEP_TICK_MS);
  }

  stop(): void {
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('pageshow', this.onPageShow);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.conn?.removeEventListener('change', this.onConnChange);
    if (this.tick) clearInterval(this.tick);
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
  }

  get online(): boolean {
    return navigator.onLine;
  }

  get info(): NetworkInfo {
    return {
      online: navigator.onLine,
      type: this.conn?.type,
      effectiveType: this.conn?.effectiveType,
      downlinkMbps: this.conn?.downlink,
      rttMs: this.conn?.rtt,
      saveData: this.conn?.saveData,
    };
  }

  /** Coalesce bursts (e.g. offline→online→change within a second) into one event. */
  private signal(reason: NetworkChangeReason): void {
    const priority: Record<NetworkChangeReason, number> = { offline: 0, resume: 1, 'connection-change': 2, wake: 3, online: 4 };
    if (reason === 'offline') log.warn('Browser reports offline');
    if (!this.pending || priority[reason] > priority[this.pending] || !navigator.onLine) this.pending = reason;
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      const r = navigator.onLine ? (this.pending === 'offline' ? 'online' : this.pending!) : 'offline';
      this.pending = null;
      log.info(`Network event: ${r}`);
      this.events.emit('change', { reason: r, info: this.info });
    }, COALESCE_MS);
  }
}
