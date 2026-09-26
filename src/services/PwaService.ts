import { Emitter } from '../core/emitter';
import { createLogger, errorMessage } from '../core/logger';

const log = createLogger('PWA');
const UPDATE_CHECK_MS = 30 * 60_000;

/** Chromium's install prompt event (not in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState =
  /** Running as an installed app (standalone window / Home Screen). */
  | 'installed'
  /** Browser offered an install prompt we can trigger. */
  | 'available'
  /** iOS/iPadOS Safari: no prompt API – user must use Share → Add to Home Screen. */
  | 'ios-manual'
  /** Not installable here (unsupported browser, not a secure context, …). */
  | 'unavailable';

/**
 * App shell: Service Worker registration + updates, and "install as app".
 *
 * Updates never interrupt a call: a new worker installs in the background and WAITS; the UI
 * shows "new version available" and only reloads when the user says so.
 */
export class PwaService {
  readonly events = new Emitter<{ install: InstallState; updateReady: void; message: Record<string, unknown> }>();
  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private _registration: ServiceWorkerRegistration | null = null;
  private _install: InstallState = 'unavailable';
  private _updateReady = false;
  private reloading = false;
  private registering: Promise<ServiceWorkerRegistration | null> | null = null;

  get registration(): ServiceWorkerRegistration | null {
    return this._registration;
  }

  get installState(): InstallState {
    return this._install;
  }

  get updateReady(): boolean {
    return this._updateReady;
  }

  static isStandalone(): boolean {
    return (
      matchMedia('(display-mode: standalone)').matches ||
      matchMedia('(display-mode: minimal-ui)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  }

  static isIos(): boolean {
    const ua = navigator.userAgent;
    // iPadOS 13+ reports itself as Mac with touch
    return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  }

  /** Call as early as possible so beforeinstallprompt is not missed. */
  listenForInstall(): void {
    this.setInstall(PwaService.isStandalone() ? 'installed' : PwaService.isIos() && window.isSecureContext ? 'ios-manual' : 'unavailable');
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // show our own button instead of the mini-infobar
      this.deferredPrompt = e as BeforeInstallPromptEvent;
      log.info('App can be installed');
      this.setInstall('available');
    });
    window.addEventListener('appinstalled', () => {
      log.info('App installed');
      this.deferredPrompt = null;
      this.setInstall('installed');
    });
    matchMedia('(display-mode: standalone)').addEventListener('change', (e) => {
      if (e.matches) this.setInstall('installed');
    });
  }

  /** Chromium: show the native install dialog. Returns true if the user accepted. */
  async promptInstall(): Promise<boolean> {
    const p = this.deferredPrompt;
    if (!p) return false;
    this.deferredPrompt = null;
    try {
      await p.prompt();
      const { outcome } = await p.userChoice;
      log.info(`Install prompt: ${outcome}`);
      if (outcome === 'accepted') this.setInstall('installed');
      else this.setInstall('unavailable'); // Chrome will fire beforeinstallprompt again later
      return outcome === 'accepted';
    } catch (err) {
      log.warn('Install prompt failed', errorMessage(err));
      return false;
    }
  }

  /** Idempotent – the first call registers, later calls share the same promise. */
  register(): Promise<ServiceWorkerRegistration | null> {
    this.registering ??= this.doRegister();
    return this.registering;
  }

  private async doRegister(): Promise<ServiceWorkerRegistration | null> {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
      log.info('Service Worker unavailable (needs HTTPS or localhost)');
      return null;
    }
    const base = import.meta.env.BASE_URL; // sub-path deployments (GitHub Pages /meshcall/)
    let reg: ServiceWorkerRegistration | undefined;
    try {
      reg = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base, updateViaCache: 'none' });
      log.info('Service Worker registered');
    } catch (err) {
      // Offline start: register() must fetch sw.js and fails – the EXISTING registration still
      // works (it is what served this page from cache). Use it, and re-check once back online.
      reg = (await navigator.serviceWorker.getRegistration(base).catch(() => undefined)) ?? undefined;
      if (!reg) {
        log.warn('Service Worker registration failed', errorMessage(err));
        return null;
      }
      log.info('Offline – using the existing Service Worker registration');
      window.addEventListener('online', () => void this.checkForUpdate(), { once: true });
    }
    try {
      this._registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) this.markUpdateReady();
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        next?.addEventListener('statechange', () => {
          // "installed" while another worker controls the page = an update is waiting
          if (next.state === 'installed' && navigator.serviceWorker.controller) this.markUpdateReady();
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (this.reloading) location.reload();
      });
      navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
        if (e.data && typeof e.data === 'object') this.events.emit('message', e.data as Record<string, unknown>);
      });
      // Check for new releases periodically and whenever the app comes back to the foreground.
      setInterval(() => void this.checkForUpdate(), UPDATE_CHECK_MS);
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void this.checkForUpdate());
      return reg;
    } catch (err) {
      log.warn('Service Worker registration failed', errorMessage(err));
      return null;
    }
  }

  async checkForUpdate(): Promise<void> {
    try {
      await this._registration?.update();
    } catch {
      /* offline – try later */
    }
  }

  /** Build id of the active Service Worker (null in dev / without SW). */
  version(): Promise<string | null> {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1500);
      const onMsg = (e: MessageEvent) => {
        if (e.data?.type !== 'version') return;
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('message', onMsg);
        const id = String(e.data.buildId);
        resolve(id.startsWith('__') ? 'dev' : id);
      };
      navigator.serviceWorker.addEventListener('message', onMsg);
      sw.postMessage({ type: 'get-version' });
    });
  }

  /** Activate the waiting worker and reload once it controls the page. */
  applyUpdate(): void {
    const waiting = this._registration?.waiting;
    if (!waiting) return location.reload();
    this.reloading = true;
    waiting.postMessage({ type: 'skip-waiting' });
  }

  private markUpdateReady(): void {
    if (this._updateReady) return;
    this._updateReady = true;
    log.info('A new version is ready');
    this.events.emit('updateReady', undefined);
  }

  private setInstall(s: InstallState): void {
    if (this._install === s) return;
    this._install = s;
    this.events.emit('install', s);
  }
}
