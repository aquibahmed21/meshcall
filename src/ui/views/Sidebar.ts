import type { AppContext } from '../../app';
import { formatDuration } from '../../core/format';
import type { PresenceStatus } from '../../types/state';
import { colorFor, h, initials, nodes } from '../dom';
import { icons } from '../icons';

const STATUS_TEXT: Record<PresenceStatus, string> = { online: 'Online', offline: 'Offline', connecting: 'Connecting', unknown: 'Unknown' };

export interface SidebarCallbacks {
  onGroup: () => void;
  onGoLive: () => void;
  /** Open the conversation with a contact (calls are started from there). */
  onOpenContact: (userId: string) => void;
}

/** Contacts with presence + live streams. */
export class Sidebar {
  readonly el: HTMLElement;
  private users = h('ul', { class: 'user-list', 'aria-label': 'Contacts' });
  private streams = h('ul', { class: 'stream-list', 'aria-label': 'Live streams' });
  private filter = h('input', { type: 'search', placeholder: 'Search', 'aria-label': 'Search contacts' });

  constructor(
    private readonly app: AppContext,
    private readonly cb: SidebarCallbacks,
  ) {
    this.filter.addEventListener('input', () => this.renderUsers());
    this.el = h(
      'aside',
      { class: 'sidebar' },
      h(
        'div',
        { class: 'sidebar-actions' },
        h('button', { class: 'btn', onclick: cb.onGroup }, h('span', { html: icons.users }), 'Group call'),
        h('button', { class: 'btn', onclick: cb.onGoLive }, h('span', { html: icons.live }), 'Go live'),
      ),
      h('section', { class: 'side-section', id: 'people' }, h('h2', {}, 'People'), this.filter, this.users),
      h('section', { class: 'side-section', id: 'live' }, h('h2', {}, 'Live now'), this.streams),
    );
    this.render();
  }

  render(): void {
    this.renderUsers();
    this.renderStreams();
  }

  /** Each row opens that person's conversation; call buttons live on the conversation page. */
  renderUsers(): void {
    const q = this.filter.value.trim().toLowerCase();
    const users = this.app.presence.contacts().filter((u) => !q || u.name.toLowerCase().includes(q));
    if (!users.length) {
      this.users.replaceChildren(h('li', { class: 'empty' }, q ? 'No match' : 'No one here yet'));
      return;
    }
    this.users.replaceChildren(
      ...users.map((u) => {
        const unread = this.app.dms.unreadFor(u.deviceId);
        return h(
          'li',
          { class: `user ${u.status}`, 'data-user': u.deviceId },
          h(
            'button',
            {
              class: 'user-row',
              type: 'button',
              'aria-label': `${u.name}, ${u.busy ? 'in a call' : STATUS_TEXT[u.status]}${unread ? `, ${unread} unread` : ''}`,
              onclick: () => this.cb.onOpenContact(u.deviceId),
            },
            h('span', { class: 'avatar', style: `--avatar:${colorFor(u.deviceId)}` }, initials(u.name)),
            h(
              'span',
              { class: 'grow user-info' },
              h('span', { class: 'user-name' }, u.name),
              h('small', { class: `presence ${u.status}` }, `${u.status === 'online' ? '●' : '○'} ${u.busy ? 'In a call' : STATUS_TEXT[u.status]}`),
            ),
            ...nodes(unread ? h('span', { class: 'badge' }, unread > 9 ? '9+' : String(unread)) : null),
          ),
        );
      }),
    );
  }

  renderStreams(): void {
    const streams = this.app.live.list().filter((s) => s.hostId !== this.app.identity.deviceId);
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
}
