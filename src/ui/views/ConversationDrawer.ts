import type { AppContext } from '../../app';
import { MAX_DM_LENGTH, type DirectMessage, type DmStatus } from '../../services/DirectMessageService';
import { colorFor, h, initials, nodes } from '../dom';
import { icons } from '../icons';

const STATUS_TEXT: Record<DmStatus, string> = {
  sending: 'Sending…',
  sent: 'Sent',
  delivered: 'Delivered',
  queued: 'Waiting for recipient',
  'push-accepted': 'Push request accepted',
  failed: 'Failed',
};

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * 1:1 conversation (room-scoped, works in and outside calls). Composer is persistent so focus
 * and drafts survive re-renders; Enter sends, Shift+Enter adds a newline.
 */
export class ConversationDrawer {
  readonly el: HTMLElement;
  private peerId: string | null = null;
  private highlight: string | null = null;
  private head = h('header', { class: 'dm-head' });
  private banner = h('div', { class: 'dm-banner', role: 'status' });
  private list = h('ol', { class: 'chat-list dm-list', 'aria-live': 'polite', 'aria-label': 'Messages' });
  private input = h('textarea', { class: 'chat-input', rows: 1, maxlength: MAX_DM_LENGTH, placeholder: 'Message…', 'aria-label': 'Message', enterkeyhint: 'send' });
  private sendBtn = h('button', { class: 'btn primary chat-send', type: 'submit', 'aria-label': 'Send message', html: icons.send });
  private lastSig = '';
  private menu = h('div', { class: 'more-menu dm-menu', role: 'menu', hidden: true });

  constructor(
    private readonly app: AppContext,
    private readonly onCall: (peerId: string, media: 'audio' | 'video') => void,
  ) {
    document.addEventListener('click', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target as Node)) this.setMenu(false);
    });
    const form = h('form', { class: 'chat-composer' }, this.input, this.sendBtn);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('input', () => {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(this.input.scrollHeight, 132)}px`;
      this.sendBtn.disabled = !this.input.value.trim();
    });
    this.el = h('aside', { class: 'dm-drawer', hidden: true, 'aria-label': 'Conversation' }, this.head, this.banner, this.list, h('div', { class: 'chat-compose-wrap' }, form));
    app.dms.events.on('change', () => this.render());
    app.presence.events.on('change', () => this.render());
  }

  get openPeer(): string | null {
    return this.peerId;
  }

  open(peerId: string, highlightMessageId?: string): void {
    this.peerId = peerId;
    this.highlight = highlightMessageId ?? null;
    this.lastSig = '';
    this.el.hidden = false;
    this.app.dms.setActive(peerId);
    void this.app.notifications.close(`dm-${peerId}`); // clear its notification
    this.render();
    if (!matchMedia('(pointer: coarse)').matches) this.input.focus();
  }

  private setMenu(open: boolean): void {
    this.menu.hidden = !open;
    document.body.classList.toggle('menu-open', open);
  }

  close(): void {
    this.setMenu(false);
    this.peerId = null;
    this.el.hidden = true;
    this.app.dms.setActive(null);
  }

  private submit(): void {
    if (!this.peerId) return;
    const r = this.app.dms.send(this.peerId, this.input.value);
    if (r === 'ok') {
      this.input.value = '';
      this.input.style.height = 'auto';
      this.sendBtn.disabled = true;
    }
  }

  private render(): void {
    if (!this.peerId || this.el.hidden) return;
    const peerId = this.peerId;
    const conv = this.app.dms.conversation(peerId);
    const user = this.app.presence.get(peerId);
    const name = user?.name ?? conv.peerName;
    const status = user?.status ?? 'unknown';
    const menuBtn = h('button', {
      class: 'icon-btn',
      type: 'button',
      'aria-label': 'More',
      'aria-haspopup': 'menu',
      html: icons.more,
      onclick: (e: Event) => {
        e.stopPropagation();
        this.setMenu(this.menu.hidden);
      },
    });
    this.menu.replaceChildren(
      h(
        'button',
        {
          class: 'menu-item danger',
          role: 'menuitem',
          type: 'button',
          onclick: () => {
            this.setMenu(false);
            if (!confirm(`Remove ${name} from your contacts? Your conversation with ${name} is deleted.`)) return;
            this.app.dms.deleteConversation(peerId);
            this.app.presence.removeContact(peerId);
            this.close();
          },
        },
        h('span', { html: icons.trash }),
        'Remove contact',
      ),
    );
    this.head.replaceChildren(
      h('button', { class: 'icon-btn dm-back', 'aria-label': 'Back', title: 'Back', html: icons.back, onclick: () => this.close() }),
      h('span', { class: 'avatar sm', style: `--avatar:${colorFor(peerId)}` }, initials(name)),
      h('div', { class: 'grow dm-title' }, h('strong', {}, name), h('small', { class: `presence ${status}` }, `${status === 'online' ? '●' : '○'} ${status[0]!.toUpperCase()}${status.slice(1)}`)),
      h('button', { class: 'icon-btn', 'aria-label': `Audio call ${name}`, title: 'Audio call', html: icons.phone, onclick: () => this.onCall(peerId, 'audio') }),
      h('button', { class: 'icon-btn', 'aria-label': `Video call ${name}`, title: 'Video call', html: icons.cam, onclick: () => this.onCall(peerId, 'video') }),
      h('div', { class: 'top-menu-wrap' }, menuBtn, this.menu),
    );
    const offline = status !== 'online';
    this.banner.hidden = !offline;
    this.banner.textContent = offline ? `${name} is offline – messages are delivered when they're back.` : '';
    const sig = conv.messages.map((m) => `${m.messageId}:${m.status ?? ''}`).join(',') + this.highlight;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.list.replaceChildren(...conv.messages.map((m) => this.item(m)));
      const target = this.highlight ? this.list.querySelector(`[data-id="${CSS.escape(this.highlight)}"]`) : null;
      if (target) target.scrollIntoView({ block: 'center' });
      else this.list.scrollTop = this.list.scrollHeight;
    }
    this.sendBtn.disabled = !this.input.value.trim();
  }

  private item(m: DirectMessage): HTMLLIElement {
    const body = h('div', { class: 'msg-text' });
    body.textContent = m.text; // never innerHTML
    const retry = m.own && (m.status === 'queued' || m.status === 'failed') && this.app.presence.status(m.peerId) === 'online';
    return h(
      'li',
      { class: `msg ${m.own ? 'own' : 'remote'}${m.messageId === this.highlight ? ' highlight' : ''}`, 'data-id': m.messageId },
      h('div', { class: 'msg-meta' }, h('span', { class: 'msg-name' }, m.own ? 'You' : m.senderName), h('time', {}, time(m.timestamp))),
      body,
      ...nodes(
        m.own && m.status
          ? h(
              'div',
              { class: `msg-delivery ${m.status}`, title: m.statusDetail ?? '' },
              STATUS_TEXT[m.status],
              retry ? h('button', { class: 'link-btn', type: 'button', onclick: () => this.app.dms.retry(m.messageId) }, ' · Retry') : null,
            )
          : null,
      ),
    );
  }
}
