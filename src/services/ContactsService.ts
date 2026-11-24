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
  /** Last-known signaling deviceId — persisted so DM history survives offline restarts. */
  deviceId?: string;
}

const CONTACTS_KEY_PREFIX = 'voip.contacts.';
const DELETED_KEY_PREFIX = 'voip.deleted.';

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
  private _deleted = new Set<string>();
  private _config: AppConfig | null = null;

  constructor(
    private readonly identity: IdentityService,
  ) {
    this._loadFromStorage();
  }

  /** Key scoped to the logged-in phone so accounts don't share contacts.
   *  Returns null when not logged in (no contacts should be loaded/saved). */
  private get storageKey(): string | null {
    return this.identity.isLoggedIn ? `${CONTACTS_KEY_PREFIX}${this.identity.phone}` : null;
  }

  private get deletedKey(): string | null {
    return this.identity.isLoggedIn ? `${DELETED_KEY_PREFIX}${this.identity.phone}` : null;
  }

  private _loadFromStorage(): void {
    this._contacts.clear();
    this._deleted.clear();
    const key = this.storageKey;
    if (!key) return;
    for (const c of storage.get<Contact[]>(key, [])) {
      if (c?.phone) this._contacts.set(c.phone, c);
    }
    const dkey = this.deletedKey;
    if (dkey) {
      for (const p of storage.get<string[]>(dkey, [])) this._deleted.add(p);
    }
  }

  /**
   * Re-read contacts for the now-logged-in phone. Call this after setAuth()
   * so a new login always starts with the correct (per-account) contact list.
   */
  reloadForPhone(): void {
    this._loadFromStorage();
    // Remove own number if it was previously synced in.
    if (this.identity.isLoggedIn && this._contacts.has(this.identity.phone)) {
      this._contacts.delete(this.identity.phone);
      this.persist();
    }
    this.events.emit('change', undefined);
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
    // Chunk into batches of 500 so large contact lists don't get silently truncated.
    const CHUNK = 500;
    const results: Contact[] = [];
    for (let i = 0; i < phones.length; i += CHUNK) {
      const chunk = phones.slice(i, i + CHUNK);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.identity.token}` },
          body: JSON.stringify({ phones: chunk }),
        });
        if (!res.ok) continue;
        const rows = (await res.json()) as Array<{ phone: string; name: string; online: boolean }>;
        results.push(...rows.map((r) => ({ phone: r.phone, name: r.name, registered: true, online: r.online, source: 'manual' as const })));
      } catch {
        // ignore network errors for this chunk
      }
    }
    return results;
  }

  /** Search the server for users matching a phone/name query. Returns server results only. */
  async search(q: string): Promise<Contact[]> {
    // Strip spaces/dashes so "+91 98765 43210" matches the stored "+919876543210".
    const normalised = q.replace(/[\s\-().]/g, '').toLowerCase();
    const url = `${this.serverUrl}/api/users/search?q=${encodeURIComponent(normalised)}`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.identity.token}` },
      });
      if (!res.ok) return [];
      const rows = (await res.json()) as Array<{ phone: string; name: string; online: boolean }>;
      return rows
        .filter(r => r.phone !== this.identity.phone)
        .map(r => ({ phone: r.phone, name: r.name, registered: true, online: r.online, source: 'manual' as const }));
    } catch {
      return [];
    }
  }

  /** Save a contact locally. Clears the deleted-blocklist entry so it can be re-added. */
  add(phone: string, name: string, source: Contact['source'] = 'manual'): void {
    this._deleted.delete(phone);
    this.persistDeleted();
    const existing = this._contacts.get(phone);
    this._contacts.set(phone, { ...existing, phone, name, registered: true, online: false, source });
    this.persist();
    this.events.emit('change', undefined);
  }

  /** Remove a contact and blocklist it so device-sync doesn't re-add it. */
  remove(phone: string): void {
    this._contacts.delete(phone);
    this._deleted.add(phone);
    this.persist();
    this.persistDeleted();
    this.events.emit('change', undefined);
  }

  has(phone: string): boolean {
    return this._contacts.has(phone);
  }

  /** Store the contact's last-known signaling deviceId so DM history is accessible offline. */
  learnDeviceId(phone: string, deviceId: string): void {
    const c = this._contacts.get(phone);
    if (c && c.deviceId !== deviceId) {
      c.deviceId = deviceId;
      this.persist();
    }
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
    // ContactPayload from @capacitor-community/contacts v8:
    //   name?: { display: string|null; given: string|null; family: string|null }
    //   phones?: Array<{ type, label?, number: string|null }>
    type NamePayload = { display: string | null; given?: string | null; family?: string | null };
    type PhonePayload = { number: string | null };
    type ContactPayload = { name?: NamePayload; phones?: PhonePayload[] };
    type ContactsPlugin = { getContacts: (opts: object) => Promise<{ contacts: ContactPayload[] }> };
    let plugin: ContactsPlugin | null = null;
    try {
      const mod = await import('@capacitor-community/contacts');
      const p = (mod as unknown as { Contacts?: ContactsPlugin }).Contacts;
      plugin = p ?? null;
    } catch {
      return [];
    }
    if (!plugin) { console.log('[SYNC] plugin not available'); return []; }

    let rawContacts: ContactPayload[] = [];
    try {
      const { contacts } = await plugin.getContacts({ projection: { name: true, phones: true } });
      rawContacts = contacts;
      console.log(`[SYNC] raw contacts from device: ${rawContacts.length}`);
      // Log first 3 contacts so we can see the actual structure
      rawContacts.slice(0, 3).forEach((c, i) => {
        console.log(`[SYNC] contact[${i}] name=${JSON.stringify(c.name)} phones=${JSON.stringify((c as any).phones ?? (c as any).phoneNumbers ?? 'MISSING')}`);
      });
    } catch (err) {
      console.log(`[SYNC] getContacts threw: ${err}`);
      return [];
    }

    // Extract all phone numbers, normalise, deduplicate.
    const phoneToName = new Map<string, string>();
    const variantToRaw = new Map<string, string>();

    for (const c of rawContacts) {
      const n = c.name;
      const name = (n?.display ?? [n?.given, n?.family].filter(Boolean).join(' ') ?? '').trim();
      for (const ph of c.phones ?? []) {
        const raw = ph.number ?? '';
        const stripped = raw.replace(/[\s\-().+]/g, '');
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
    console.log(`[SYNC] total phone variants to lookup: ${phones.length}`);
    if (!phones.length) {
      console.log('[SYNC] no phones extracted — check field names above');
      return [];
    }
    // Log a sample of variants sent
    console.log(`[SYNC] sample variants: ${phones.slice(0, 10).join(', ')}`);

    const serverPhoneToDeviceName = new Map<string, string>();
    for (const [variant, name] of phoneToName) {
      for (const v of phoneVariants(variant)) serverPhoneToDeviceName.set(v, name);
    }

    const registered = await this.lookup(phones);
    console.log(`[SYNC] server returned ${registered.length} registered: ${registered.map(r => r.phone).join(', ')}`);
    const added: Contact[] = [];
    for (const r of registered) {
      // Skip own phone number and explicitly deleted contacts.
      if (r.phone === this.identity.phone) continue;
      if (this._deleted.has(r.phone)) continue;
      const deviceName = serverPhoneToDeviceName.get(r.phone) ?? r.name;
      const existing = this._contacts.get(r.phone);
      if (existing && existing.source === 'manual') {
        this._contacts.set(r.phone, { ...existing, name: deviceName, online: r.online });
      } else {
        this._contacts.set(r.phone, { ...r, name: deviceName, source: 'device' });
      }
      added.push({ ...r, name: deviceName, source: 'device' as const });
    }
    this.persist();
    this.events.emit('change', undefined);
    return added;
  }

  private persist(): void {
    const key = this.storageKey;
    if (!key) return;
    storage.set(key, [...this._contacts.values()]);
  }

  private persistDeleted(): void {
    const key = this.deletedKey;
    if (!key) return;
    storage.set(key, [...this._deleted]);
  }
}
