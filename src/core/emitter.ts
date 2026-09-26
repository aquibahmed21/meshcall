/** Minimal strongly-typed event emitter. Listener errors never break the emitter. */
export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<never>);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(fn as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        (fn as Listener<Events[K]>)(payload);
      } catch (err) {
        console.error(`[Emitter] listener for "${String(event)}" threw`, err);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

/** Collects disposers so a component can release every listener/timer in one call. */
export class Disposer {
  private fns: Array<() => void> = [];
  add(fn: () => void): void {
    this.fns.push(fn);
  }
  listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, fn: (e: never) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn as EventListener, opts);
    this.fns.push(() => target.removeEventListener(type, fn as EventListener, opts));
  }
  interval(fn: () => void, ms: number): void {
    const id = setInterval(fn, ms);
    this.fns.push(() => clearInterval(id));
  }
  dispose(): void {
    const fns = this.fns;
    this.fns = [];
    for (const fn of fns.reverse()) {
      try {
        fn();
      } catch (err) {
        console.error('[Disposer] cleanup failed', err);
      }
    }
  }
}
