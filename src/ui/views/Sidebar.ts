import type { AppContext } from '../../app';
import { formatDuration } from '../../core/format';
import type { CallHistoryEntry, CallOutcome } from '../../services/CallHistoryService';
import type { MediaKind } from '../../types/signaling';
import type { PresenceStatus } from '../../types/state';
import { backStack } from '../BackStack';
import { colorFor, h, initials, nodes } from '../dom';
import { icons } from '../icons';

const STATUS_TEXT: Record<PresenceStatus, string> = { online: 'Online', offline: 'Offline', connecting: 'Connecting', unknown: 'Unknown' };
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
      h('button', { class: 'icon-btn go-live-btn', type: 'button', 'aria-label': 'Go live', title: 'Go live', html: icons.live, onclick: () => this.cb.onGoLive() }),
    );
    this.panes = {
      people: h('section', { class: 'side-section', id: 'people', 'aria-label': 'People' }, this.toolbar, this.users),
      live: h('section', { class: 'side-section', id: 'live', 'aria-label': 'Live now' }, liveHead, this.streams),
      calls: h('section', { class: 'side-section', id: 'calls', 'aria-label': 'Recent calls' }, h('h2', {}, 'Recent calls'), this.calls),
    };
    this.el = h('aside', { class: 'sidebar' }, this.tabs, this.panes.people, this.panes.live, this.panes.calls, this.selectBar);
    // Tap anywhere else hides a row's call buttons.
    document.addEventListener('click', (e) => {
      if (this.actionsFor && !(e.target as Element).closest?.('.user.actions')) this.showActions(null);
    });
    document.addEventListener('keydown', (e) => e.key === 'Escape' && this.actionsFor && this.showActions(null));
    app.history.events.on('change', () => this.renderCalls());
    this.setPane('people');
  }

  setPane(pane: SidebarPane): void {
    this.pane = pane;
    for (const [id, el] of Object.entries(this.panes)) el.hidden = id !== pane;
    this.el.dataset.pane = pane;
    if (pane !== 'people') this.setSelecting(false);
    this.render();
  }

  render(): void {
    this.renderTabs();
    this.renderUsers();
    this.renderStreams();
    this.renderCalls();
  }

  private renderTabs(): void {
    const live = this.app.live.list().filter((s) => s.hostId !== this.app.identity.deviceId).length;
    const tab = (id: SidebarPane, label: string, badge?: number) =>
      h(
        'button',
        { class: 'panel-tab', role: 'tab', type: 'button', 'aria-selected': String(this.pane === id), onclick: () => this.cb.onPane(id) },
        label,
        ...nodes(badge ? h('span', { class: 'badge' }, String(badge)) : null),
      );
    this.tabs.replaceChildren(tab('people', 'People'), tab('live', 'Live', live), tab('calls', 'Calls'));
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
    this.countEl.textContent = selecting ? 'Select people' : count ? `${count} ${count === 1 ? 'person' : 'people'}` : '';
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
    this.renderToolbar(all.length);
    this.renderSelectBar();
    if (!users.length) {
      this.users.replaceChildren(h('li', { class: 'empty' }, q ? 'No match' : 'No one here yet'));
      return;
    }
    const selecting = this.selected !== null;
    this.users.replaceChildren(
      ...users.map((u) => {
        const unread = this.app.dms.unreadFor(u.deviceId);
        const picked = !!this.selected?.has(u.deviceId);
        const actions = !selecting && this.actionsFor === u.deviceId;
        const row = h(
          'button',
          {
            class: 'user-row',
            type: 'button',
            'aria-label': `${u.name}, ${u.busy ? 'in a call' : STATUS_TEXT[u.status]}${unread ? `, ${unread} unread` : ''}`,
            'aria-pressed': selecting ? String(picked) : undefined,
          },
          ...nodes(selecting ? h('span', { class: `pick${picked ? ' on' : ''}`, html: picked ? icons.check : '', 'aria-hidden': 'true' }) : null),
          h('span', { class: 'avatar', style: `--avatar:${colorFor(u.deviceId)}` }, initials(u.name)),
          h('span', { class: 'grow user-info' }, h('span', { class: 'user-name' }, u.name)),
          ...nodes(
            unread && !actions ? h('span', { class: 'badge' }, unread > 9 ? '9+' : String(unread)) : null,
            actions ? null : h('span', { class: `status-dot ${u.busy ? 'busy' : u.status}`, title: u.busy ? 'In a call' : STATUS_TEXT[u.status], 'aria-hidden': 'true' }),
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
        this.showActions(userId);
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
      this.showActions(userId);
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

  private toggle(userId: string): void {
    const sel = this.selected;
    if (!sel) return;
    const max = this.app.config.mesh.maxParticipants - 1;
    if (sel.has(userId)) sel.delete(userId);
    else if (sel.size < max) sel.add(userId);
    this.renderUsers();
  }

  private renderSelectBar(): void {
    const sel = this.selected;
    this.selectBar.hidden = !sel;
    if (!sel) return;
    const max = this.app.config.mesh.maxParticipants - 1;
    const n = sel.size;
    const start = (media: MediaKind) => {
      const ids = [...sel];
      this.setSelecting(false);
      this.cb.onGroupCall(ids, media);
    };
    this.selectBar.replaceChildren(
      h('span', { class: 'grow' }, n ? `${n} selected${n >= max ? ` (max ${max})` : ''}` : 'Tap people to select'),
      h('button', { class: 'icon-btn call-btn', type: 'button', disabled: n === 0, 'aria-label': 'Group audio call', title: 'Audio call', html: icons.phone, onclick: () => start('audio') }),
      h('button', { class: 'icon-btn call-btn', type: 'button', disabled: n === 0, 'aria-label': 'Group video call', title: 'Video call', html: icons.cam, onclick: () => start('video') }),
    );
  }

  // ── live ─────────────────────────────────────────────────────────────────

  renderStreams(): void {
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

  // ── calls (history) ──────────────────────────────────────────────────────

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
    const callBack = () => {
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
        h('span', { class: 'call-media', html: e.media === 'video' ? icons.cam : icons.phone, 'aria-hidden': 'true' }),
      ),
    );
  }
}
