import type { AppContext } from '../../app';
import { formatDuration } from '../../core/format';
import type { PresenceStatus } from '../../types/state';
import { colorFor, h, initials, nodes } from '../dom';
import { icons } from '../icons';

const STATUS_TEXT: Record<PresenceStatus, string> = { online: 'Online', offline: 'Offline', connecting: 'Connecting', unknown: 'Unknown' };

export interface SidebarCallbacks {
  onGroup: () => void;
  onGoLive: () => void;
  onInstall: () => void;
  /** Call a user – decides between WebRTC (online) and the offline dialog. */
  onCall: (userId: string, media: 'audio' | 'video') => void;
  onMessage: (userId: string) => void;
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
    private readonly cb: SidebarCallbacks,
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
      ...nodes(
      h('span', { class: 'avatar', style: `--avatar:${colorFor(identity.deviceId)}` }, initials(identity.displayName)),
      h('div', { class: 'grow' }, h('strong', {}, identity.displayName), h('small', { class: `sig ${signaling.status}` }, signaling.status === 'connected' ? '● Online' : `○ ${signaling.status}`)),
      this.app.pwa.installState === 'available' || this.app.pwa.installState === 'ios-manual'
        ? h('button', { class: 'btn small install-btn', title: 'Install MeshCall as an app', onclick: () => this.cb.onInstall() }, h('span', { html: icons.download }), 'Install')
        : null,
      ),
    );
    this.renderUsers();
    this.renderStreams();
  }

  renderUsers(): void {
    const q = this.filter.value.trim().toLowerCase();
    const users = this.app.presence.list().filter((u) => !q || u.name.toLowerCase().includes(q));
    if (!users.length) {
      this.users.replaceChildren(h('li', { class: 'empty' }, q ? 'No match' : 'No one yet – open this app on another device or browser.'));
      return;
    }
    // Buttons are NEVER disabled because someone is offline – the action adapts instead
    // (offline call → explanation dialog, offline message → queued/push delivery).
    this.users.replaceChildren(
      ...users.map((u) => {
        const unread = this.app.dms.unreadFor(u.deviceId);
        // Push status only when it is actually known (presence advertises it only if the push
        // backend can target this user); otherwise say nothing rather than guess.
        const pushNote = u.status !== 'online' && u.pushEnabled ? h('span', { class: 'push-note' }, ' · 🔔 Push enabled') : null;
        return h(
          'li',
          { class: `user ${u.status}`, 'data-user': u.deviceId },
          h('span', { class: 'avatar', style: `--avatar:${colorFor(u.deviceId)}` }, initials(u.name)),
          h(
            'div',
            { class: 'grow user-info' },
            h('span', { class: 'user-name' }, u.name),
            h('small', { class: `presence ${u.status}` }, `${u.status === 'online' ? '●' : '○'} ${u.busy ? 'In a call' : STATUS_TEXT[u.status]}`, pushNote),
          ),
          h('button', { class: 'icon-btn', title: `Audio call ${u.name}`, 'aria-label': `Audio call ${u.name}`, html: icons.phone, onclick: () => this.cb.onCall(u.deviceId, 'audio') }),
          h('button', { class: 'icon-btn', title: `Video call ${u.name}`, 'aria-label': `Video call ${u.name}`, html: icons.cam, onclick: () => this.cb.onCall(u.deviceId, 'video') }),
          h(
            'button',
            { class: 'icon-btn msg-btn', title: `Message ${u.name}`, 'aria-label': `Message ${u.name}${unread ? ` (${unread} unread)` : ''}`, onclick: () => this.cb.onMessage(u.deviceId) },
            h('span', { html: icons.chat }),
            unread ? h('span', { class: 'badge' }, unread > 9 ? '9+' : String(unread)) : null,
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
