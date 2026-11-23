import { Emitter } from '../core/emitter';
import { storage } from '../core/storage';
import type { AppConfig } from '../config';
import type { IdentityService } from './IdentityService';

export interface Contact {
  phone: string;
  name: string;
  /** true = found in server DB, false = looked up but not registered */
  registered: boolean;
  /** true = currently connected to signaling */
  online: boolean;
  /** Source of this contact entry */
  source: 'manual' | 'device';
}

const CONTACTS_KEY = 'voip.contacts';

/**
 * Generate lookup variants for a stripped phone number so that device contacts
 * stored without a country code still match server records that have one.
 * e.g. "9876543210" → ["+919876543210", "919876543210", "9876543210"]
 */
function phoneVariants(num: string): string[] {
  const vs = new Set<string>([num]);
  // If 10 digits (Indian mobile), add +91 and 91 prefixes.
  if (/^[6-9]\d{9}$/.test(num)) {
    vs.add(`+91${num}`);
    vs.add(`91${num}`);
  }
  // If starts with 0 and 11 digits, strip the 0 (trunk prefix).
  if (num.startsWith('0') && num.length === 11) {
    const without0 = num.slice(1);
    vs.add(without0);
    vs.add(`+91${without0}`);
    vs.add(`91${without0}`);
  }
  // If starts with +91 and remaining is 10 digits, also add without prefix.
  if (num.startsWith('+91') && num.length === 13) {
    vs.add(num.slice(3));
    vs.add(`91${num.slice(3)}`);
  }
  // If starts with 91 (no +) and 12 digits, add + and bare 10-digit.
  if (num.startsWith('91') && num.length === 12 && !num.startsWith('+')) {
    vs.add(`+${num}`);
    vs.add(num.slice(2));
  }
  return [...vs];
}

export class ContactsService {
  readonly events = new Emitter<{ change: void }>();
  private _contacts = new Map<string, Contact>();
  private _config: AppConfig | null = null;

  constructor(
    private readonly identity: IdentityService,
  ) {
    for (const c of storage.get<Contact[]>(CONTACTS_KEY, [])) {
      if (c?.phone) this._contacts.set(c.phone, c);
    }
  }

  /** Must be called once after createApp() so the service reads the live config. */
  setServerUrl(_url: string, config?: AppConfig): void {
    if (config) this._config = config;
  }

  private get serverUrl(): string {
    return this._config?.serverUrl ?? '';
  }

  get contacts(): Contact[] {
    return [...this._contacts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Look up a list of phone numbers on the server and update local contact records. */
  async lookup(phones: string[]): Promise<Contact[]> {
    if (!phones.length) return [];
    const url = `${this.serverUrl}/api/users/lookup`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.identity.token}` },
        body: JSON.stringify({ phones }),
      });
      if (!res.ok) return [];
      const rows = (await res.json()) as Array<{ phone: string; name: string; online: boolean }>;
      return rows.map((r) => ({ phone: r.phone, name: r.name, registered: true, online: r.online, source: 'manual' as const }));
    } catch {
      return [];
    }
  }

  /** Search the server for users matching a phone/name query. */
  async search(q: string): Promise<Contact[]> {
    // Strip spaces/dashes so "+91 98765 43210" matches the stored "+919876543210".
    const normalised = q.replace(/[\s\-().]/g, '');
    const url = `${this.serverUrl}/api/users/search?q=${encodeURIComponent(normalised)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.identity.token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Server error ${res.status}`);
    }
    const rows = (await res.json()) as Array<{ phone: string; name: string; online: boolean }>;
    return rows
      .filter((r) => r.phone !== this.identity.phone)
      .map((r) => ({ phone: r.phone, name: r.name, registered: true, online: r.online, source: 'manual' as const }));
  }

  /** Save a contact locally. */
  add(phone: string, name: string, source: Contact['source'] = 'manual'): void {
    this._contacts.set(phone, { phone, name, registered: true, online: false, source });
    this.persist();
    this.events.emit('change', undefined);
  }

  remove(phone: string): void {
    this._contacts.delete(phone);
    this.persist();
    this.events.emit('change', undefined);
  }

  has(phone: string): boolean {
    return this._contacts.has(phone);
  }

  /** Refresh online status of all saved contacts from the server. */
  async refreshOnlineStatus(): Promise<void> {
    const phones = [...this._contacts.keys()];
    const results = await this.lookup(phones);
    for (const r of results) {
      const c = this._contacts.get(r.phone);
      if (c) { c.online = r.online; c.name = r.name; }
    }
    // mark contacts not returned as offline
    const found = new Set(results.map((r) => r.phone));
    for (const [p, c] of this._contacts) if (!found.has(p)) c.online = false;
    this.events.emit('change', undefined);
  }

  /**
   * Load device contacts via Capacitor Contacts plugin (Android/iOS).
   * Falls back gracefully when the plugin is not available.
   * Returns contacts that are registered on this server.
   */
  async syncDeviceContacts(): Promise<Contact[]> {
    // Dynamically import to avoid breaking web builds where the plugin doesn't exist.
    type ContactsPlugin = { getContacts: (opts: object) => Promise<{ contacts: Array<{ displayName?: string; phoneNumbers?: Array<{ number?: string }> }> }> };
    let plugin: ContactsPlugin | null = null;
    try {
      const mod = await import('@capacitor-community/contacts');
      const p = (mod as unknown as { Contacts?: ContactsPlugin }).Contacts;
      plugin = p ?? null;
    } catch {
      return [];
    }
    if (!plugin) return [];

    let rawContacts: Array<{ displayName?: string; phoneNumbers?: Array<{ number?: string }> }> = [];
    try {
      const { contacts } = await plugin.getContacts({ projection: { name: true, phones: true } });
      rawContacts = contacts;
    } catch {
      return [];
    }

    // Extract all phone numbers, normalise, deduplicate.
    // Build a map from every variant of a number back to the canonical raw number.
    const phoneToName = new Map<string, string>();
    // variantToRaw lets us look up the canonical key after the server responds.
    const variantToRaw = new Map<string, string>();

    for (const c of rawContacts) {
      const name = c.displayName?.trim() ?? '';
      for (const ph of c.phoneNumbers ?? []) {
        const stripped = (ph.number ?? '').replace(/[\s\-().]/g, '');
        if (!stripped) continue;
        const displayName = name || stripped;

        const variants = phoneVariants(stripped);
        for (const v of variants) {
          if (!phoneToName.has(v)) {
            phoneToName.set(v, displayName);
            variantToRaw.set(v, stripped);
          }
        }
      }
    }

    const phones = [...phoneToName.keys()];
    if (!phones.length) return [];

    // Build a reverse lookup: server phone → device display name.
    // The server may return a different format (e.g. "+919876543210") than what
    // the device stored ("9876543210"), so we check all variants we sent.
    const serverPhoneToDeviceName = new Map<string, string>();
    for (const [variant, name] of phoneToName) {
      for (const v of phoneVariants(variant)) serverPhoneToDeviceName.set(v, name);
    }

    const registered = await this.lookup(phones);
    for (const r of registered) {
      const deviceName = serverPhoneToDeviceName.get(r.phone) ?? r.name;
      this._contacts.set(r.phone, { ...r, name: deviceName, source: 'device' });
    }
    this.persist();
    this.events.emit('change', undefined);
    return registered.map((r) => ({ ...r, name: serverPhoneToDeviceName.get(r.phone) ?? r.name, source: 'device' as const }));
  }

  private persist(): void {
    storage.set(CONTACTS_KEY, [...this._contacts.values()]);
  }
}
