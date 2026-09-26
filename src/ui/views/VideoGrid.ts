import type { NetworkQuality } from '../../types/state';
import { colorFor, h, initials } from '../dom';
import { icons } from '../icons';

export interface TileModel {
  id: string;
  name: string;
  stream: MediaStream | null;
  local: boolean;
  audioMuted: boolean;
  videoMuted: boolean;
  screen: boolean;
  /** Human connection problem ("Connecting…", "Reconnecting…"), undefined when fine. */
  connection?: string;
  pathType?: 'P2P' | 'STUN' | 'TURN';
  quality?: NetworkQuality;
}

interface Tile {
  root: HTMLDivElement;
  video: HTMLVideoElement;
  avatar: HTMLDivElement;
  label: HTMLSpanElement;
  mic: HTMLSpanElement;
  cam: HTMLSpanElement;
  state: HTMLSpanElement;
  path: HTMLSpanElement;
  quality: HTMLSpanElement;
  stream: MediaStream | null;
  sinkId: string | null;
}

/**
 * Keyed tile reconciliation: tiles (and their <video> elements) persist across renders, so
 * reconnects / state changes never restart playback or flicker.
 * Layout is CSS-driven by data-count: 1 → full, 2 → 50/50, 3–4 → 2×2, 5+ → responsive grid.
 */
export class VideoGrid {
  readonly el = h('div', { class: 'grid', 'data-count': '0' });
  private tiles = new Map<string, Tile>();

  constructor(private readonly onAutoplayBlocked: () => void) {}

  update(models: TileModel[], sinkId: string | null): void {
    const seen = new Set<string>();
    models.forEach((m, index) => {
      seen.add(m.id);
      let t = this.tiles.get(m.id);
      if (!t) {
        t = this.create(m);
        this.tiles.set(m.id, t);
      }
      if (this.el.children[index] !== t.root) this.el.insertBefore(t.root, this.el.children[index] ?? null);
      this.render(t, m, sinkId);
    });
    for (const [id, t] of this.tiles) {
      if (seen.has(id)) continue;
      t.video.srcObject = null;
      t.root.remove();
      this.tiles.delete(id);
    }
    this.el.dataset.count = String(models.length);
  }

  /** Retry playback after a user gesture (autoplay policy). */
  resumePlayback(): void {
    for (const t of this.tiles.values()) void t.video.play().catch(() => undefined);
  }

  dispose(): void {
    for (const t of this.tiles.values()) t.video.srcObject = null;
    this.tiles.clear();
    this.el.replaceChildren();
  }

  private create(m: TileModel): Tile {
    const video = h('video', { autoplay: true, playsinline: true });
    video.muted = m.local; // never play our own microphone back
    const avatar = h('div', { class: 'avatar', style: `--avatar:${colorFor(m.id)}` }, initials(m.name));
    const label = h('span', { class: 'tile-name' });
    const mic = h('span', { class: 'tile-icon', html: icons.micOff, title: 'Microphone muted' });
    const cam = h('span', { class: 'tile-icon', html: icons.camOff, title: 'Camera off' });
    const state = h('span', { class: 'tile-state' });
    const path = h('span', { class: 'path-badge' });
    const quality = h('span', { class: 'quality-dot', title: 'Network quality' });
    const root = h(
      'div',
      { class: `tile${m.local ? ' local' : ''}`, 'data-id': m.id },
      video,
      avatar,
      h('div', { class: 'tile-top' }, path, quality),
      state,
      h('div', { class: 'tile-footer' }, label, mic, cam),
    );
    return { root, video, avatar, label, mic, cam, state, path, quality, stream: null, sinkId: null };
  }

  private render(t: Tile, m: TileModel, sinkId: string | null): void {
    if (t.stream !== m.stream) {
      t.stream = m.stream;
      t.video.srcObject = m.stream;
      if (m.stream) {
        t.video.play().catch((err: Error) => {
          if (err.name === 'NotAllowedError') this.onAutoplayBlocked();
        });
      }
    }
    if (!m.local && sinkId !== t.sinkId && 'setSinkId' in t.video) {
      t.sinkId = sinkId;
      void (t.video as HTMLVideoElement & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId ?? '').catch(() => undefined);
    }
    const vt = m.stream?.getVideoTracks()[0];
    const showVideo = !!vt && vt.readyState === 'live' && !vt.muted && !m.videoMuted;
    t.root.classList.toggle('has-video', showVideo);
    t.root.classList.toggle('mirrored', m.local && !m.screen);
    t.root.classList.toggle('screen', m.screen);
    t.label.textContent = m.local ? `${m.name} (You)` : m.name;
    t.mic.hidden = !m.audioMuted;
    t.cam.hidden = !m.videoMuted || m.screen;
    t.state.textContent = m.connection ?? '';
    t.state.hidden = !m.connection;
    t.path.textContent = m.pathType ?? '';
    t.path.hidden = !m.pathType;
    t.path.dataset.type = m.pathType ?? '';
    t.path.title = m.pathType === 'TURN' ? 'Media relayed via TURN' : m.pathType === 'STUN' ? 'Direct P2P through NAT' : 'Direct P2P';
    t.quality.dataset.q = m.quality ?? 'unknown';
    t.quality.hidden = !m.quality || m.quality === 'unknown';
  }
}
