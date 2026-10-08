/**
 * Browser / Android Back for an app without routes.
 *
 * Every open layer (modal, conversation, panel, menu, secondary mobile view) gets a history
 * entry at depth = current depth + 1, so Back closes the top layer:
 *
 *   open a layer   → history.pushState({depth})
 *   Back pressed   → popstate(depth d) → close every layer deeper than d
 *   closed in UI   → the layer is forgotten; its entry stays as a "dead" entry
 *
 * The stack never calls history.back() for a UI close: that is asynchronous and races with
 * layers opened in the same moment (e.g. a declined call closes the dialog and opens the call
 * view), which could step out of the app. Instead, when a Back press lands on dead entries, the
 * stack keeps going back by itself until it closes a live layer – or, with nothing open,
 * leaves the app – so Back never appears to "do nothing".
 *
 * A layer's onBack may return false to stay open (e.g. an incoming-call dialog); its entry is
 * then re-armed.
 */
interface Layer {
  depth: number;
  onBack: () => boolean | void;
}

const MARK = '__meshcallBack';

function depthOf(state: unknown): number {
  const v = (state as Record<string, unknown> | null)?.[MARK];
  return typeof v === 'number' ? v : 0;
}

class BackStack {
  private layers: Layer[] = [];

  constructor() {
    window.addEventListener('popstate', (e) => this.onPop(depthOf(e.state)));
  }

  /** Register an open layer. Returns the function to call when the UI closes it. */
  push(onBack: () => boolean | void): () => void {
    const layer: Layer = { depth: depthOf(history.state) + 1, onBack };
    this.layers.push(layer);
    history.pushState({ [MARK]: layer.depth }, '');
    return () => {
      const i = this.layers.indexOf(layer);
      if (i >= 0) this.layers.splice(i, 1); // entry becomes dead; skipped on the next Back
    };
  }

  get depth(): number {
    return this.layers.length;
  }

  private onPop(depth: number): void {
    let closed = false;
    for (;;) {
      const top = this.topAbove(depth);
      if (!top) break;
      this.layers.splice(this.layers.indexOf(top), 1);
      closed = true;
      if (top.onBack() === false) {
        // Stay open: re-arm its entry; the user sees this layer, so stop here.
        top.depth = depth + 1;
        this.layers.push(top);
        history.pushState({ [MARK]: top.depth }, '');
        break;
      }
    }
    // Nothing was open above this entry: it was dead (closed in the UI / left over from before a
    // reload). Keep going – over further dead entries, or out of the app at the bottom.
    if (!closed) history.back();
  }

  private topAbove(depth: number): Layer | undefined {
    let top: Layer | undefined;
    for (const l of this.layers) if (l.depth > depth && (!top || l.depth > top.depth)) top = l;
    return top;
  }
}

export const backStack = new BackStack();
