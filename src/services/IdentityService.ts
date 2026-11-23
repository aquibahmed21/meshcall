import { uuid } from '../core/ids';
import { storage } from '../core/storage';

const KEY = 'voip.identity';

interface StoredIdentity {
  deviceId: string;
  displayName: string;
  phone: string;
  token: string;
  role: string;
}

/**
 * Device-based identity, now backed by server-side phone+password accounts.
 *  - deviceId:  persistent UUID – stable across logins, never sent to the server
 *  - sessionId: new per page load; lets peers detect reloads/rejoins of the same device
 *  - phone:     registered phone number (from server)
 *  - token:     JWT issued by the server (passed to Socket.IO auth)
 */
export class IdentityService {
  readonly deviceId: string;
  readonly sessionId = uuid();
  private name: string;
  private _phone: string;
  private _token: string;
  private _role: string;

  constructor() {
    const stored = storage.get<StoredIdentity | null>(KEY, null);
    this.deviceId = stored?.deviceId && /^[0-9a-f-]{36}$/i.test(stored.deviceId) ? stored.deviceId : uuid();
    this.name = stored?.displayName?.trim() ?? '';
    this._phone = stored?.phone ?? '';
    this._token = stored?.token ?? '';
    this._role = stored?.role ?? 'user';
    this.persist();
  }

  get displayName(): string { return this.name; }
  get phone(): string { return this._phone; }
  get token(): string { return this._token; }
  get role(): string { return this._role; }
  get isAdmin(): boolean { return this._role === 'admin' || this._role === 'root'; }

  /** True after the user has entered their name (also after setAuth). */
  get isRegistered(): boolean { return this.name.length > 0; }

  /** True when a valid auth token is stored (user is logged in). */
  get isLoggedIn(): boolean { return !!this._token && this.name.length > 0; }

  /** Called after a successful register/login response from the server. */
  setAuth(token: string, name: string, phone: string, role = 'user'): void {
    this._token = token;
    this.name = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    this._phone = phone;
    this._role = role || 'user';
    this.persist();
  }

  /** Used by PresenceService for display name updates that don't require re-auth. */
  setDisplayName(name: string): void {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) throw new Error('Name must not be empty');
    this.name = clean;
    this.persist();
  }

  /** Clear credentials (logout). */
  clearAuth(): void {
    this._token = '';
    this._phone = '';
    this.name = '';
    this._role = 'user';
    this.persist();
  }

  private persist(): void {
    storage.set(KEY, {
      deviceId: this.deviceId,
      displayName: this.name,
      phone: this._phone,
      token: this._token,
      role: this._role,
    } satisfies StoredIdentity);
  }
}
