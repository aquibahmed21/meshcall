/**
 * Structured, level-filtered logger.
 *
 *   [Signaling] Connected
 *   [ICE] Selected candidate pair = host → host
 *
 * - Secrets (credential/password/token…) are redacted from structured data.
 * - `throttled()` lets hot paths (stats, candidate errors) log at most once per window.
 * - A bounded ring buffer feeds the in-app diagnostics log view.
 */
export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG';

const ORDER: Record<LogLevel, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };
const SENSITIVE_KEY = /credential|password|secret|token|authorization|auth_?key|p256dh/i;
const BUFFER_SIZE = 300;

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[…]';
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

class LogHub {
  level: LogLevel = 'INFO';
  readonly buffer: LogEntry[] = [];
  private listeners = new Set<(e: LogEntry) => void>();
  private lastByKey = new Map<string, number>();

  setLevel(level: string | undefined): void {
    const upper = (level ?? '').toUpperCase();
    if (upper in ORDER) this.level = upper as LogLevel;
  }

  write(level: LogLevel, scope: string, message: string, data?: unknown): void {
    if (ORDER[level] > ORDER[this.level]) return;
    const entry: LogEntry = { ts: Date.now(), level, scope, message, data: data === undefined ? undefined : redact(data) };
    this.buffer.push(entry);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
    const line = `[${scope}] ${message}`;
    const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : level === 'DEBUG' ? console.debug : console.info;
    if (entry.data !== undefined) fn(line, entry.data);
    else fn(line);
    for (const l of this.listeners) l(entry);
  }

  /** Returns true if `key` has not been logged within `windowMs`. */
  allow(key: string, windowMs: number): boolean {
    const now = Date.now();
    const last = this.lastByKey.get(key) ?? 0;
    if (now - last < windowMs) return false;
    this.lastByKey.set(key, now);
    if (this.lastByKey.size > 500) this.lastByKey.clear();
    return true;
  }

  subscribe(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export const logHub = new LogHub();

export interface Logger {
  error(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
  /** Log at most once per `windowMs` for the given key. */
  throttled(key: string, windowMs: number, level: LogLevel, message: string, data?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    error: (m, d) => logHub.write('ERROR', scope, m, d),
    warn: (m, d) => logHub.write('WARN', scope, m, d),
    info: (m, d) => logHub.write('INFO', scope, m, d),
    debug: (m, d) => logHub.write('DEBUG', scope, m, d),
    throttled: (key, windowMs, level, m, d) => {
      if (logHub.allow(`${scope}:${key}`, windowMs)) logHub.write(level, scope, m, d);
    },
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
