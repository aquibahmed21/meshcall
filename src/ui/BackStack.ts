/**
 * Browser / Android Back for an app without routes.
 *
 * Every open layer (modal, conversation, panel, menu, secondary mobile view) owns exactly one
 * history entry, so the number of our entries always equals the number of open layers:
 *
 *   open a layer   → history.pushState         (Back now closes it)
 *   Back pressed   → popstate → close the top layer(s) above the entry we landed on
 *   closed in UI   → its entry is consumed with history.back() (silently), so Back never
 *                    "does nothing" because of a leftover entry
 *
 * A layer's onBack may return false to stay open (e.g. an incoming-call dialog); its entry is
 * then re-armed. Entries left over from before a reload are skipped.
 */
interface Layer {
  onBack: () => boolean | void;
}

const MARK = '__meshcallBack';

class BackStack {
  private layers: Layer[] = [];
  /** popstate events caused by our own history.back() calls. */
  private ignorePops = 0;

  constructor() {
    window.addEventListener('popstate', (e) => this.onPop(e));
  }

  /** Register an open layer. Returns the function to call when the UI closes it. */
  push(onBack: () => boolean | void): () => void {
    const layer: Layer = { onBack };
    this.layers.push(layer);
    history.pushState({ [MARK]: this.layers.length }, '');
    return () => this.release(layer);
  }

  get depth(): number {
    return this.layers.length;
  }

  private release(layer: Layer): void {
    const i = this.layers.indexOf(layer);
    if (i < 0) return; // already closed by Back
    this.layers.splice(i, 1);
    // Drop one of our entries; the entries are interchangeable, so depth stays = layers.length.
    this.ignorePops++;
    history.back();
  }

  private onPop(e: PopStateEvent): void {
    if (this.ignorePops > 0) {
      this.ignorePops--;
      return;
    }
    const raw = (e.state as Record<string, unknown> | null)?.[MARK];
    const target = typeof raw === 'number' ? raw : 0;
    if (this.layers.length === 0) {
      // A leftover entry from before a reload: keep going back so Back still leaves the app.
      if (target > 0) history.back();
      return;
    }
    // Usually one step; a long-press on Back can jump several entries.
    while (this.layers.length > target) {
      const layer = this.layers.pop()!;
      if (layer.onBack() === false) {
        // Stay open: re-arm its entry (and stop – the user sees this layer).
        this.layers.push(layer);
        history.pushState({ [MARK]: this.layers.length }, '');
        return;
      }
    }
  }
}

export const backStack = new BackStack();
