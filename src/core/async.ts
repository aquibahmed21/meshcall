export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

/** Reject if `promise` does not settle within `ms`. The underlying work is not cancelled. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    }),
  ]);
}

/**
 * Runs async tasks strictly one after another. Used per peer so that SDP/ICE handling
 * never interleaves (setRemoteDescription must finish before candidates are applied, etc.).
 * A failing task does not block the queue.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;

  run<T>(task: () => Promise<T>): Promise<T | undefined> {
    const result = this.tail.then(async () => (this.closed ? undefined : task()));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): void {
    this.closed = true;
  }
}

/** Exponential backoff with jitter. */
export class Backoff {
  private attempt = 0;
  constructor(
    private readonly baseMs: number,
    private readonly maxMs: number,
  ) {}
  next(): number {
    const exp = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt++);
    return Math.round(exp * (0.75 + Math.random() * 0.5));
  }
  reset(): void {
    this.attempt = 0;
  }
  get attempts(): number {
    return this.attempt;
  }
}

/** A setTimeout handle that can be re-armed/cleared safely. */
export class Timer {
  private id: ReturnType<typeof setTimeout> | null = null;
  start(ms: number, fn: () => void): void {
    this.clear();
    this.id = setTimeout(() => {
      this.id = null;
      fn();
    }, ms);
  }
  clear(): void {
    if (this.id !== null) clearTimeout(this.id);
    this.id = null;
  }
  get active(): boolean {
    return this.id !== null;
  }
}

/** Bounded set with FIFO eviction – used for message de-duplication. */
export class BoundedSet<T> {
  private set = new Set<T>();
  constructor(private readonly capacity: number) {}
  /** Returns false if the value was already present. */
  add(value: T): boolean {
    if (this.set.has(value)) return false;
    this.set.add(value);
    if (this.set.size > this.capacity) {
      const first = this.set.values().next().value as T;
      this.set.delete(first);
    }
    return true;
  }
  has(value: T): boolean {
    return this.set.has(value);
  }
  clear(): void {
    this.set.clear();
  }
}
