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

  constructor(
    private readonly app: AppContext,
    private readonly onCall: (peerId: string) => void,
  ) {
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

  close(): void {
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
    this.head.replaceChildren(
      h('span', { class: 'avatar sm', style: `--avatar:${colorFor(peerId)}` }, initials(name)),
      h('div', { class: 'grow' }, h('strong', {}, name), h('small', { class: `presence ${status}` }, `${status === 'online' ? '●' : '○'} ${status[0]!.toUpperCase()}${status.slice(1)}`)),
      h('button', { class: 'icon-btn', 'aria-label': `Call ${name}`, title: 'Audio call', html: icons.phone, onclick: () => this.onCall(peerId) }),
      h('button', { class: 'icon-btn', 'aria-label': 'Close conversation', html: icons.close, onclick: () => this.close() }),
    );
    const offline = status !== 'online';
    this.banner.hidden = !offline;
    this.banner.textContent = offline
      ? this.app.push.canSendToUsers && user?.pushEnabled
        ? `${name} is offline. Messages are sent as push notifications.`
        : `${name} is offline. Push delivery is unavailable (the push server cannot notify one specific person), so messages wait on this device and are delivered when ${name} comes online.`
      : '';
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
