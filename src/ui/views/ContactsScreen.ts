import { h } from '../dom';
import { icons } from '../icons';
import type { AppContext } from '../../app';
import type { ContactsService, Contact } from '../../services/ContactsService';
import { AdminScreen } from './AdminScreen';
import { isNative } from '../../native/native';

export interface ContactsScreenOptions {
  app: AppContext;
  contacts: ContactsService;
  onCall: (contact: Contact, media: 'audio' | 'video') => void;
  onMessage: (contact: Contact) => void;
}

/**
 * WhatsApp-style contacts screen.
 * Shown immediately after login, while the hidden voip room is being joined in the background.
 * Replaced by UIManager once the user initiates a call or message.
 */
export class ContactsScreen {
  readonly el: HTMLElement;
  private listEl: HTMLElement;
  private searchInput: HTMLInputElement;
  private statusEl: HTMLElement;
  private searchResults: Contact[] = [];
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private syncDone = false;
  private off: (() => void) | null = null;
  private offPresence: (() => void) | null = null;
  private _initCalled = false;

  constructor(private readonly opts: ContactsScreenOptions) {
    this.searchInput = h('input', {
      type: 'search',
      placeholder: 'Search by name or phone…',
      class: 'contacts-search',
      autocomplete: 'off',
      enterkeyhint: 'search',
    }) as HTMLInputElement;

    this.statusEl = h('p', { class: 'contacts-status' }, '');
    this.listEl = h('div', { class: 'contacts-list' });

    const adminBtn = opts.app.identity.isAdmin
      ? h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Admin',
          'aria-label': 'Admin panel',
          html: icons.settings,
          onclick: () => this.showAdmin(),
        })
      : null;

    const header = h(
      'div',
      { class: 'contacts-header' },
      h('div', { class: 'contacts-me' },
        h('span', { class: 'contacts-me-name' }, opts.app.identity.displayName),
        h('span', { class: 'contacts-me-phone' }, opts.app.identity.phone),
      ),
      h('button', {
        class: 'icon-btn',
        type: 'button',
        title: 'Sync device contacts',
        'aria-label': 'Sync device contacts',
        html: icons.users,
        onclick: () => void this.syncDevice(),
      }),
      ...(adminBtn ? [adminBtn] : []),
    );

    this.el = h(
      'div',
      { class: 'contacts-screen' },
      header,
      h('div', { class: 'contacts-search-wrap' }, this.searchInput),
      this.statusEl,
      this.listEl,
    );

    this.searchInput.addEventListener('input', () => this.scheduleSearch());
    this.searchInput.addEventListener('search', () => this.doSearch());

    this.off = opts.contacts.events.on('change', () => this.renderContacts());

    // Live online status: whenever presence changes, sync online flags from PresenceService
    // so the contacts list updates the moment someone comes online or goes offline.
    this.offPresence = opts.app.presence.events.on('change', () => this.syncOnlineFromPresence());
  }

  /** Call once to trigger initial render + device sync. */
  async init(): Promise<void> {
    if (this._initCalled) return; // idempotent
    this._initCalled = true;
    this.renderContacts();
    if (isNative && !this.syncDone) {
      this.syncDone = true;
      await this.syncDevice();
    } else {
      await this.opts.contacts.refreshOnlineStatus();
    }
  }

  destroy(): void {
    this.off?.();
    this.off = null;
    this.offPresence?.();
    this.offPresence = null;
    this._initCalled = false;
  }

  /** Re-render whenever presence changes so online status is always current. */
  private syncOnlineFromPresence(): void {
    this.renderContacts();
  }

  /** Compute live online status from PresenceService for a contact's phone number. */
  private isOnline(phone: string): boolean {
    const deviceId = this.opts.app.presence.deviceIdForPhone(phone);
    return deviceId ? this.opts.app.presence.status(deviceId) === 'online' : false;
  }

  /** Generate a stable colored avatar background from a phone/name string. */
  private avatarColor(seed: string): string {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) & 0xfffffff;
    const hue = h % 360;
    return `hsl(${hue}, 55%, 45%)`;
  }

  /** Get 1-2 letter initials from a display name. */
  private initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
  }

  private showAdmin(): void {
    const mount = this.el.parentElement;
    if (!mount) return;
    const admin = new AdminScreen(this.opts.app, () => {
      mount.replaceChildren(this.el);
    });
    mount.replaceChildren(admin.el);
    void admin.init();
  }

  private scheduleSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.doSearch(), 300);
  }

  private async doSearch(): Promise<void> {
    const q = this.searchInput.value.trim();
    if (!q) {
      this.searchResults = [];
      this.renderContacts();
      return;
    }
    try {
      this.searchResults = await this.opts.contacts.search(q);
    } catch (err) {
      this.searchResults = [];
      this.setStatus(err instanceof Error ? err.message : 'Search failed');
      setTimeout(() => this.setStatus(''), 4000);
    }
    this.renderContacts();
  }

  private async syncDevice(): Promise<void> {
    this.setStatus('Syncing device contacts…');
    const found = await this.opts.contacts.syncDeviceContacts();
    this.setStatus(found.length > 0 ? `Found ${found.length} contact${found.length !== 1 ? 's' : ''} on MeshCall` : 'No device contacts found on MeshCall');
    setTimeout(() => this.setStatus(''), 3000);
  }

  setStatus(msg: string): void {
    this.statusEl.textContent = msg;
    this.statusEl.hidden = !msg;
  }

  private renderContacts(): void {
    const q = this.searchInput.value.trim();
    const items: Contact[] = q ? this.searchResults : this.opts.contacts.contacts;

    if (!items.length) {
      this.listEl.replaceChildren(
        h('p', { class: 'contacts-empty' },
          q ? 'No users found' : 'No contacts yet — search by phone number to add people',
        ),
      );
      return;
    }

    this.listEl.replaceChildren(
      ...items.map((c) => this.renderContact(c, !!q)),
    );
  }

  private renderContact(c: Contact, isSearchResult: boolean): HTMLElement {
    // Always read online status live from PresenceService so buttons update immediately
    // when a user comes online, without waiting for the next contact-list fetch.
    const online = this.isOnline(c.phone);

    const avatar = h('div', {
      class: 'contact-avatar',
      style: `background:${this.avatarColor(c.phone)}`,
    }, this.initials(c.name));

    const statusDot = h('span', { class: `contact-status ${online ? 'online' : 'offline'}` });
    const nameEl = h('span', { class: 'contact-name' }, c.name);
    const statusText = h('span', { class: `contact-status-text ${online ? 'online' : ''}` }, online ? 'Online' : c.phone);

    const saveBtn = !this.opts.contacts.has(c.phone)
      ? h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Save contact',
          'aria-label': 'Save contact',
          html: icons.userPlus,
          onclick: (e: Event) => { e.stopPropagation(); this.opts.contacts.add(c.phone, c.name); },
        })
      : null;

    const audioBtn = h('button', {
      class: 'btn btn-sm',
      type: 'button',
      disabled: !online,
      title: online ? 'Audio call' : 'User is offline',
      html: icons.phone,
      onclick: (e: Event) => { e.stopPropagation(); this.opts.onCall(c, 'audio'); },
    });
    const videoBtn = h('button', {
      class: 'btn btn-sm',
      type: 'button',
      disabled: !online,
      title: online ? 'Video call' : 'User is offline',
      html: icons.cam,
      onclick: (e: Event) => { e.stopPropagation(); this.opts.onCall(c, 'video'); },
    });
    // Messages can be sent to offline users — delivered via push when they reconnect.
    const msgBtn = h('button', {
      class: 'btn btn-sm',
      type: 'button',
      title: 'Message',
      html: icons.chat,
      onclick: (e: Event) => { e.stopPropagation(); this.opts.onMessage(c); },
    });

    return h(
      'div',
      { class: `contact-row ${online ? 'is-online' : ''}` },
      h('div', { class: 'contact-avatar-wrap' }, avatar, statusDot),
      h('div', { class: 'contact-info' }, h('div', { class: 'contact-text' }, nameEl, statusText)),
      h('div', { class: 'contact-actions' }, ...(saveBtn && isSearchResult ? [saveBtn] : []), audioBtn, videoBtn, msgBtn),
    );
  }
}
