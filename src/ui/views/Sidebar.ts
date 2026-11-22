import type { AppContext } from '../../app';
import { formatDuration } from '../../core/format';
import type { CallHistoryEntry, CallOutcome } from '../../services/CallHistoryService';
import type { MediaKind } from '../../types/signaling';
import type { PresenceStatus } from '../../types/state';
import { backStack } from '../BackStack';
import { confirmDialog } from './ConfirmDialog';
import { colorFor, h, initials, nodes } from '../dom';
import { icons } from '../icons';

function shortTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const days = (now.getTime() - ts) / 86_400_000;
  return days < 6 ? d.toLocaleDateString([], { weekday: 'short' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

const STATUS_TEXT: Record<PresenceStatus | 'away' | 'dnd', string> = { online: 'Online', away: 'Away', dnd: 'Do not disturb', offline: 'Offline', connecting: 'Connecting', unknown: 'Unknown' };
const LONG_PRESS_MS = 450;

export type SidebarPane = 'people' | 'live' | 'calls';

export interface SidebarCallbacks {
  /** Open the conversation with a contact. */
  onOpenContact: (userId: string) => void;
  /** 1:1 call (decides between WebRTC and the offline dialog). */
  onCall: (userId: string, media: MediaKind) => void;
  /** Group call with the selected contacts. */
  onGroupCall: (userIds: string[], media: MediaKind) => void;
  /** Desktop tab change (mobile uses the bottom navigation). */
  onPane: (pane: SidebarPane) => void;
  /** Start a live stream (Live tab). */
  onGoLive: () => void;
  /** Open a drop-in invite (Live tab). */
  onNewInvite: () => void;
  /** Initiator: end an open invite (asks first). */
  onEndInvite: () => void;
}

const OUTCOME_TEXT: Record<CallOutcome, string> = {
  answered: '',
  missed: 'Missed',
  declined: 'Declined',
  'no-answer': 'No answer',
  cancelled: 'Cancelled',
  busy: 'Busy',
  failed: 'Failed',
  elsewhere: 'Answered elsewhere',
};

function when(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * People (contacts), Live (streams) and Calls (history) panes.
 *  - tap a contact → conversation · long-press / right-click → call buttons on that row
 *  - search and multi-select stay out of the way until their icon is tapped
 */
export class Sidebar {
  readonly el: HTMLElement;
  private pane: SidebarPane = 'people';
  private tabs = h('div', { class: 'panel-tabs side-tabs', role: 'tablist', 'aria-label': 'Sections' });
  private users = h('ul', { class: 'user-list', 'aria-label': 'Contacts' });
  private streams = h('ul', { class: 'stream-list', 'aria-label': 'Live streams' });
  private invites = h('ul', { class: 'stream-list invite-list', 'aria-label': 'Invites' });
  private calls = h('ul', { class: 'call-list', 'aria-label': 'Recent calls' });
  private filter = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search contacts', enterkeyhint: 'search' });
  /** The search icon itself expands into the field (same toolbar row). */
  private searchBox = h('div', { class: 'search-box', role: 'search' });
  private searchBtn = h('button', { class: 'icon-btn search-toggle', type: 'button', 'aria-label': 'Search contacts', title: 'Search', 'aria-expanded': 'false', html: icons.search });
  private searchClose = h('button', { class: 'icon-btn search-close', type: 'button', 'aria-label': 'Close search', tabindex: -1, html: icons.close });
  private countEl = h('span', { class: 'list-count' });
  private selectBtn = h('button', { class: 'icon-btn', type: 'button' });
  private toolbar = h('div', { class: 'list-toolbar' });
  private searchOpen = false;
  private selectBar = h('div', { class: 'select-bar', hidden: true, role: 'region', 'aria-label': 'Group call' });
  private panes: Record<SidebarPane, HTMLElement>;
  /** null = not selecting. */
  private selected: Set<string> | null = null;
  /** Contact whose row currently shows its call buttons (long-press). */
  private actionsFor: string | null = null;
  private suppressClick = false;
  private back: Partial<Record<'search' | 'select', () => void>> = {};

  constructor(
    private readonly app: AppContext,
    private readonly cb: SidebarCallbacks,
  ) {
    this.filter.addEventListener('input', () => this.renderUsers());
    // Built once (re-rendering would drop typing focus); render only updates state.
    this.filter.tabIndex = -1;
    this.searchBtn.addEventListener('click', () => (this.searchOpen ? this.filter.focus() : this.setSearch(true)));
    this.searchClose.addEventListener('click', () => this.setSearch(false));
    this.filter.addEventListener('keydown', (e) => e.key === 'Escape' && (e.stopPropagation(), this.setSearch(false)));
    this.selectBtn.addEventListener('click', () => this.setSelecting(this.selected === null));
    this.searchBox.append(this.searchBtn, this.filter, this.searchClose);
    this.toolbar.append(this.countEl, this.searchBox, this.selectBtn);
    const liveHead = h(
      'div',
      { class: 'pane-head' },
      h('h2', {}, 'Live now'),
    );
    this.panes = {
      people: h('section', { class: 'side-section', id: 'people', 'aria-label': 'People' }, this.toolbar, this.invites, this.users),
      live: h('section', { class: 'side-section', id: 'live', 'aria-label': 'Live now' }, liveHead, this.streams),
      calls: h('section', { class: 'side-section', id: 'calls', 'aria-label': 'Recent calls' }, h('h2', {}, 'Recent calls'), this.calls),
    };
    this.el = h('aside', { class: 'sidebar' }, this.tabs, this.panes.people, this.panes.live, this.panes.calls, this.selectBar);
    // Tap anywhere else hides a row's call buttons.
    document.addEventListener('click', (e) => {
      if (this.actionsFor && !(e.target as Element).closest?.('.user.actions')) this.showActions(null);
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.actionsFor && this.showActions(null));
    app.history.events.on('change', () => {
      if (this.pane === 'calls') this.app.history.markSeen();
      this.renderCalls();
      this.renderUsers();
      this.renderTabs();
    });
    this.setPane('people');
  }

  setPane(pane: SidebarPane): void {
    this.pane = pane;
    for (const [id, el] of Object.entries(this.panes)) el.hidden = id !== pane;
    this.el.dataset.pane = pane;
    if (pane !== 'people') this.setSelecting(false);
    if (pane === 'calls') this.app.history.markSeen();
    this.renderTabs();
    this.render();
  }

  render(): void {
    this.renderTabs();
    this.renderUsers();
    this.renderStreams();
    this.renderCalls();
  }

  private renderTabs(): void {
    const me = this.app.identity.deviceId;
    const live = this.app.live.list().filter((s) => s.hostId !== me).length;
    const tab = (id: SidebarPane, label: string, badge?: number) =>
      h(
        'button',
        { class: 'panel-tab', role: 'tab', type: 'button', 'aria-selected': String(this.pane === id), onclick: () => this.cb.onPane(id) },
        label,
        ...nodes(badge ? h('span', { class: 'badge' }, String(badge)) : null),
      );
    this.tabs.replaceChildren(tab('people', 'People'), tab('live', 'Live', live), tab('calls', 'Calls', this.pane === 'calls' ? 0 : this.app.history.unseenMissed()));
  }

  // ── people ───────────────────────────────────────────────────────────────

  private setSearch(open: boolean, viaBack = false): void {
    if (this.searchOpen === open) return;
    this.searchOpen = open;
    this.searchBox.classList.toggle('open', open);
    this.toolbar.classList.toggle('searching', open);
    this.searchBtn.setAttribute('aria-expanded', String(open));
    this.filter.tabIndex = open ? 0 : -1;
    this.searchClose.tabIndex = open ? 0 : -1;
    if (open) {
      this.back.search = backStack.push(() => this.setSearch(false, true));
      this.filter.focus({ preventScroll: true });
    } else {
      if (!viaBack) this.back.search?.();
      delete this.back.search;
      this.filter.value = '';
    }
    this.renderUsers();
  }

  private setSelecting(on: boolean, viaBack = false): void {
    if ((this.selected !== null) === on) return;
    this.selected = on ? new Set() : null;
    this.showActions(null);
    if (on) this.back.select = backStack.push(() => this.setSelecting(false, true));
    else {
      if (!viaBack) this.back.select?.();
      delete this.back.select;
    }
    this.renderUsers();
  }

  private showActions(userId: string | null): void {
    if (this.actionsFor === userId) return;
    this.actionsFor = userId;
    this.renderUsers();
  }

  private renderToolbar(count: number): void {
    const selecting = this.selected !== null;
    this.countEl.textContent = selecting ? 'Select' : count ? `${count} online` : '';
    const label = selecting ? 'Cancel selection' : 'Select people for a group call';
    if (this.selectBtn.getAttribute('aria-label') !== label) {
      this.selectBtn.setAttribute('aria-label', label);
      this.selectBtn.title = selecting ? 'Cancel' : 'Select for group call';
      this.selectBtn.setAttribute('aria-pressed', String(selecting));
      this.selectBtn.innerHTML = selecting ? icons.close : icons.select;
    }
  }

  renderUsers(): void {
    const q = this.filter.value.trim().toLowerCase();
    const all = this.app.presence.contacts();
    const users = all.filter((u) => !q || u.name.toLowerCase().includes(q));
    this.renderToolbar(all.filter((u) => u.status === 'online').length);
    this.renderSelectBar();
    if (!users.length) {
      this.users.replaceChildren(h('li', { class: 'empty' }, q ? 'No match' : 'No one here yet'));
      return;
    }
    const selecting = this.selected !== null;
    this.users.replaceChildren(
      ...users.map((u) => {
        const unread = this.app.dms.unreadFor(u.deviceId);
        const last = this.lastActivity(u.deviceId);
        const picked = !!this.selected?.has(u.deviceId);
        const actions = !selecting && this.actionsFor === u.deviceId;
        const row = h(
          'button',
          {
            class: 'user-row',
            type: 'button',
            'aria-label': `${u.name}, ${u.onCall ? 'in a call' : STATUS_TEXT[u.status === 'online' && u.away ? 'away' : u.status]}${unread ? `, ${unread} unread` : ''}`,
            'aria-pressed': selecting ? String(picked) : undefined,
          },
          ...nodes(selecting ? h('span', { class: `pick${picked ? ' on' : ''}`, html: picked ? icons.check : '', 'aria-hidden': 'true' }) : null),
          h(
            'span',
            { class: 'me-avatar' },
            h('span', { class: 'avatar', style: `--avatar:${colorFor(u.deviceId)}` }, initials(u.name)),
            h('span', { class: `presence-dot ${u.onCall ? 'busy' : u.status === 'online' && u.dnd ? 'dnd' : u.status === 'online' && u.away ? 'away' : u.status}`, title: u.onCall ? 'On a call' : u.status === 'online' && u.dnd ? 'Do not disturb' : STATUS_TEXT[u.status === 'online' && u.away ? 'away' : u.status], 'aria-hidden': 'true' }),
          ),
          h('span', { class: 'grow user-info' }, h('span', { class: 'user-name' }, u.name), ...nodes(u.onCall && u.status === 'online' ? h('span', { class: 'user-last on-call' }, 'On a call') : last ? h('span', { class: 'user-last' }, last.text) : null)),
          ...nodes(
            last ? h('span', { class: 'user-time' }, last.time) : null,
            unread && !actions ? h('span', { class: 'badge' }, unread > 9 ? '9+' : String(unread)) : null,
          ),
        );
        this.bindRow(row, u.deviceId);
        return h(
          'li',
          { class: `user ${u.status}${actions ? ' actions' : ''}${picked ? ' picked' : ''}`, 'data-user': u.deviceId },
          row,
          ...nodes(
            actions
              ? h(
                  'span',
                  { class: 'row-actions' },
                  h('button', { class: 'icon-btn call-btn', type: 'button', 'aria-label': `Audio call ${u.name}`, title: 'Audio call', html: icons.phone, onclick: () => (this.showActions(null), this.cb.onCall(u.deviceId, 'audio')) }),
                  h('button', { class: 'icon-btn call-btn', type: 'button', 'aria-label': `Video call ${u.name}`, title: 'Video call', html: icons.cam, onclick: () => (this.showActions(null), this.cb.onCall(u.deviceId, 'video')) }),
                )
              : null,
          ),
        );
      }),
    );
  }

  /** Latest message or call with this person, as a one-line preview. */
  private lastActivity(peerId: string): { text: string; time: string } | null {
    const msgs = this.app.dms.conversation(peerId).messages;
    const m = msgs[msgs.length - 1];
    const call = this.app.history.list().filter((e) => e.peers.some((p) => p.deviceId === peerId)).sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!m && !call) return null;
    if (m && (!call || m.timestamp >= call.startedAt)) return { text: m.deleted ? 'Deleted message' : `${m.own ? 'You: ' : ''}${m.file ? `📎 ${m.text ? m.text.replace(/\s+/g, ' ') : m.file.name}` : m.text.replace(/\s+/g, ' ')}`, time: shortTime(m.timestamp) };
    const c = call!;
    const kind = c.media === 'video' ? 'video call' : 'call';
    const text =
      c.outcome === 'answered' ? `${c.direction === 'incoming' ? 'Incoming' : 'Outgoing'} ${kind}${c.durationMs ? ` · ${Math.max(1, Math.round(c.durationMs / 60000))} min` : ''}` :
      c.outcome === 'missed' || c.outcome === 'no-answer' ? `Missed ${kind}` :
      c.outcome === 'declined' ? `Declined ${kind}` :
      c.outcome === 'cancelled' ? `Cancelled ${kind}` :
      `${c.direction === 'incoming' ? 'Incoming' : 'Outgoing'} ${kind}`;
    return { text: `📞 ${text}`, time: shortTime(c.startedAt) };
  }

  /** Tap → open (or toggle when selecting); long-press / right-click → call buttons. */
  private bindRow(row: HTMLElement, userId: string): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number } | null = null;
    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      start = null;
    };
    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.selected) return;
      start = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        timer = undefined;
        // Ignore the click that ends this press. The row is re-rendered under the finger, so
        // that click may never reach it – always clear the flag shortly after the release.
        this.suppressClick = true;
        document.addEventListener('pointerup', () => setTimeout(() => (this.suppressClick = false), 60), { once: true });
        navigator.vibrate?.(15);
        this.startSelectWith(userId);
      }, LONG_PRESS_MS);
    });
    row.addEventListener('pointermove', (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); // scrolling
    });
    row.addEventListener('pointerup', cancel);
    row.addEventListener('pointercancel', cancel);
    row.addEventListener('pointerleave', cancel);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault(); // right-click (desktop) = long-press; also stops the mobile context menu
      if (this.selected) return;
      cancel();
      this.suppressClick = true;
      this.startSelectWith(userId);
      setTimeout(() => (this.suppressClick = false), 0);
    });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      if (this.selected) return this.toggle(userId);
      if (this.actionsFor) return this.showActions(null);
      this.cb.onOpenContact(userId);
    });
  }

  /** Long-press / right-click: enter selection mode with this person already picked. */
  private startSelectWith(userId: string): void {
    this.setSelecting(true);
    this.selected?.add(userId);
    this.renderUsers();
  }

  private toggle(userId: string): void {
    const sel = this.selected;
    if (!sel) return;
    if (sel.has(userId)) sel.delete(userId);
    else sel.add(userId);
    if (!sel.size) return this.setSelecting(false); // last one unticked → leave selection mode
    this.renderUsers();
  }

  private selMenuOpen = false;

  private async removeSelected(): Promise<void> {
    const ids = [...(this.selected ?? [])];
    if (!ids.length) return;
    const names = ids.map((id) => this.app.presence.nameOf(id));
    const label = ids.length === 1 ? names[0]! : `${ids.length} people`;
    if (!(await confirmDialog({ title: `Remove ${label}?`, message: 'They are removed from your contacts and the conversations are deleted.', confirmLabel: 'Remove', danger: true, icon: icons.trash }))) return;
    for (const id of ids) {
      this.app.dms.deleteConversation(id);
      this.app.presence.removeContact(id);
    }
    this.setSelecting(false);
  }

  private renderSelectBar(): void {
    const sel = this.selected;
    this.selectBar.hidden = !sel;
    if (!sel) {
      this.selMenuOpen = false;
      return;
    }
    const max = this.app.config.mesh.maxParticipants - 1;
    const n = sel.size;
    const ids = [...sel];
    const start = (media: MediaKind) => {
      this.setSelecting(false);
      if (ids.length === 1) this.cb.onCall(ids[0]!, media);
      else this.cb.onGroupCall(ids, media);
    };
    const tooMany = n > max;
    const allMuted = n > 0 && ids.every((id) => this.app.dms.isMuted(id));
    const everyone = this.visibleIds();
    const item = (icon: string, label: string, run: () => void, cls = '') =>
      h('button', { class: `menu-item ${cls}`.trim(), role: 'menuitem', type: 'button', onclick: () => ((this.selMenuOpen = false), run()) }, h('span', { html: icon }), label);
    const menu = this.selMenuOpen
      ? h(
          'div',
          { class: 'more-menu sel-menu', role: 'menu' },
          ...nodes(
            n === 1 ? item(icons.chat, 'Message', () => (this.setSelecting(false), this.cb.onOpenContact(ids[0]!))) : null,
            item(icons.check, n === everyone.length ? 'Unselect all' : 'Select all', () => {
              if (n === everyone.length) this.setSelecting(false);
              else {
                everyone.forEach((id) => sel.add(id));
                this.renderUsers();
              }
            }),
            item(allMuted ? icons.bell : icons.bellOff, allMuted ? 'Unmute' : 'Mute', () => {
              ids.forEach((id) => this.app.dms.setMuted(id, !allMuted));
              this.renderSelectBar();
            }),
            item(icons.trash, 'Remove', () => void this.removeSelected(), 'danger'),
          ),
        )
      : null;
    this.selectBar.replaceChildren(
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Cancel selection', title: 'Cancel', html: icons.close, onclick: () => this.setSelecting(false) }),
      h('span', { class: 'grow' }, n ? `${n} selected` : 'Tap people to select'),
      h('button', { class: 'icon-btn call-btn', type: 'button', disabled: n === 0 || tooMany, 'aria-label': 'Audio call', title: tooMany ? `Max ${max} people` : 'Audio call', html: icons.phone, onclick: () => start('audio') }),
      h('button', { class: 'icon-btn call-btn', type: 'button', disabled: n === 0 || tooMany, 'aria-label': 'Video call', title: tooMany ? `Max ${max} people` : 'Video call', html: icons.cam, onclick: () => start('video') }),
      h('button', { class: 'icon-btn', type: 'button', disabled: n === 0, 'aria-label': 'More', title: 'More', html: icons.more, onclick: () => ((this.selMenuOpen = !this.selMenuOpen), this.renderSelectBar()) }),
      ...nodes(menu),
    );
  }

  /** Contacts currently listed (respects the search filter). */
  private visibleIds(): string[] {
    return [...this.panes.people.querySelectorAll<HTMLElement>('[data-user]')].map((e) => e.dataset.user!).filter(Boolean);
  }

  // ── live ─────────────────────────────────────────────────────────────────

  renderStreams(): void {
    this.renderInvites();
    const streams = this.app.live.list().filter((s) => s.hostId !== this.app.identity.deviceId);
    this.renderTabs();
    if (!streams.length) {
      this.streams.replaceChildren(h('li', { class: 'empty' }, 'No live streams'));
      return;
    }
    const inCall = this.app.calls.inCall;
    this.streams.replaceChildren(
      ...streams.map((s) =>
        h(
          'li',
          { class: 'stream' },
          h('span', { class: 'live-dot' }, 'LIVE'),
          h('div', { class: 'grow' }, h('span', {}, s.title), h('small', {}, `${s.audienceMode === 'selected' ? 'Private · ' : ''}${s.hostName} · ${s.viewers}/${s.maxViewers} viewers · ${formatDuration(Date.now() - s.startedAt)}`)),
          h('button', { class: 'btn small', disabled: inCall || s.viewers >= s.maxViewers, onclick: () => this.app.live.join(s.streamId) }, 'Watch'),
        ),
      ),
    );
  }

  private renderInvites(): void {
    const list = this.app.invites.list();
    this.invites.hidden = !list.length; // invites only appear while one is open
    if (!list.length) {
      this.invites.replaceChildren();
      return;
    }
    const me = this.app.identity.deviceId;
    const inCall = this.app.calls.inCall;
    this.invites.replaceChildren(
      ...list.map((inv) => {
        const mine = inv.hostId === me;
        const inIt = this.app.invites.isIn(inv.inviteId);
        const meta = `${inv.audienceMode === 'selected' ? 'Private · ' : ''}${mine ? 'You' : inv.hostName} · ${inv.media === 'audio' ? 'Audio' : 'Video'} · ${formatDuration(Date.now() - inv.startedAt)}`;
        return h(
          'li',
          { class: 'stream invite' },
          h('span', { class: 'invite-icon', html: inv.media === 'audio' ? icons.phone : icons.cam, 'aria-hidden': 'true' }),
          h('div', { class: 'grow' }, h('span', {}, inv.title), h('small', {}, meta)),
          inIt
            ? h('span', { class: 'badge-in' }, 'Joined')
            : h('button', { class: 'btn small primary', disabled: inCall, title: inCall ? 'Leave your current call first' : '', onclick: () => void this.app.invites.join(inv.inviteId) }, 'Join'),
          mine ? h('button', { class: 'btn small danger', onclick: () => this.cb.onEndInvite() }, 'End') : null,
        );
      }),
    );
  }

  // ── calls (history) ──────────────────────────────────────────────────────

  /** Presence changed: "Join" badges on the Calls tab may appear/disappear. */
  refreshCalls(): void {
    if (this.pane === 'calls') this.renderCalls();
  }

  private renderCalls(): void {
    const entries = this.app.history.list();
    if (!entries.length) {
      this.calls.replaceChildren(h('li', { class: 'empty' }, 'No calls yet'));
      return;
    }
    this.calls.replaceChildren(...entries.map((e) => this.callRow(e)));
  }

  private callRow(e: CallHistoryEntry): HTMLLIElement {
    const group = e.kind === 'group' || e.peers.length > 1;
    const names = e.peers.map((p) => p.name).join(', ');
    // A named group shows its name; the default title would say nothing, so list who was in it.
    const name = group ? (e.title && e.title !== 'Group call' ? e.title : names || 'Group call') : (e.peers[0]?.name ?? 'Unknown');
    const bad = e.outcome !== 'answered' && e.outcome !== 'elsewhere';
    const missed = e.direction === 'incoming' && (e.outcome === 'missed' || e.outcome === 'declined');
    const detail = [OUTCOME_TEXT[e.outcome], e.outcome === 'answered' ? formatDuration(e.durationMs) : '', when(e.startedAt)].filter(Boolean).join(' · ');
    // Group call that is still running without us → joining beats ringing everyone again.
    const liveWith = group && !this.app.calls.inCall ? this.app.presence.inCallWith(e.callId) : null;
    const callBack = () => {
      if (liveWith) {
        this.app.calls.requestJoin(e.callId, liveWith, name);
        return;
      }
      const ids = e.peers.map((p) => p.deviceId);
      if (group) this.cb.onGroupCall(ids, e.media);
      else if (ids[0]) this.cb.onCall(ids[0], e.media);
    };
    return h(
      'li',
      { class: `call-entry${missed ? ' missed' : ''}`, 'data-call': e.callId },
      h(
        'button',
        { class: 'user-row', type: 'button', 'aria-label': `${e.media === 'video' ? 'Video' : 'Audio'} call ${name}, ${e.direction}, ${detail} – call back`, onclick: callBack },
        group
          ? h('span', { class: 'avatar group-avatar', html: icons.users })
          : h('span', { class: 'avatar', style: `--avatar:${colorFor(e.peers[0]?.deviceId ?? '')}` }, initials(name)),
        h(
          'span',
          { class: 'grow user-info' },
          h('span', { class: 'user-name' }, name),
          h('small', { class: `call-detail${bad ? ' bad' : ''}` }, h('span', { class: 'call-dir', html: e.direction === 'incoming' ? icons.callIn : icons.callOut, 'aria-hidden': 'true' }), detail),
        ),
        liveWith ? h('span', { class: 'badge-join' }, 'Join') : h('span', { class: 'call-media', html: e.media === 'video' ? icons.cam : icons.phone, 'aria-hidden': 'true' }),
      ),
    );
  }
}
