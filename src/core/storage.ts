/** localStorage/sessionStorage access that never throws (private mode, quota, disabled storage). */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export const storage = {
  get<T>(key: string, fallback: T, area: 'local' | 'session' = 'local'): T {
    return safe(() => {
      const raw = (area === 'local' ? localStorage : sessionStorage).getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    }, fallback);
  },
  set(key: string, value: unknown, area: 'local' | 'session' = 'local'): void {
    safe(() => (area === 'local' ? localStorage : sessionStorage).setItem(key, JSON.stringify(value)), undefined);
  },
  remove(key: string, area: 'local' | 'session' = 'local'): void {
    safe(() => (area === 'local' ? localStorage : sessionStorage).removeItem(key), undefined);
  },
};
