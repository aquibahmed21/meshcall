import { Emitter } from '../core/emitter';
import { storage } from '../core/storage';
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

export class ContactsService {
  readonly events = new Emitter<{ change: void }>();
  private _contacts = new Map<string, Contact>();
  private _serverUrl = '';

  constructor(
    private readonly identity: IdentityService,
  ) {
    for (const c of storage.get<Contact[]>(CONTACTS_KEY, [])) {
      if (c?.phone) this._contacts.set(c.phone, c);
    }
  }

  /** Must be called (or updated) whenever the server URL resolves. */
  setServerUrl(url: string): void {
    this._serverUrl = url;
  }

  get contacts(): Contact[] {
    return [...this._contacts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Look up a list of phone numbers on the server and update local contact records. */
  async lookup(phones: string[]): Promise<Contact[]> {
    if (!phones.length) return [];
    const url = `${this._serverUrl}/api/users/lookup`;
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
    const url = `${this._serverUrl}/api/users/search?q=${encodeURIComponent(q)}`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.identity.token}` },
      });
      if (!res.ok) return [];
      const rows = (await res.json()) as Array<{ phone: string; name: string; online: boolean }>;
      return rows
        .filter((r) => r.phone !== this.identity.phone)
        .map((r) => ({ phone: r.phone, name: r.name, registered: true, online: r.online, source: 'manual' as const }));
    } catch {
      return [];
    }
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
    const phoneToName = new Map<string, string>();
    for (const c of rawContacts) {
      const name = c.displayName?.trim() ?? '';
      for (const ph of c.phoneNumbers ?? []) {
        const num = (ph.number ?? '').replace(/[\s\-().]/g, '');
        if (num) phoneToName.set(num, name || num);
      }
    }

    const phones = [...phoneToName.keys()];
    if (!phones.length) return [];

    const registered = await this.lookup(phones);
    for (const r of registered) {
      const name = phoneToName.get(r.phone) ?? r.name;
      this._contacts.set(r.phone, { ...r, name, source: 'device' });
    }
    this.persist();
    this.events.emit('change', undefined);
    return registered.map((r) => ({ ...r, name: phoneToName.get(r.phone) ?? r.name, source: 'device' as const }));
  }

  private persist(): void {
    storage.set(CONTACTS_KEY, [...this._contacts.values()]);
  }
}
