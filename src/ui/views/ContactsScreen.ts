import { h } from '../dom';
import { icons } from '../icons';
import type { AppContext } from '../../app';
import type { ContactsService, Contact } from '../../services/ContactsService';
import { AdminScreen } from './AdminScreen';
import { isNative } from '../../native/native';
import { colorFor, initials } from '../dom';
import { backStack } from '../BackStack';

export interface ContactsScreenOptions {
  app: AppContext;
  contacts: ContactsService;
  onCall: (contact: Contact, media: 'audio' | 'video') => void;
  onMessage: (contact: Contact) => void;
}

const LONG_PRESS_MS = 450;

function shortTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = (now.getTime() - ts) / 86_400_000;
  return days < 6 ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

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
  private offDms: (() => void) | null = null;
  private _initCalled = false;
  /** Phone number of the row currently showing inline actions */
  private actionsFor: string | null = null;
  private actionsBack: (() => void) | null = null;
  private suppressClick = false;
  private searchWrap: HTMLElement;
  private countEl: HTMLElement;

  constructor(private readonly opts: ContactsScreenOptions) {
    this.searchInput = h('input', {
      type: 'search',
      placeholder: 'Search…',
      class: 'cs-search',
      autocomplete: 'off',
      enterkeyhint: 'search',
    }) as HTMLInputElement;

    this.statusEl = h('p', { class: 'cs-status', hidden: true }, '');
    this.listEl = h('ul', { class: 'user-list cs-list', 'aria-label': 'Contacts' });

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

    this.countEl = h('span', { class: 'cs-online-count' }, '');

    const toolbar = h(
      'div',
      { class: 'cs-toolbar' },
      this.countEl,
      h('div', { class: 'cs-toolbar-actions' },
        h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Search',
          'aria-label': 'Search',
          html: icons.search,
          onclick: () => this.openSearch(),
        }),
        h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Find contacts on MeshCall',
          'aria-label': 'Find contacts on MeshCall',
          html: icons.users,
          onclick: () => void this.discoverDeviceContacts(),
        }),
        ...(adminBtn ? [adminBtn] : []),
      ),
    );

    this.searchWrap = h('div', { class: 'cs-search-wrap', hidden: true },
      this.searchInput,
      h('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Close search',
        html: icons.close,
        onclick: () => this.closeSearch(),
      }),
    );

    this.el = h(
      'div',
      { class: 'cs-screen' },
      toolbar,
      this.searchWrap,
      this.statusEl,
      this.listEl,
    );

    this.searchInput.addEventListener('input', () => this.scheduleSearch());
    this.searchInput.addEventListener('search', () => this.doSearch());

    // Close inline actions when tapping outside
    document.addEventListener('click', (e) => {
      if (this.actionsFor && !this.listEl.contains(e.target as Node)) {
        this.showActions(null);
      }
    });

    this.off = opts.contacts.events.on('change', () => this.renderList());
    this.offPresence = opts.app.presence.events.on('change', () => {
      // Persist the deviceId while the contact is online so DM history
      // is accessible after they go offline or the app restarts.
      for (const c of opts.contacts.contacts) {
        const did = opts.app.presence.deviceIdForPhone(c.phone);
        if (did) opts.contacts.learnDeviceId(c.phone, did);
      }
      this.renderList();
    });
    this.offDms = opts.app.dms.events.on('change', () => this.renderList());
  }

  async init(): Promise<void> {
    if (this._initCalled) return;
    this._initCalled = true;
    this.renderList();
    if (isNative && !this.syncDone) {
      this.syncDone = true;
      // silent background sync on first load — no sheet, just merges into the list
      await this.opts.contacts.syncDeviceContacts();
    } else {
      await this.opts.contacts.refreshOnlineStatus();
    }
  }

  destroy(): void {
    this.off?.();
    this.off = null;
    this.offPresence?.();
    this.offPresence = null;
    this.offDms?.();
    this.offDms = null;
    this._initCalled = false;
  }

  setStatus(msg: string): void {
    this.statusEl.textContent = msg;
    this.statusEl.hidden = !msg;
  }

  private openSearch(): void {
    this.searchWrap.hidden = false;
    this.searchInput.focus();
  }

  private closeSearch(): void {
    this.searchWrap.hidden = true;
    this.searchInput.value = '';
    this.searchResults = [];
    this.renderList();
  }

  private showActions(phone: string | null): void {
    // Release any previous back-stack entry first.
    this.actionsBack?.();
    this.actionsBack = null;
    this.actionsFor = phone;
    if (phone) {
      // Push a back-stack entry so the Android back button dismisses the action strip.
      this.actionsBack = backStack.push(() => {
        this.actionsFor = null;
        this.actionsBack = null;
        this.renderList();
      });
    }
    this.renderList();
  }

  /** Call when the contacts screen becomes visible (e.g. after navigating back from calls). */
  onShow(): void {
    if (this.searchInput.value || !this.searchWrap.hidden) {
      this.searchInput.value = '';
      this.searchWrap.hidden = true;
      this.searchResults = [];
      this.renderList();
    }
  }

  private deviceIdFor(phone: string): string | null {
    // Live presence first; fall back to persisted deviceId stored in the contact record.
    const live = this.opts.app.presence.deviceIdForPhone(phone);
    if (live) return live;
    const c = this.opts.contacts.contacts.find(x => x.phone === phone);
    return c?.deviceId ?? null;
  }

  private isOnline(phone: string): boolean {
    const deviceId = this.opts.app.presence.deviceIdForPhone(phone);
    return deviceId ? this.opts.app.presence.status(deviceId) === 'online' : false;
  }

  private lastActivity(phone: string): { text: string; time: string; ts: number } | null {
    const deviceId = this.deviceIdFor(phone);
    if (!deviceId) return null;
    const msgs = this.opts.app.dms.conversation(deviceId).messages;
    const m = msgs[msgs.length - 1];
    const calls = this.opts.app.history.list()
      .filter(e => e.peers.some(p => p.deviceId === deviceId))
      .sort((a, b) => b.startedAt - a.startedAt);
    const call = calls[0];
    if (!m && !call) return null;
    if (m && (!call || m.timestamp >= call.startedAt)) {
      const text = m.deleted ? 'Deleted message' : `${m.own ? 'You: ' : ''}${m.file ? `📎 ${m.text ? m.text : m.file.name}` : m.text.replace(/\s+/g, ' ')}`;
      return { text, time: shortTime(m.timestamp), ts: m.timestamp };
    }
    const c = call!;
    const kind = c.media === 'video' ? 'video call' : 'call';
    const callText = c.outcome === 'answered'
      ? `📞 ${c.direction === 'incoming' ? 'Incoming' : 'Outgoing'} ${kind}`
      : c.outcome === 'missed' || c.outcome === 'no-answer' ? `📞 Missed ${kind}`
      : `📞 ${kind}`;
    return { text: callText, time: shortTime(c.startedAt), ts: c.startedAt };
  }

  private showAdmin(): void {
    const mount = this.el.parentElement;
    if (!mount) return;
    const admin = new AdminScreen(this.opts.app, () => { mount.replaceChildren(this.el); });
    mount.replaceChildren(admin.el);
    void admin.init();
  }

  private scheduleSearch(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.doSearch(), 300);
  }

  private async doSearch(): Promise<void> {
    const q = this.searchInput.value.trim();
    if (!q) { this.searchResults = []; this.renderList(); return; }
    try {
      this.searchResults = await this.opts.contacts.search(q);
    } catch {
      this.searchResults = [];
    }
    this.renderList();
  }

  /** Tap the device-contacts icon: scan and show a discovery bottom sheet. */
  private async discoverDeviceContacts(): Promise<void> {
    this.setStatus('Scanning device contacts…');
    const found = await this.opts.contacts.syncDeviceContacts();
    this.setStatus('');
    if (!found.length) {
      this.showDiscoverySheet([]);
      return;
    }
    this.showDiscoverySheet(found);
  }

  /** Bottom sheet listing device contacts who are on MeshCall. */
  private showDiscoverySheet(found: Contact[]): void {
    const mount = this.el.parentElement ?? document.body;

    const close = () => sheet.remove();

    const rows = found.length
      ? found.map(c => {
          const saved = this.opts.contacts.has(c.phone);
          return h('li', { class: 'cs-disc-row' },
            h('span', { class: 'me-avatar' },
              h('span', { class: 'avatar', style: `--avatar:${colorFor(c.phone)}` }, initials(c.name)),
            ),
            h('span', { class: 'grow user-info' },
              h('span', { class: 'user-name' }, c.name),
              h('span', { class: 'user-last' }, c.phone),
            ),
            saved
              ? h('button', { class: 'btn small', disabled: true }, 'Saved')
              : h('button', {
                  class: 'btn small primary',
                  type: 'button',
                  onclick: () => {
                    this.opts.contacts.add(c.phone, c.name);
                    this.opts.onMessage(c);
                    close();
                  },
                }, 'Message'),
          );
        })
      : [h('li', { class: 'cs-disc-empty' }, 'None of your device contacts are on MeshCall yet.')];

    const sheet = h('div', { class: 'cs-disc-backdrop', onclick: (e: Event) => { if (e.target === sheet) close(); } },
      h('div', { class: 'cs-disc-sheet' },
        h('div', { class: 'cs-disc-header' },
          h('span', { class: 'cs-disc-title' }, found.length ? `${found.length} contact${found.length !== 1 ? 's' : ''} on MeshCall` : 'No contacts found'),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', html: icons.close, onclick: close }),
        ),
        h('ul', { class: 'cs-disc-list' }, ...rows),
      ),
    );

    mount.appendChild(sheet);
  }

  private renderList(): void {
    const q = this.searchInput.value.trim();

    let items: Contact[];
    if (q) {
      items = this.searchResults;
    } else {
      // Main list: only contacts with call/message history, sorted most-recent first.
      type WithTs = { contact: Contact; ts: number };
      const withTs: WithTs[] = [];
      for (const c of this.opts.contacts.contacts) {
        const a = this.lastActivity(c.phone);
        if (a) withTs.push({ contact: c, ts: a.ts });
      }
      withTs.sort((a, b) => b.ts - a.ts);
      items = withTs.map(x => x.contact);
    }

    const online = this.opts.contacts.contacts.filter(c => this.isOnline(c.phone)).length;
    this.countEl.textContent = `${online} online`;

    if (!items.length) {
      this.listEl.replaceChildren(
        h('li', { class: 'empty' }, q
          ? 'No users found'
          : 'No recent conversations — search to find contacts',
        ),
      );
      return;
    }

    this.listEl.replaceChildren(...items.map(c => this.renderRow(c, !!q)));
  }

  private renderRow(c: Contact, isSearchResult: boolean): HTMLElement {
    const online = this.isOnline(c.phone);
    const activity = this.lastActivity(c.phone);
    const deviceId = this.deviceIdFor(c.phone);
    const unread = deviceId ? this.opts.app.dms.unreadFor(deviceId) : 0;
    const isSaved = this.opts.contacts.has(c.phone);
    const showActions = this.actionsFor === c.phone;

    // Search results: static action buttons — no long-press needed.
    if (isSearchResult) {
      const li = h('li', { class: `user ${online ? 'online' : 'offline'} search-result`, 'data-phone': c.phone },
        h('span', { class: 'me-avatar' },
          h('span', { class: 'avatar', style: `--avatar:${colorFor(c.phone)}` }, initials(c.name)),
          h('span', { class: `presence-dot ${online ? 'online' : 'offline'}`, 'aria-hidden': 'true' }),
        ),
        h('span', { class: 'grow user-info' },
          h('span', { class: 'user-name' }, c.name),
          h('span', { class: 'user-last' }, c.phone),
        ),
        h('span', { class: 'row-actions search-actions' },
          h('button', {
            class: 'icon-btn call-btn',
            type: 'button',
            title: 'Audio call',
            html: icons.phone,
            onclick: (e: Event) => { e.stopPropagation(); if (!isSaved) this.opts.contacts.add(c.phone, c.name); this.opts.onCall(c, 'audio'); },
          }),
          h('button', {
            class: 'icon-btn call-btn',
            type: 'button',
            title: 'Video call',
            html: icons.cam,
            onclick: (e: Event) => { e.stopPropagation(); if (!isSaved) this.opts.contacts.add(c.phone, c.name); this.opts.onCall(c, 'video'); },
          }),
          h('button', {
            class: 'icon-btn',
            type: 'button',
            title: 'Message',
            html: icons.chat,
            onclick: (e: Event) => { e.stopPropagation(); if (!isSaved) this.opts.contacts.add(c.phone, c.name); this.opts.onMessage(c); },
          }),
        ),
      );
      return li;
    }

    // Long-press detection (contact list rows only)
    let pressTimer: ReturnType<typeof setTimeout> | undefined;
    let pressStart: { x: number; y: number } | null = null;

    const cancelPress = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = undefined;
      pressStart = null;
    };

    const row = h('button', {
      class: 'user-row',
      type: 'button',
      'aria-label': `${c.name}`,
      onclick: (e: Event) => {
        e.stopPropagation();
        if (this.suppressClick) { this.suppressClick = false; return; }
        if (this.actionsFor) { this.showActions(null); return; }
        if (!isSaved) this.opts.contacts.add(c.phone, c.name);
        this.opts.onMessage(c);
      },
    },
      h('span', { class: 'me-avatar' },
        h('span', { class: 'avatar', style: `--avatar:${colorFor(c.phone)}` }, initials(c.name)),
        h('span', { class: `presence-dot ${online ? 'online' : 'offline'}`, 'aria-hidden': 'true' }),
      ),
      h('span', { class: 'grow user-info' },
        h('span', { class: 'user-name' }, c.name),
        activity
          ? h('span', { class: 'user-last' }, activity.text)
          : h('span', { class: 'user-last' }, c.phone),
      ),
      ...(activity ? [h('span', { class: 'user-time' }, activity.time)] : []),
      ...(unread && !showActions ? [h('span', { class: 'badge' }, unread > 9 ? '9+' : String(unread))] : []),
    );

    // Long-press to reveal actions
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pressStart = { x: e.clientX, y: e.clientY };
      pressTimer = setTimeout(() => {
        pressTimer = undefined;
        this.suppressClick = true;
        document.addEventListener('pointerup', () => setTimeout(() => { this.suppressClick = false; }, 60), { once: true });
        navigator.vibrate?.(15);
        this.showActions(c.phone);
      }, LONG_PRESS_MS);
    });
    row.addEventListener('pointermove', (e) => {
      if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) cancelPress();
    });
    row.addEventListener('pointerup', cancelPress);
    row.addEventListener('pointercancel', cancelPress);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancelPress();
      this.suppressClick = true;
      this.showActions(c.phone);
      setTimeout(() => { this.suppressClick = false; }, 0);
    });

    const li = h('li', { class: `user ${online ? 'online' : 'offline'}${showActions ? ' actions' : ''}`, 'data-phone': c.phone }, row);

    if (showActions) {
      li.append(h('span', { class: 'row-actions' },
        h('button', {
          class: 'icon-btn call-btn',
          type: 'button',
          title: 'Audio call',
          html: icons.phone,
          onclick: () => { this.showActions(null); this.opts.onCall(c, 'audio'); },
        }),
        h('button', {
          class: 'icon-btn call-btn',
          type: 'button',
          title: 'Video call',
          html: icons.cam,
          onclick: () => { this.showActions(null); this.opts.onCall(c, 'video'); },
        }),
        isSaved ? h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Remove contact',
          html: icons.trash,
          onclick: () => { this.showActions(null); this.opts.contacts.remove(c.phone); },
        }) : h('button', {
          class: 'icon-btn',
          type: 'button',
          title: 'Save contact',
          html: icons.userPlus,
          onclick: () => { this.showActions(null); this.opts.contacts.add(c.phone, c.name); },
        }),
      ));
    }

    return li;
  }
}
