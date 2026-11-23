import { App } from '@capacitor/app';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Emitter } from '../core/emitter';
import { createLogger, errorMessage } from '../core/logger';
import { storage } from '../core/storage';
import { isLaunchContext, type LaunchContext } from '../push/payloads';

const log = createLogger('Native');

/** What the Android service's hidden WebView exposes (see HeadlessHost.java). */
interface HeadlessBridge {
  show(tag: string, title: string, body: string, kind: string, data: string, timeoutMs: number): void;
  cancel(tag: string): void;
}
const headlessBridge = (window as unknown as { MeshCallHeadless?: HeadlessBridge }).MeshCallHeadless;

/**
 * Headless = the Android service runs the app without a screen (after "Close all"). It only keeps
 * signaling alive and shows native notifications; the user opens the real app by tapping one.
 */
export const isHeadless = !!headlessBridge;

/** True inside the Android app (Capacitor shell or its headless service); false in a browser/PWA. */
export const isNative = Capacitor.isNativePlatform() || isHeadless;

export interface AudioOutput {
  id: number;
  type: string;
  name: string;
}

export type PermState = 'granted' | 'denied' | 'prompt';
export interface PermissionStatus {
  microphone: PermState;
  camera: PermState;
  bluetooth: PermState;
  contacts: PermState;
  notifications: PermState;
  fullScreen: PermState;
  battery: PermState;
}
const ALL_GRANTED: PermissionStatus = { microphone: 'granted', camera: 'granted', bluetooth: 'granted', contacts: 'granted', notifications: 'granted', fullScreen: 'granted', battery: 'granted' };

interface NativeBridge {
  startService(o: { inCall: boolean; video: boolean; text?: string }): Promise<void>;
  stopService(): Promise<void>;
  show(o: { tag: string; title: string; body: string; kind: 'call' | 'live' | 'message' | 'missed'; data: string; timeoutMs?: number }): Promise<void>;
  cancel(o: { tag: string }): Promise<void>;
  startRinging(): Promise<void>;
  stopRinging(): Promise<void>;
  notificationPermission(): Promise<{ state: 'granted' | 'denied' | 'prompt' }>;
  requestNotificationPermission(): Promise<{ state: 'granted' | 'denied' | 'prompt' }>;
  setCallAudio(o: { active: boolean; speaker: boolean; auto?: boolean }): Promise<{ route: string; hasHeadset: boolean }>;
  audioOutputs(): Promise<{ outputs: AudioOutput[]; current: string }>;
  setAudioOutput(o: { id: number }): Promise<{ route: string }>;
  permissionStatus(): Promise<PermissionStatus>;
  requestRuntimePermissions(): Promise<PermissionStatus>;
  batteryOptimizationIgnored(): Promise<{ ignored: boolean }>;
  requestIgnoreBatteryOptimization(): Promise<void>;
  canUseFullScreenIntent(): Promise<{ allowed: boolean }>;
  requestFullScreenIntent(): Promise<void>;
  openAppSettings(): Promise<void>;
  consumeLaunchAction(): Promise<{ tag?: string; action?: string; data?: string }>;
  setProximity(o: { enabled: boolean }): Promise<void>;
  saveFile(o: { name: string; mime: string; data: string }): Promise<{ ok: boolean }>;
  openAutostart(): Promise<{ opened: boolean }>;
  enterPip(): Promise<void>;
  setPipEligible(o: { on: boolean }): Promise<void>;
  addListener(event: 'externalCall', cb: (e: { on: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'pipChanged', cb: (e: { on: boolean }) => void): Promise<PluginListenerHandle>;
  startScreenShare(): Promise<void>;
  stopScreenShare(): Promise<void>;
  addListener(event: 'screenFrame', cb: (e: { data: string; w: number; h: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'screenEnded', cb: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'audioRoute', cb: (e: { route: string; hasHeadset: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'notificationAction', cb: (e: { tag: string; action: string; data: string }) => void): Promise<PluginListenerHandle>;
}

const headless: NativeBridge | null = headlessBridge
  ? {
      startService: async () => undefined,
      stopService: async () => undefined,
      show: async (o) => headlessBridge.show(o.tag, o.title, o.body, o.kind, o.data, o.timeoutMs ?? 0),
      cancel: async (o) => headlessBridge.cancel(o.tag),
      startRinging: async () => undefined, // the notification channel rings
      stopRinging: async () => undefined,
      notificationPermission: async () => ({ state: 'granted' }),
      requestNotificationPermission: async () => ({ state: 'granted' }),
      setCallAudio: async () => ({ route: 'speaker', hasHeadset: false }),
      audioOutputs: async () => ({ outputs: [], current: '' }),
      setAudioOutput: async () => ({ route: 'speaker' }),
      setProximity: async () => undefined,
      saveFile: async () => ({ ok: false }),
      openAutostart: async () => ({ opened: false }),
      enterPip: async () => undefined,
      setPipEligible: async () => undefined,
      startScreenShare: async () => undefined,
      stopScreenShare: async () => undefined,
      permissionStatus: async () => ALL_GRANTED,
      requestRuntimePermissions: async () => ALL_GRANTED,
      batteryOptimizationIgnored: async () => ({ ignored: true }),
      requestIgnoreBatteryOptimization: async () => undefined,
      canUseFullScreenIntent: async () => ({ allowed: true }),
      requestFullScreenIntent: async () => undefined,
      openAppSettings: async () => undefined,
      consumeLaunchAction: async () => ({}), // belongs to the real app, never consumed here
      addListener: async () => ({ remove: async () => undefined }),
    }
  : null;
const bridge: NativeBridge | null = headless ?? (Capacitor.isNativePlatform() ? registerPlugin<NativeBridge>('MeshCallNative') : null);
const SETUP_KEY = 'voip.native.setupDone.v2';

/** Everything Android-specific lives here so the rest of the app stays platform-neutral. */
class NativeShell {
  readonly events = new Emitter<{ action: { tag: string; action: 'open' | 'decline' | 'accept' | 'callback' | 'reply'; context: LaunchContext | null }; resume: void; active: boolean; audio: void; perms: number; external: boolean }>();
  private _external = false;
  /** The phone is in an operator / other-app call right now (Android audio mode). */
  get externalCall(): boolean {
    return this._external;
  }
  private setExternal(on: boolean): void {
    if (this._external === on) return;
    this._external = on;
    this.events.emit('external', on);
  }
  private _foreground = !isHeadless;
  private _permission: NotificationPermission = 'default';
  private started = false;
  /** Set by the UI: handles Back when there is no history left (return true if handled). */
  onRootBack: (() => boolean) | null = null;
  private _missing = 0;

  /** How many permissions are not granted (drives the red dots on Settings). */
  get missingPermissions(): number {
    return this._missing;
  }

  /** Re-read permission state and tell the UI if the number of missing ones changed. */
  async refreshMissing(): Promise<number> {
    if (!bridge || isHeadless) return 0;
    await this.permissionStatus();
    return this._missing;
  }

  /** Leave the app (the background service keeps running so calls still ring). */
  exitApp(): void {
    void App.exitApp();
  }
  private lastService = '';

  /** Whether the Activity is currently on screen (document.visibilityState is unreliable in the background). */
  get foreground(): boolean {
    return this._foreground;
  }

  get notificationPermission(): NotificationPermission {
    return this._permission;
  }

  async init(): Promise<void> {
    if (!bridge) return;
    if (isHeadless) {
      (window as unknown as { __meshcallAction: (tag: string, action: string, data: string) => void }).__meshcallAction = (tag, action, data) => this.dispatch({ tag, action, data });
      (window as unknown as { __meshcallExternal: (on: boolean) => void }).__meshcallExternal = (on) => this.setExternal(on);
      return;
    }
    try {
      await App.addListener('appStateChange', (s) => {
        this._foreground = s.isActive;
        this.events.emit('active', s.isActive);
        if (s.isActive) {
          void this.refreshPermission();
          void this.refreshMissing();
          this.events.emit('resume', undefined);
        }
      });
      // Back at the root must send the app to the background (keeps calls alive), never close it.
      await App.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack) history.back();
        else if (!this.onRootBack?.()) void App.minimizeApp();
      });
      await bridge.addListener('notificationAction', (e) => this.dispatch(e));
      // Android picture-in-picture: the page shows only the main video while the window is tiny.
      await bridge.addListener('externalCall', (e) => this.setExternal(e.on));
      await bridge.addListener('pipChanged', (e) => document.documentElement.classList.toggle('in-pip', e.on));
      // A headset (Bluetooth/wired) connected or left during a call → the route changed by itself.
      await bridge.addListener('audioRoute', (e) => {
        this._audioRoute = e.route;
        this.syncProximity();
        this.events.emit('audio', undefined);
      });
      await this.refreshPermission();
      void this.refreshMissing();
    } catch (err) {
      log.warn('Native init failed', errorMessage(err));
    }
  }

  private early: Array<{ tag: string; action: string; data: string }> | null = [];

  /** The UI is listening: deliver notification actions that arrived while the app was still booting. */
  actionsReady(): void {
    const q = this.early;
    this.early = null;
    for (const e of q ?? []) this.dispatch(e);
  }

  private dispatch(e: { tag: string; action: string; data: string }): void {
    if (this.early) {
      this.early.push(e);
      return;
    }
    let context: LaunchContext | null = null;
    try {
      const parsed: unknown = JSON.parse(e.data || 'null');
      if (isLaunchContext(parsed)) context = parsed;
    } catch {
      /* ignore */
    }
    this.events.emit('action', { tag: e.tag, action: e.action === 'decline' ? 'decline' : e.action === 'accept' ? 'accept' : e.action === 'callback' ? 'callback' : e.action === 'reply' ? 'reply' : 'open', context });
  }

  /** The notification that launched (or resumed) the app, if any. Read once. */
  async consumeLaunchContext(maxAgeMs = 120_000): Promise<LaunchContext | null> {
    if (!bridge) return null;
    try {
      const r = await bridge.consumeLaunchAction();
      if (!r.data) return null;
      const ctx: unknown = JSON.parse(r.data);
      return isLaunchContext(ctx) && Date.now() - ctx.at <= maxAgeMs ? (ctx.kind === 'incoming-call' && (r.action === 'accept' || r.action === 'callback') ? { ...ctx, action: r.action } : ctx) : null;
    } catch {
      return null;
    }
  }

  /** Open the phone maker's autostart / background-run screen (or MeshCall's app settings). */
  async openAutostartSettings(): Promise<void> {
    try {
      await bridge?.openAutostart();
    } catch (err) {
      log.warn('Opening autostart settings failed', errorMessage(err));
    }
  }

  /** Save a file into the phone's Downloads folder (WebView cannot download blob: URLs). */
  async saveFile(name: string, mime: string, blob: Blob): Promise<boolean> {
    if (!bridge) return false;
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
      const res = await bridge.saveFile({ name, mime, data });
      return !!res.ok;
    } catch (err) {
      log.warn('Saving file failed', errorMessage(err));
      return false;
    }
  }

  async refreshPermission(): Promise<NotificationPermission> {
    if (!bridge) return this._permission;
    try {
      const { state } = await bridge.notificationPermission();
      this._permission = state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'default';
    } catch {
      /* keep last */
    }
    return this._permission;
  }

  async requestNotificationPermission(): Promise<boolean> {
    if (!bridge) return false;
    try {
      const { state } = await bridge.requestNotificationPermission();
      this._permission = state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'default';
    } catch (err) {
      log.warn('Notification permission request failed', errorMessage(err));
    }
    return this._permission === 'granted';
  }

  /** Start the background service (permissions are asked on the Permissions screen, not here). */
  async setupBackground(): Promise<void> {
    if (!bridge || this.started || isHeadless) return;
    this.started = true;
    await this.updateService({ inCall: false, video: false });
  }

  /** True once the user has been through the first-run Permissions screen. */
  get setupDone(): boolean {
    return storage.get(SETUP_KEY, false);
  }

  markSetupDone(): void {
    storage.set(SETUP_KEY, true);
  }

  async permissionStatus(): Promise<PermissionStatus> {
    let s = ALL_GRANTED;
    try {
      s = (await bridge?.permissionStatus()) ?? ALL_GRANTED;
    } catch {
      /* assume granted */
    }
    if (bridge && !isHeadless) {
      const m = (Object.keys(s) as Array<keyof PermissionStatus>).filter((k) => s[k] !== 'granted').length;
      if (m !== this._missing) {
        this._missing = m;
        this.events.emit('perms', m);
      }
    }
    return s;
  }

  async requestRuntimePermissions(): Promise<PermissionStatus> {
    try {
      const st = (await bridge?.requestRuntimePermissions()) ?? ALL_GRANTED;
      this._permission = st.notifications === 'granted' ? 'granted' : st.notifications === 'denied' ? 'denied' : 'default';
      return st;
    } catch {
      return this.permissionStatus();
    }
  }

  requestFullScreenIntent(): Promise<void> {
    return bridge?.requestFullScreenIntent() ?? Promise.resolve();
  }

  async batteryOptimizationIgnored(): Promise<boolean> {
    try {
      return (await bridge?.batteryOptimizationIgnored())?.ignored ?? true;
    } catch {
      return true;
    }
  }

  requestBatteryExemption(): Promise<void> {
    return bridge?.requestIgnoreBatteryOptimization() ?? Promise.resolve();
  }

  openAppSettings(): Promise<void> {
    return bridge?.openAppSettings() ?? Promise.resolve();
  }

  private _audioRoute = 'speaker';
  private audioActive = false;

  /** Current call-audio output on Android: earpiece | speaker | bluetooth | wired. */
  get audioRoute(): string {
    return this._audioRoute;
  }

  get speakerOn(): boolean {
    return this._audioRoute === 'speaker';
  }

  /** Enter/leave call audio mode. Audio calls start on the earpiece, video calls on the speaker. */
  async setCallAudio(active: boolean, speaker: boolean, force = false): Promise<void> {
    if (!bridge || isHeadless) return;
    if (!active && !this.audioActive) return;
    // Already routed: never reset the user's choice just because the call state changed.
    if (active && this.audioActive && !force) return;
    this.audioActive = active;
    if (active && !force) this.callIsVideo = speaker; // first routing of a call: video calls start on the speaker
    try {
      this._audioRoute = (await bridge.setCallAudio({ active, speaker, auto: !force })).route;
    } catch (err) {
      log.warn('Call audio routing failed', errorMessage(err));
    }
    this.syncProximity();
    this.events.emit('audio', undefined);
  }

  private screen: { canvas: HTMLCanvasElement; handles: PluginListenerHandle[]; timer: ReturnType<typeof setInterval>; onEnded: Array<() => void> } | null = null;

  /**
   * Share this phone's screen. Android's WebView has no getDisplayMedia, so the native side
   * captures the screen (MediaProjection) and sends small JPEG frames that are drawn on a canvas;
   * the canvas becomes the video track. Resolves with the track + a way to learn when it ends
   * (user taps "Stop" in the system UI, or the capture service dies).
   */
  async startScreenCapture(): Promise<{ track: MediaStreamTrack; onEnded: (cb: () => void) => void } | null> {
    if (!bridge || isHeadless || this.screen) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 540;
    canvas.height = 1170;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const stream = canvas.captureStream(8);
    const track = stream.getVideoTracks()[0];
    if (!track) return null;
    const state = { canvas, handles: [] as PluginListenerHandle[], timer: setInterval(() => undefined, 1 << 30), onEnded: [] as Array<() => void> };
    clearInterval(state.timer);
    let img: HTMLImageElement | null = null;
    let lastPaint = 0;
    let gotFrame: () => void = () => undefined;
    const first = new Promise<void>((r) => (gotFrame = r));
    let busy = false;
    const paint = () => {
      if (!img || !img.complete) return;
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
      }
      ctx.drawImage(img, 0, 0);
      lastPaint = Date.now();
    };
    state.handles.push(
      await bridge.addListener('screenFrame', (f) => {
        if (busy) return; // drop frames while the previous one is still decoding
        busy = true;
        const im = new Image();
        im.onload = () => {
          img = im;
          paint();
          busy = false;
          gotFrame();
        };
        im.onerror = () => (busy = false);
        im.src = `data:image/jpeg;base64,${f.data}`;
      }),
      await bridge.addListener('screenEnded', () => this.finishScreen()),
    );
    // A still screen sends no new frames; repaint so the encoder keeps getting frames.
    state.timer = setInterval(() => Date.now() - lastPaint > 900 && paint(), 500);
    this.screen = state;
    try {
      await bridge.startScreenShare();
      await Promise.race([first, new Promise((_, rej) => setTimeout(() => rej(new Error('no frames')), 6000))]);
    } catch (err) {
      log.warn('Screen capture not started', errorMessage(err));
      this.finishScreen(false);
      track.stop();
      return null;
    }
    return { track, onEnded: (cb) => this.screen?.onEnded.push(cb) };
  }

  async stopScreenCapture(): Promise<void> {
    try {
      await bridge?.stopScreenShare();
    } catch {
      /* ignore */
    }
    this.finishScreen(false);
  }

  private finishScreen(notify = true): void {
    const s = this.screen;
    if (!s) return;
    this.screen = null;
    clearInterval(s.timer);
    for (const h of s.handles) void h.remove();
    if (notify) for (const cb of s.onEnded) cb();
  }

  /** A video call is up → swiping home shrinks the app into picture-in-picture. */
  setPipEligible(on: boolean): void {
    void bridge?.setPipEligible({ on }).catch(() => undefined);
  }

  /** Shrink the call into a floating window (Android picture-in-picture). */
  enterPip(): void {
    void bridge?.enterPip().catch(() => undefined);
  }

  private callIsVideo = false;
  private proximityOn = false;

  /** Phone at the ear: screen off, but only for audio calls routed to the earpiece. */
  private syncProximity(): void {
    const want = this.audioActive && !this.callIsVideo && this._audioRoute === 'earpiece';
    if (want === this.proximityOn) return;
    this.proximityOn = want;
    void bridge?.setProximity({ enabled: want }).catch(() => undefined);
  }

  /** Outputs selectable right now (only meaningful while a call is up). */
  async audioOutputs(): Promise<{ outputs: AudioOutput[]; current: string }> {
    try {
      return (await bridge?.audioOutputs()) ?? { outputs: [], current: '' };
    } catch {
      return { outputs: [], current: '' };
    }
  }

  async setAudioOutput(id: number): Promise<void> {
    try {
      this._audioRoute = (await bridge!.setAudioOutput({ id })).route;
      this.syncProximity();
      this.events.emit('audio', undefined);
    } catch (err) {
      log.warn('Audio output switch failed', errorMessage(err));
    }
  }

  get inCallAudio(): boolean {
    return this.audioActive;
  }

  async stopService(): Promise<void> {
    this.lastService = '';
    try {
      await bridge?.stopService();
    } catch {
      /* ignore */
    }
  }

  /** Foreground service: idle = keep-alive, inCall = microphone (+camera) service types. */
  async updateService(o: { inCall: boolean; video: boolean; text?: string }): Promise<void> {
    if (!bridge) return;
    const key = JSON.stringify(o);
    if (key === this.lastService) return;
    this.lastService = key;
    try {
      await bridge.startService(o);
    } catch (err) {
      this.lastService = '';
      log.warn('Background service update failed', errorMessage(err));
    }
  }

  async show(n: { tag: string; title: string; body: string; kind: 'call' | 'live' | 'message' | 'missed'; data: unknown; timeoutMs?: number }): Promise<void> {
    if (!bridge) return;
    await bridge.show({ ...n, data: JSON.stringify(n.data ?? {}) });
  }

  /** Ring on the Android RINGER volume (silent/vibrate aware). */
  startRinging(): void {
    void bridge?.startRinging().catch(() => undefined);
  }

  stopRinging(): void {
    void bridge?.stopRinging().catch(() => undefined);
  }

  async cancel(tag: string): Promise<void> {
    try {
      await bridge?.cancel({ tag });
    } catch {
      /* ignore */
    }
  }
}

export const native = new NativeShell();
