import { Emitter } from '../../core/emitter';
import { storage } from '../../core/storage';

export type CallLayoutType = 'grid' | 'speaker' | 'spotlight' | 'sidebar' | 'filmstrip';

export const CALL_LAYOUTS: ReadonlyArray<{ id: CallLayoutType; label: string; hint: string }> = [
  { id: 'grid', label: 'Grid', hint: 'Everyone the same size' },
  { id: 'speaker', label: 'Speaker', hint: 'Active speaker large, others below' },
  { id: 'spotlight', label: 'Spotlight', hint: 'One person full size' },
  { id: 'sidebar', label: 'Sidebar', hint: 'Main video with a side column' },
  { id: 'filmstrip', label: 'Filmstrip', hint: 'Main video with a scrollable strip' },
];

const PREF_KEY = 'voip.callLayout';

export interface LayoutTile {
  id: string;
  local: boolean;
  hasVideo: boolean;
  screen: boolean;
}

export interface LayoutPlan {
  /** Layout actually rendered (a 1-tile call is always a full-size grid). */
  layout: CallLayoutType;
  /** Main participant – large tile in focus layouts, PiP target in all layouts. */
  mainId: string | null;
  /** Tiles in the main area, in order. */
  main: string[];
  /** Tiles in the secondary strip/column, in order. */
  strip: string[];
  /** Why mainId was chosen (for UI hints / tests). */
  reason: 'pinned' | 'speaker' | 'screen' | 'video' | 'first' | 'self' | 'none';
}

/**
 * Pure layout logic – no DOM, no WebRTC. Changing layout is a UI-only operation: tiles are
 * re-arranged, the existing <video> elements/MediaStreams/RTCPeerConnections are untouched.
 *
 * Main participant priority:
 *   pinned (user clicked) → [speaker layout: active speaker] → screen share → active speaker
 *   → first remote with video → first remote → you
 */
export class CallLayoutManager {
  readonly events = new Emitter<{ change: void }>();
  private _layout: CallLayoutType;
  private _pinned: string | null = null;
  private _speaker: string | null = null;

  constructor() {
    const pref = storage.get<string>(PREF_KEY, 'grid');
    this._layout = CALL_LAYOUTS.some((l) => l.id === pref) ? (pref as CallLayoutType) : 'grid';
  }

  get layout(): CallLayoutType {
    return this._layout;
  }
  get pinned(): string | null {
    return this._pinned;
  }
  get activeSpeaker(): string | null {
    return this._speaker;
  }

  setLayout(layout: CallLayoutType): void {
    if (layout === this._layout) return;
    this._layout = layout;
    storage.set(PREF_KEY, layout); // per-viewer preference
    this.events.emit('change', undefined);
  }

  /** Pin (manual spotlight) – clicking the pinned tile again returns to automatic. */
  togglePin(id: string): void {
    this._pinned = this._pinned === id ? null : id;
    this.events.emit('change', undefined);
  }

  pin(id: string | null): void {
    if (this._pinned === id) return;
    this._pinned = id;
    this.events.emit('change', undefined);
  }

  setActiveSpeaker(id: string | null): void {
    if (this._speaker === id) return;
    this._speaker = id;
    this.events.emit('change', undefined);
  }

  /** Call ended: forget pin/speaker (the layout preference itself is kept). */
  reset(): void {
    this._pinned = null;
    this._speaker = null;
  }

  plan(tiles: LayoutTile[]): LayoutPlan {
    const ids = new Set(tiles.map((t) => t.id));
    if (this._pinned && !ids.has(this._pinned)) this._pinned = null; // pinned person left
    const speaker = this._speaker && ids.has(this._speaker) ? this._speaker : null;
    const remote = tiles.filter((t) => !t.local);

    let mainId: string | null = null;
    let reason: LayoutPlan['reason'] = 'none';
    const pick = (id: string | undefined | null, why: LayoutPlan['reason']) => {
      if (!mainId && id) [mainId, reason] = [id, why];
    };
    pick(this._pinned, 'pinned');
    if (this._layout === 'speaker') pick(speaker, 'speaker');
    pick(remote.find((t) => t.screen)?.id, 'screen');
    pick(speaker, 'speaker');
    pick(remote.find((t) => t.hasVideo)?.id, 'video');
    pick(remote[0]?.id, 'first');
    pick(tiles.find((t) => t.local)?.id, 'self');

    const order = [...remote.map((t) => t.id), ...tiles.filter((t) => t.local).map((t) => t.id)];
    if (tiles.length <= 1 || this._layout === 'grid') {
      return { layout: 'grid', mainId, main: tiles.map((t) => t.id), strip: [], reason };
    }
    return { layout: this._layout, mainId, main: mainId ? [mainId] : [], strip: order.filter((id) => id !== mainId), reason };
  }
}
