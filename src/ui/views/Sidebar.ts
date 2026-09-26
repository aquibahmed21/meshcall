import type { AppContext } from '../../app';
import { formatDuration } from '../../core/format';
import type { PresenceStatus } from '../../types/state';
import { colorFor, h, initials } from '../dom';
import { icons } from '../icons';

const STATUS_TEXT: Record<PresenceStatus, string> = { online: 'Online', offline: 'Offline', connecting: 'Connecting', unknown: 'Unknown' };

export interface SidebarCallbacks {
  onGroup: () => void;
  onGoLive: () => void;
}

/** Contacts with presence + live streams. */
export class Sidebar {
  readonly el: HTMLElement;
  private me = h('div', { class: 'me' });
  private users = h('ul', { class: 'user-list', 'aria-label': 'Users' });
  private streams = h('ul', { class: 'stream-list', 'aria-label': 'Live streams' });
  private filter = h('input', { type: 'search', placeholder: 'Search people', 'aria-label': 'Search people' });

  constructor(
    private readonly app: AppContext,
    cb: SidebarCallbacks,
  ) {
    this.filter.addEventListener('input', () => this.renderUsers());
    this.el = h(
      'aside',
      { class: 'sidebar' },
      this.me,
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
    const { identity, signaling } = this.app;
    this.me.replaceChildren(
      h('span', { class: 'avatar', style: `--avatar:${colorFor(identity.deviceId)}` }, initials(identity.displayName)),
      h('div', { class: 'grow' }, h('strong', {}, identity.displayName), h('small', { class: `sig ${signaling.status}` }, signaling.status === 'connected' ? '● Online' : `○ ${signaling.status}`)),
    );
    this.renderUsers();
    this.renderStreams();
  }

  renderUsers(): void {
    const q = this.filter.value.trim().toLowerCase();
    const inCall = this.app.calls.inCall;
    const users = this.app.presence.list().filter((u) => !q || u.name.toLowerCase().includes(q));
    if (!users.length) {
      this.users.replaceChildren(h('li', { class: 'empty' }, q ? 'No match' : 'No one yet – open this app on another device or browser.'));
      return;
    }
    this.users.replaceChildren(
      ...users.map((u) => {
        const reachable = u.status === 'online' || u.pushEnabled;
        const call = (media: 'audio' | 'video') => () => void this.app.calls.startDirectCall(u.deviceId, media);
        return h(
          'li',
          { class: `user ${u.status}` },
          h('span', { class: 'avatar', style: `--avatar:${colorFor(u.deviceId)}` }, initials(u.name)),
          h(
            'div',
            { class: 'grow user-info' },
            h('span', { class: 'user-name' }, u.name),
            h('small', { class: `presence ${u.status}` }, `${u.status === 'online' ? '●' : '○'} ${u.busy ? 'In a call' : STATUS_TEXT[u.status]}`, u.status === 'offline' && u.pushEnabled ? ' · push' : ''),
          ),
          h('button', { class: 'icon-btn', title: `Audio call ${u.name}`, 'aria-label': `Audio call ${u.name}`, html: icons.phone, disabled: inCall || !reachable, onclick: call('audio') }),
          h('button', { class: 'icon-btn', title: `Video call ${u.name}`, 'aria-label': `Video call ${u.name}`, html: icons.cam, disabled: inCall || !reachable, onclick: call('video') }),
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
          h('div', { class: 'grow' }, h('span', {}, s.title), h('small', {}, `${s.hostName} · ${s.viewers}/${s.maxViewers} viewers · ${formatDuration(Date.now() - s.startedAt)}`)),
          h('button', { class: 'btn small', disabled: inCall || s.viewers >= s.maxViewers, onclick: () => this.app.live.join(s.streamId) }, 'Watch'),
        ),
      ),
    );
  }
}
