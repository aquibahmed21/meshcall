import type { NetworkQuality } from '../../types/state';
import { colorFor, h, initials } from '../dom';
import { icons } from '../icons';
import type { LayoutPlan } from '../layout/CallLayoutManager';

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

export interface GridViewState {
  sinkId: string | null;
  /** Main participant (drives PiP and the fullscreen spotlight). */
  selectedId: string | null;
  /** The tile whose <video> is currently shown in PiP. */
  pipId: string | null;
  /** Tile pinned by the user (manual spotlight). */
  pinnedId: string | null;
  /** Active speaker (speaking ring). */
  speakerId: string | null;
  pipAvailable: boolean;
  fullscreenAvailable: boolean;
}

export interface GridCallbacks {
  onAutoplayBlocked: () => void;
  onSelect: (id: string) => void;
  onTileAction: (id: string, action: 'pip' | 'fullscreen') => void;
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
  pipBtn: HTMLButtonElement;
  fsBtn: HTMLButtonElement;
  stream: MediaStream | null;
  sinkId: string | null;
  hasVideo: boolean;
}

/**
 * Keyed tile reconciliation: tiles (and their <video> elements) persist across renders, so
 * reconnects / layout switches never restart playback or flicker – and PiP/fullscreen keep
 * working on the very same element. Switching layout only MOVES tiles between the main area
 * and the strip (a same-task DOM move does not pause media elements).
 *
 *   .video-stage[data-layout]
 *     ├─ .grid.lay-main[data-count]   grid: 1 → full, 2 → 50/50, 3–4 → 2×2, 5+ → responsive
 *     └─ .lay-strip                   speaker / spotlight / sidebar / filmstrip secondary tiles
 */
export class VideoGrid {
  private main = h('div', { class: 'grid lay-main', 'data-count': '0' });
  private strip = h('div', { class: 'lay-strip', role: 'group', 'aria-label': 'Other participants' });
  readonly el = h('div', { class: 'video-stage', 'data-layout': 'grid' }, this.main, this.strip);
  private tiles = new Map<string, Tile>();

  constructor(private readonly cb: GridCallbacks) {}

  update(models: TileModel[], view: GridViewState, plan: LayoutPlan): void {
    const byId = new Map(models.map((m) => [m.id, m]));
    for (const m of models) {
      let t = this.tiles.get(m.id);
      if (!t) {
        t = this.create(m);
        this.tiles.set(m.id, t);
      }
      this.render(t, m, view, plan);
    }
    for (const [id, t] of this.tiles) {
      if (byId.has(id)) continue;
      t.video.srcObject = null;
      t.root.remove();
      this.tiles.delete(id);
    }
    this.place(this.main, plan.main);
    this.place(this.strip, plan.strip);
    this.el.dataset.layout = plan.layout;
    this.main.dataset.count = String(plan.main.length);
    this.strip.hidden = plan.strip.length === 0;
    this.el.style.setProperty('--strip-count', String(plan.strip.length));
  }

  /** Order children of a container exactly as `ids` (moves, never recreates). */
  private place(container: HTMLElement, ids: string[]): void {
    ids.forEach((id, index) => {
      const t = this.tiles.get(id);
      if (t && container.children[index] !== t.root) container.insertBefore(t.root, container.children[index] ?? null);
    });
    while (container.children.length > ids.length) container.lastElementChild!.remove();
  }

  video(id: string | null): HTMLVideoElement | null {
    return id ? (this.tiles.get(id)?.video ?? null) : null;
  }

  hasVideo(id: string | null): boolean {
    return !!id && !!this.tiles.get(id)?.hasVideo;
  }

  idOfVideo(video: HTMLVideoElement | null): string | null {
    if (!video) return null;
    for (const [id, t] of this.tiles) if (t.video === video) return id;
    return null;
  }

  owns(video: HTMLVideoElement): boolean {
    return this.idOfVideo(video) !== null;
  }

  /** Retry playback after a user gesture (autoplay policy). */
  resumePlayback(): void {
    for (const t of this.tiles.values()) void t.video.play().catch(() => undefined);
  }

  dispose(): void {
    for (const t of this.tiles.values()) t.video.srcObject = null;
    this.tiles.clear();
    this.main.replaceChildren();
    this.strip.replaceChildren();
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
    const stop = (fn: () => void) => (e: Event) => {
      e.stopPropagation();
      fn();
    };
    const pipBtn = h('button', { class: 'tile-btn', type: 'button', html: icons.pip, onclick: stop(() => this.cb.onTileAction(m.id, 'pip')) });
    const fsBtn = h('button', { class: 'tile-btn', type: 'button', html: icons.fullscreen, onclick: stop(() => this.cb.onTileAction(m.id, 'fullscreen')) });
    const root = h(
      'div',
      {
        class: `tile${m.local ? ' local' : ''}`,
        'data-id': m.id,
        tabindex: 0,
        role: 'button',
        onclick: () => this.cb.onSelect(m.id),
        onkeydown: ((e: KeyboardEvent) => {
          if (e.target === root && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            this.cb.onSelect(m.id);
          }
        }) as EventListener,
      },
      video,
      avatar,
      h('div', { class: 'tile-pip-note' }, 'Playing in picture-in-picture'),
      h('div', { class: 'tile-top' }, path, quality, h('span', { class: 'grow' }), pipBtn, fsBtn),
      state,
      h('div', { class: 'tile-footer' }, label, mic, cam),
    );
    return { root, video, avatar, label, mic, cam, state, path, quality, pipBtn, fsBtn, stream: null, sinkId: null, hasVideo: false };
  }

  private render(t: Tile, m: TileModel, view: GridViewState, plan: LayoutPlan): void {
    if (t.stream !== m.stream) {
      t.stream = m.stream;
      t.video.srcObject = m.stream;
      if (m.stream) {
        t.video.play().catch((err: Error) => {
          if (err.name === 'NotAllowedError') this.cb.onAutoplayBlocked();
        });
      }
    }
    if (!m.local && view.sinkId !== t.sinkId && 'setSinkId' in t.video) {
      t.sinkId = view.sinkId;
      void (t.video as HTMLVideoElement & { setSinkId(id: string): Promise<void> }).setSinkId(view.sinkId ?? '').catch(() => undefined);
    }
    const vt = m.stream?.getVideoTracks()[0];
    t.hasVideo = !!vt && vt.readyState === 'live' && !vt.muted && !m.videoMuted;
    const selected = view.selectedId === m.id;
    const inPip = view.pipId === m.id;
    const pinned = view.pinnedId === m.id;
    const isMain = plan.layout !== 'grid' && plan.mainId === m.id;
    t.root.classList.toggle('pinned', pinned);
    t.root.classList.toggle('speaking', view.speakerId === m.id);
    t.root.classList.toggle('is-main', isMain);
    t.root.classList.toggle('thumb', plan.strip.includes(m.id));
    t.root.classList.toggle('has-video', t.hasVideo);
    t.root.classList.toggle('mirrored', m.local && !m.screen);
    t.root.classList.toggle('screen', m.screen);
    t.root.classList.toggle('selected', selected);
    t.root.classList.toggle('in-pip', inPip);
    t.root.setAttribute('aria-pressed', String(selected));
    t.root.setAttribute('aria-label', `${m.local ? 'Your video' : m.name}${pinned ? ' (pinned – activate to unpin)' : selected ? ' (main)' : ' – pin as main video'}`);
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

    const pipLabel = inPip ? 'Exit picture-in-picture' : `Picture-in-picture: ${m.local ? 'your video' : m.name}`;
    t.pipBtn.hidden = !view.pipAvailable || (!t.hasVideo && !inPip);
    t.pipBtn.innerHTML = inPip ? icons.pipExit : icons.pip;
    t.pipBtn.setAttribute('aria-label', pipLabel);
    t.pipBtn.title = pipLabel;
    const fsLabel = `Fullscreen: ${m.local ? 'your video' : m.name}`;
    t.fsBtn.hidden = !view.fullscreenAvailable;
    t.fsBtn.innerHTML = icons.fullscreen;
    t.fsBtn.setAttribute('aria-label', fsLabel);
    t.fsBtn.title = fsLabel;
  }
}
