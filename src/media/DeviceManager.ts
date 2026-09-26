import { Emitter } from '../core/emitter';
import { createLogger, errorMessage } from '../core/logger';
import type { SettingsService } from '../services/SettingsService';
import type { MediaManager } from './MediaManager';

const log = createLogger('Devices');

export interface DeviceLists {
  audioinput: MediaDeviceInfo[];
  videoinput: MediaDeviceInfo[];
  audiooutput: MediaDeviceInfo[];
  permission: { camera: PermissionState | 'unknown'; microphone: PermissionState | 'unknown' };
  outputSelectable: boolean;
}

/**
 * enumerateDevices() + devicechange handling:
 *  - added devices appear in the pickers
 *  - removal of the *selected* device falls back to the system default
 *  - default-device changes (e.g. headset plugged in) are followed when no explicit choice was made
 *  - permission changes (Permissions API, where supported) trigger a refresh
 * Output selection uses HTMLMediaElement.setSinkId where supported (Chromium, Firefox 116+).
 */
export class DeviceManager {
  readonly events = new Emitter<{ devices: DeviceLists }>();
  private lists: DeviceLists = {
    audioinput: [],
    videoinput: [],
    audiooutput: [],
    permission: { camera: 'unknown', microphone: 'unknown' },
    outputSelectable: DeviceManager.outputSelectable(),
  };
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private lastDefaultAudio = '';
  private readonly onChange = () => {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(true), 500);
  };

  constructor(
    private readonly settings: SettingsService,
    private readonly media: MediaManager,
  ) {}

  static outputSelectable(): boolean {
    return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  }

  get devices(): DeviceLists {
    return this.lists;
  }

  async start(): Promise<void> {
    navigator.mediaDevices?.addEventListener?.('devicechange', this.onChange);
    await this.watchPermission('camera');
    await this.watchPermission('microphone');
    await this.refresh(false);
  }

  stop(): void {
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onChange);
    if (this.debounce) clearTimeout(this.debounce);
  }

  async refresh(fromChange: boolean): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const prev = this.lists;
      this.lists = {
        ...prev,
        audioinput: all.filter((d) => d.kind === 'audioinput'),
        videoinput: all.filter((d) => d.kind === 'videoinput'),
        audiooutput: all.filter((d) => d.kind === 'audiooutput'),
      };
      if (fromChange) this.reconcile(prev);
      this.events.emit('devices', this.lists);
    } catch (err) {
      log.warn('enumerateDevices failed', errorMessage(err));
    }
  }

  private reconcile(prev: DeviceLists): void {
    const s = this.settings.get();
    const gone = (kind: 'audioinput' | 'videoinput' | 'audiooutput', id: string | null) =>
      !!id && prev[kind].some((d) => d.deviceId === id) && !this.lists[kind].some((d) => d.deviceId === id);
    const added = this.lists.audioinput.filter((d) => !prev.audioinput.some((p) => p.deviceId === d.deviceId));
    const removed = prev.audioinput.filter((d) => !this.lists.audioinput.some((p) => p.deviceId === d.deviceId));
    if (added.length) log.info(`Device added: ${added.map((d) => d.label || d.kind).join(', ')}`);
    if (removed.length) log.info(`Device removed: ${removed.map((d) => d.label || d.kind).join(', ')}`);

    if (gone('audioinput', s.audioInputId)) void this.media.switchDevice('audioinput', null);
    if (gone('videoinput', s.videoInputId)) void this.media.switchDevice('videoinput', null);
    if (gone('audiooutput', s.audioOutputId)) this.settings.update({ audioOutputId: null });

    // Follow OS default microphone changes when the user has not pinned a device.
    const def = this.lists.audioinput.find((d) => d.deviceId === 'default')?.groupId ?? '';
    if (!s.audioInputId && this.lastDefaultAudio && def && def !== this.lastDefaultAudio && this.media.state.hasAudio) {
      log.info('Default microphone changed – following it');
      void this.media.switchDevice('audioinput', null);
    }
    this.lastDefaultAudio = def;
  }

  private async watchPermission(name: 'camera' | 'microphone'): Promise<void> {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName });
      this.lists.permission[name] = status.state;
      status.addEventListener('change', () => {
        log.info(`${name} permission → ${status.state}`);
        this.lists.permission[name] = status.state;
        void this.refresh(true);
      });
    } catch {
      // Permissions API does not support camera/microphone in every browser.
    }
  }
}
