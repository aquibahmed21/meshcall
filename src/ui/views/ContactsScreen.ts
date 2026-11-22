import { h } from '../dom';
import { icons } from '../icons';
import type { AppContext } from '../../app';
import type { ContactsService, Contact } from '../../services/ContactsService';
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
  }

  /** Call once to trigger initial render + device sync. */
  async init(): Promise<void> {
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
    this.searchResults = await this.opts.contacts.search(q);
    this.renderContacts();
  }

  private async syncDevice(): Promise<void> {
    this.setStatus('Syncing device contacts…');
    const found = await this.opts.contacts.syncDeviceContacts();
    this.setStatus(found.length > 0 ? `Found ${found.length} contact${found.length !== 1 ? 's' : ''} on MeshCall` : 'No device contacts found on MeshCall');
    setTimeout(() => this.setStatus(''), 3000);
  }

  private setStatus(msg: string): void {
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
    const onlineEl = h('span', { class: `contact-status ${c.online ? 'online' : 'offline'}` });
    const nameEl = h('span', { class: 'contact-name' }, c.name);
    const phoneEl = h('span', { class: 'contact-phone' }, c.phone);

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
      disabled: !c.online,
      title: c.online ? 'Audio call' : 'User is offline',
      html: icons.phone,
      onclick: (e: Event) => { e.stopPropagation(); this.opts.onCall(c, 'audio'); },
    });
    const videoBtn = h('button', {
      class: 'btn btn-sm',
      type: 'button',
      disabled: !c.online,
      title: c.online ? 'Video call' : 'User is offline',
      html: icons.cam,
      onclick: (e: Event) => { e.stopPropagation(); this.opts.onCall(c, 'video'); },
    });
    const msgBtn = h('button', {
      class: 'btn btn-sm',
      type: 'button',
      disabled: !c.online,
      title: c.online ? 'Message' : 'User is offline',
      html: icons.chat,
      onclick: (e: Event) => { e.stopPropagation(); this.opts.onMessage(c); },
    });

    return h(
      'div',
      { class: `contact-row ${c.online ? 'is-online' : ''}` },
      h('div', { class: 'contact-info' }, onlineEl, h('div', { class: 'contact-text' }, nameEl, phoneEl)),
      h('div', { class: 'contact-actions' }, ...(saveBtn && isSearchResult ? [saveBtn] : []), audioBtn, videoBtn, msgBtn),
    );
  }
}
