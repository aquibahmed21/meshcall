import { MAX_CHAT_LENGTH, type ChatEntry, type ChatService, type ChatStatus } from '../../services/ChatService';
import { colorFor, h } from '../dom';
import { icons } from '../icons';

const STATUS_TEXT: Record<ChatStatus, string> = {
  connected: '',
  sending: '',
  error: 'Some messages were not delivered',
  connecting: 'Connecting…',
  disconnected: 'Messaging unavailable',
};

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Chat UI. The composer is created once and never re-rendered (focus and draft survive every
 * call-state update). The list re-renders on chat changes only and sticks to the bottom
 * unless the user scrolled up to read history.
 */
export class ChatPanel {
  readonly el: HTMLElement;
  private list = h('ol', { class: 'chat-list', 'aria-live': 'polite', 'aria-label': 'Chat messages' });
  private empty = h('p', { class: 'chat-empty' }, 'No messages yet. Messages are only visible to people in this call and are not stored.');
  private input = h('textarea', {
    class: 'chat-input',
    rows: 1,
    placeholder: 'Message…',
    'aria-label': 'Message',
    maxlength: MAX_CHAT_LENGTH,
    enterkeyhint: 'send',
  });
  private sendBtn = h('button', { class: 'btn primary chat-send', type: 'submit', 'aria-label': 'Send message', title: 'Send', html: icons.send });
  private statusLine = h('div', { class: 'chat-status', role: 'status' });
  private counter = h('span', { class: 'chat-counter' });
  private lastIds = '';

  constructor(private readonly chat: ChatService) {
    const form = h('form', { class: 'chat-composer' }, this.input, this.sendBtn);
    // Tapping Send must not move focus off the text box (that would close the mobile keyboard).
    this.sendBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.sendBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (!this.sendBtn.disabled) this.submit();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener('keydown', (e) => {
      // Enter = send, Shift+Enter = newline; never send while an IME composition is active.
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener('input', () => {
      this.autosize();
      this.renderComposer();
    });
    // Mobile: once the on-screen keyboard has resized the viewport, keep the input visible.
    this.input.addEventListener('focus', () => setTimeout(() => this.input.scrollIntoView({ block: 'nearest' }), 300));
    this.el = h('div', { class: 'chat-panel' }, this.list, this.empty, this.statusLine, h('div', { class: 'chat-compose-wrap' }, form, this.counter));
    this.render();
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  render(): void {
    const msgs = this.chat.messages;
    const ids = msgs.map((m) => `${m.messageId}:${m.delivery}`).join(',');
    if (ids !== this.lastIds) {
      const atBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
      const grewByOwn = msgs.length > 0 && msgs[msgs.length - 1]!.own;
      this.lastIds = ids;
      this.list.replaceChildren(...msgs.map((m) => this.item(m)));
      if (atBottom || grewByOwn) this.list.scrollTop = this.list.scrollHeight;
    }
    this.empty.hidden = msgs.length > 0;
    this.renderComposer();
  }

  private renderComposer(): void {
    const status = this.chat.status;
    this.statusLine.textContent = STATUS_TEXT[status];
    this.statusLine.dataset.status = status;
    this.statusLine.hidden = !STATUS_TEXT[status];
    const can = this.chat.canSend;
    this.input.disabled = !can;
    this.input.placeholder = can ? 'Message…' : status === 'connecting' ? 'Connecting…' : 'Messaging unavailable';
    this.sendBtn.disabled = !can || this.input.value.trim().length === 0;
    const len = this.input.value.length;
    this.counter.textContent = len > MAX_CHAT_LENGTH * 0.8 ? `${len}/${MAX_CHAT_LENGTH}` : '';
  }

  private submit(): void {
    const result = this.chat.send(this.input.value);
    if (result === 'sent') {
      this.input.value = '';
      this.autosize();
    } else if (result === 'too-long') {
      this.statusLine.hidden = false;
      this.statusLine.textContent = `Messages are limited to ${MAX_CHAT_LENGTH} characters`;
      return;
    }
    this.renderComposer();
    this.input.focus({ preventScroll: true }); // keep typing (and the keyboard open)
  }

  private autosize(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 132)}px`;
  }

  private item(m: ChatEntry): HTMLLIElement {
    const meta = h(
      'div',
      { class: 'msg-meta' },
      h('span', { class: 'msg-name', style: m.own ? '' : `color:${colorFor(m.senderId)}` }, m.own ? 'You' : m.senderName),
      h('time', { datetime: new Date(m.timestamp).toISOString() }, time(m.timestamp)),
    );
    const body = h('div', { class: 'msg-text' }); // textContent → no HTML injection
    body.textContent = m.text;
    const delivery =
      m.own && m.delivery === 'sending'
        ? h('div', { class: 'msg-delivery' }, 'Sending…')
        : m.own && m.delivery === 'failed'
          ? h(
              'div',
              { class: 'msg-delivery failed' },
              'Not delivered · ',
              h('button', { class: 'link-btn', type: 'button', onclick: () => this.chat.retry(m.messageId) }, 'Retry'),
            )
          : null;
    return h('li', { class: `msg ${m.own ? 'own' : 'remote'}`, 'data-id': m.messageId }, meta, body, delivery);
  }
}
