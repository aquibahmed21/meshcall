import { uuid } from '../core/ids';
import { storage } from '../core/storage';

const KEY = 'voip.identity';

interface StoredIdentity {
  deviceId: string;
  displayName: string;
}

/**
 * Device-based identity.
 *  - deviceId:  persistent UUID, the ONLY unique user identifier (never the display name)
 *  - sessionId: new per page load; lets peers detect reloads/rejoins of the same device
 */
export class IdentityService {
  readonly deviceId: string;
  readonly sessionId = uuid();
  private name: string;

  constructor() {
    const stored = storage.get<StoredIdentity | null>(KEY, null);
    this.deviceId = stored?.deviceId && /^[0-9a-f-]{36}$/i.test(stored.deviceId) ? stored.deviceId : uuid();
    this.name = stored?.displayName?.trim() ?? '';
    this.persist();
  }

  get displayName(): string {
    return this.name;
  }

  get isRegistered(): boolean {
    return this.name.length > 0;
  }

  setDisplayName(name: string): void {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) throw new Error('Name must not be empty');
    this.name = clean;
    this.persist();
  }

  private persist(): void {
    storage.set(KEY, { deviceId: this.deviceId, displayName: this.name } satisfies StoredIdentity);
  }
}
