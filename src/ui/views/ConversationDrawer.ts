import { confirmDialog } from './ConfirmDialog';
import type { AppContext } from '../../app';
import { formatBytes } from '../../core/format';
import { isNative, native } from '../../native/native';
import { AUTO_DOWNLOAD_BYTES } from '../../services/FileTransferService';
import { MAX_DM_LENGTH, REACTIONS, type DirectMessage, type DmStatus } from '../../services/DirectMessageService';
import type { DmReply } from '../../types/signaling';
import { backStack } from '../BackStack';
import { colorFor, h, initials, nodes } from '../dom';
import { icons } from '../icons';

/** Ticks next to the time: ✓ sent · ✓✓ delivered · blue ✓✓ read. */
const TICK: Record<DmStatus, { icon: string; label: string }> = {
  sending: { icon: '…', label: 'Sending' },
  sent: { icon: '✓', label: 'Sent' },
  delivered: { icon: '✓✓', label: 'Delivered' },
  read: { icon: '✓✓', label: 'Read' },
  queued: { icon: '⏳', label: 'Waiting for recipient' },
  'push-accepted': { icon: '⏳', label: 'Notification sent' },
  failed: { icon: '!', label: 'Failed' },
};

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const preview = (m: DirectMessage): string => (m.deleted ? 'Deleted message' : !m.text && m.file ? `📎 ${m.file.name}` : m.text.replace(/\s+/g, ' ').slice(0, 100));

/**
 * 1:1 conversation (room-scoped, works in and outside calls). Composer is persistent so focus
 * and drafts survive re-renders; Enter sends, Shift+Enter adds a newline.
 *
 * Long-press (or right-click) a message → reactions + Reply / Copy / Edit / Delete.
 * Swipe a message right → reply. Menu → Search, Mute.
 */
export class ConversationDrawer {
  readonly el: HTMLElement;
  private peerId: string | null = null;
  private highlight: string | null = null;
  private head = h('header', { class: 'dm-head' });
  private banner = h('div', { class: 'dm-banner', role: 'status' });
  private searchInput = h('input', { type: 'search', class: 'dm-search-input', placeholder: 'Search', 'aria-label': 'Search messages', enterkeyhint: 'search' });
  private searchBar = h('div', { class: 'dm-searchbar', hidden: true }, this.searchInput, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close search', html: icons.close, onclick: () => this.setSearch(false) }));
  private list = h('ol', { class: 'chat-list dm-list', 'aria-live': 'polite', 'aria-label': 'Messages' });
  private jump = h('button', { class: 'dm-jump', type: 'button', hidden: true, 'aria-label': 'Jump to newest', html: icons.arrowDown, onclick: () => this.scrollBottom() });
  private jumpBadge = h('span', { class: 'badge' });
  private input = h('textarea', { class: 'chat-input', rows: 1, maxlength: MAX_DM_LENGTH, placeholder: 'Message…', 'aria-label': 'Message', enterkeyhint: 'send' });
  private sendBtn = h('button', { class: 'btn primary chat-send', type: 'submit', 'aria-label': 'Send message', html: icons.send });
  private ctxBar = h('div', { class: 'dm-ctxbar', hidden: true });
  private fileInput = h('input', { type: 'file', multiple: true, hidden: true, 'aria-hidden': 'true', tabindex: -1 }) as HTMLInputElement;
  private attachBtn = h('button', { class: 'icon-btn chat-attach', type: 'button', 'aria-label': 'Attach file', html: icons.clip });
  private form: HTMLFormElement;
  private sheet = h('div', { class: 'dm-sheet', hidden: true, role: 'menu' });
  private lastSig = '';
  /** Scroll to the newest message on the next list render. */
  private stickToBottom = true;
  private newBelow = 0;
  private knownIds = new Set<string>();
  private menu = h('div', { class: 'more-menu dm-menu', role: 'menu', hidden: true });
  private releaseBack: (() => void) | null = null;
  private releaseMenuBack: (() => void) | null = null;
  private releaseSheetBack: (() => void) | null = null;
  private replyTo: DmReply | null = null;
  private editing: DirectMessage | null = null;
  private query = '';

  constructor(
    private readonly app: AppContext,
    private readonly onCall: (peerId: string, media: 'audio' | 'video') => void,
  ) {
    document.addEventListener('click', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target as Node)) this.setMenu(false);
    });
    this.form = h('form', { class: 'chat-composer' }, this.attachBtn, this.fileInput, this.input, this.sendBtn);
    this.attachBtn.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', () => {
      const files = [...(this.fileInput.files ?? [])];
      this.fileInput.value = '';
      void this.sendFiles(files);
    });
    // Tapping Send must not move focus off the text box (that would close the mobile keyboard).
    this.sendBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.sendBtn.addEventListener('touchend', (e) => {
      e.preventDefault(); // no focus change / no synthetic click …
      if (!this.sendBtn.disabled) this.submit(); // … so send right here
    });
    this.form.addEventListener('submit', (e) => {
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
      this.syncComposer();
      if (this.peerId && this.input.value.trim()) this.app.dms.notifyTyping(this.peerId, true);
    });
    this.input.addEventListener('blur', () => this.peerId && this.app.dms.notifyTyping(this.peerId, false));
    this.searchInput.addEventListener('input', () => {
      this.query = this.searchInput.value.trim().toLowerCase();
      this.lastSig = '';
      this.render();
    });
    this.list.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.jump.append(this.jumpBadge);
    this.el = h(
      'aside',
      { class: 'dm-drawer', hidden: true, 'aria-label': 'Conversation' },
      this.head,
      this.searchBar,
      this.banner,
      h('div', { class: 'dm-list-wrap' }, this.list, this.jump),
      h('div', { class: 'chat-compose-wrap' }, this.ctxBar, this.form),
      this.sheet,
    );
    app.dms.events.on('change', () => this.render());
    app.files.events.on('change', () => this.render());
    app.dms.events.on('typing', (p) => p === this.peerId && this.render());
    app.presence.events.on('change', () => this.render());
    document.addEventListener('visibilitychange', () => this.markRead());
    native.events.on('resume', () => this.markRead());
  }

  get openPeer(): string | null {
    return this.peerId;
  }

  open(peerId: string, highlightMessageId?: string): void {
    this.peerId = peerId;
    this.highlight = highlightMessageId ?? null;
    this.lastSig = '';
    this.stickToBottom = true; // opening a conversation starts at the newest message
    this.newBelow = 0;
    this.knownIds = new Set(this.app.dms.conversation(peerId).messages.map((m) => m.messageId));
    this.replyTo = null;
    this.editing = null;
    this.query = '';
    this.searchInput.value = '';
    this.searchBar.hidden = true;
    this.el.hidden = false;
    this.releaseBack ??= backStack.push(() => this.close(true)); // Back → back to the contact list
    this.app.dms.setActive(peerId);
    void this.app.notifications.close(`dm-${peerId}`); // clear its notification
    this.render();
    this.markRead();
    if (!matchMedia('(pointer: coarse)').matches) this.input.focus();
  }

  private visible(): boolean {
    return !this.el.hidden && (isNative ? native.foreground : document.visibilityState === 'visible');
  }

  private markRead(): void {
    if (this.peerId && this.visible()) this.app.dms.markRead(this.peerId);
  }

  private setMenu(open: boolean, viaBack = false): void {
    if (this.menu.hidden === !open) return;
    this.menu.hidden = !open;
    document.body.classList.toggle('menu-open', open);
    if (open) this.releaseMenuBack = backStack.push(() => this.setMenu(false, true));
    else {
      if (!viaBack) this.releaseMenuBack?.();
      this.releaseMenuBack = null;
    }
  }

  private setSearch(open: boolean): void {
    this.searchBar.hidden = !open;
    if (open) this.searchInput.focus();
    else {
      this.searchInput.value = '';
      this.query = '';
    }
    this.lastSig = '';
    this.render();
  }

  close(viaBack = false): void {
    this.setMenu(false);
    this.closeSheet();
    if (this.peerId) this.app.dms.notifyTyping(this.peerId, false);
    if (!viaBack) this.releaseBack?.();
    this.releaseBack = null;
    this.peerId = null;
    this.el.hidden = true;
    this.app.dms.setActive(null);
  }

  // ── composer ────────────────────────────────────────────────────────────

  private syncComposer(): void {
    const has = !!this.input.value.trim();
    this.sendBtn.disabled = !has;
  }

  private setContext(): void {
    const quote = this.editing ? { name: 'Edit', text: preview(this.editing), icon: icons.edit } : this.replyTo ? { name: this.replyTo.name, text: this.replyTo.text, icon: icons.reply } : null;
    this.ctxBar.hidden = !quote;
    if (!quote) return this.ctxBar.replaceChildren();
    this.ctxBar.replaceChildren(
      h('span', { class: 'dm-ctx-icon', html: quote.icon }),
      h('div', { class: 'grow dm-ctx-text' }, h('strong', {}, quote.name), h('small', {}, quote.text)),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Cancel', html: icons.close, onclick: () => this.clearContext() }),
    );
  }

  private clearContext(): void {
    if (this.editing) {
      this.input.value = '';
      this.input.style.height = 'auto';
    }
    this.editing = null;
    this.replyTo = null;
    this.setContext();
    this.syncComposer();
  }

  private startReply(m: DirectMessage): void {
    if (m.deleted) return;
    this.editing = null;
    this.replyTo = { messageId: m.messageId, name: m.own ? 'You' : m.senderName, text: preview(m) };
    this.setContext();
    this.syncComposer();
    this.input.focus();
  }

  private startEdit(m: DirectMessage): void {
    this.replyTo = null;
    this.editing = m;
    this.input.value = m.text;
    this.input.dispatchEvent(new Event('input'));
    this.setContext();
    this.syncComposer();
    this.input.focus();
  }

  private submit(): void {
    if (!this.peerId) return;
    // My new message must be visible: stop pointing at a highlighted (notification) message.
    this.highlight = null;
    this.stickToBottom = true;
    if (this.editing) {
      const r = this.app.dms.edit(this.editing.messageId, this.input.value);
      if (r === 'offline') return this.toast('Offline');
      this.editing = null;
      this.input.value = '';
      this.input.style.height = 'auto';
      this.setContext();
      this.syncComposer();
      return;
    }
    const r = this.app.dms.send(this.peerId, this.input.value, this.replyTo ?? undefined);
    if (r === 'ok') {
      this.input.value = '';
      this.input.style.height = 'auto';
      this.replyTo = null;
      this.setContext();
      this.app.dms.notifyTyping(this.peerId, false);
    }
    this.syncComposer();
    this.input.focus({ preventScroll: true }); // keep typing (and the keyboard open)
  }

  private async sendFiles(files: File[]): Promise<void> {
    const peer = this.peerId;
    if (!peer) return;
    for (const f of files) {
      const meta = await this.app.files.offer(f);
      if (meta === 'too-big') {
        this.toast('Max 50 MB');
        continue;
      }
      this.stickToBottom = true;
      this.app.dms.sendFile(peer, meta, files.length === 1 ? this.input.value : '');
      if (files.length === 1 && this.input.value) {
        this.input.value = '';
        this.input.style.height = 'auto';
        this.syncComposer();
      }
    }
  }

  /** Attachment bubble: media thumbnails / players, or a typed file card; tap to open, fetch or save. */
  private attachment(m: DirectMessage): HTMLElement {
    const f = m.file!;
    const files = this.app.files;
    const url = files.url(f.id);
    const st = files.state(f.id);
    const kind = f.mime.startsWith('image/') ? 'image' : f.mime.startsWith('video/') ? 'video' : f.mime.startsWith('audio/') ? 'audio' : 'file';
    // Small media is fetched automatically, like a chat app.
    if (!url && !m.own && kind !== 'file' && f.size <= AUTO_DOWNLOAD_BYTES && !st && this.app.presence.status(m.peerId) === 'online') files.download(f, m.peerId);
    const fetchBtn = () =>
      st?.status === 'downloading'
        ? h('span', { class: 'att-progress', style: `--pct:${st.pct}` }, h('span', {}, `${st.pct}%`))
        : m.own
          ? null
          : h('button', { class: 'att-fetch', type: 'button', 'aria-label': 'Download', title: st?.detail || 'Download', html: icons.download, onclick: () => files.download(f, m.peerId) });

    if (kind === 'image') {
      if (url) return h('button', { class: 'att-media', type: 'button', 'aria-label': `Open ${f.name}`, onclick: () => this.openViewer(m, url) }, h('img', { src: url, alt: f.name, loading: 'lazy', decoding: 'async' }));
      return h('div', { class: 'att-media att-pending' }, h('span', { class: 'att-pending-icon', html: icons.file }), h('small', {}, st?.status === 'failed' ? st.detail || 'Failed' : formatBytes(f.size)), ...nodes(fetchBtn()));
    }
    if (kind === 'video') {
      if (url) return h('div', { class: 'att-media att-video' }, h('video', { src: `${url}#t=0.1`, controls: true, playsinline: true, preload: 'metadata' }));
      return h('div', { class: 'att-media att-pending' }, h('span', { class: 'att-pending-icon', html: icons.play }), h('small', {}, formatBytes(f.size)), ...nodes(fetchBtn()));
    }
    if (kind === 'audio') {
      return h('div', { class: 'att-audio' }, url ? h('audio', { src: url, controls: true, preload: 'metadata' }) : h('span', { class: 'grow' }, `${f.name} · ${formatBytes(f.size)}`), ...nodes(url ? null : fetchBtn()));
    }
    // Generic file card with a type badge.
    const ext = (f.name.split('.').pop() ?? '').toLowerCase().slice(0, 4);
    const tone = /^(pdf)$/.test(ext) ? 'pdf' : /^(docx?|rtf|odt|txt)$/.test(ext) ? 'doc' : /^(xlsx?|csv|ods)$/.test(ext) ? 'xls' : /^(pptx?|odp|key)$/.test(ext) ? 'ppt' : /^(zip|rar|7z|tar|gz)$/.test(ext) ? 'zip' : 'oth';
    const open = () => {
      if (!url) return;
      if (ext === 'pdf' && !isNative) window.open(url, '_blank');
      else void this.saveFile(m);
    };
    return h(
      'div',
      { class: `att-file${url ? ' ready' : ''}`, role: url ? 'button' : undefined, tabindex: url ? 0 : undefined, onclick: open },
      h('span', { class: `att-badge ${tone}` }, ext ? ext.toUpperCase() : 'FILE'),
      h('div', { class: 'grow att-info' }, h('span', { class: 'att-name' }, f.name), h('small', {}, st?.status === 'failed' ? st.detail || 'Failed' : `${formatBytes(f.size)}${ext ? ` · ${ext.toUpperCase()}` : ''}`)),
      ...nodes(url ? h('span', { class: 'att-open', html: icons.download, 'aria-hidden': 'true' }) : fetchBtn()),
    );
  }

  /** Full-screen image viewer with Save and close. */
  private openViewer(m: DirectMessage, url: string): void {
    const f = m.file!;
    let release: (() => void) | null = null;
    const close = (viaBack = false) => {
      v.remove();
      document.removeEventListener('keydown', onKey);
      if (!viaBack) release?.(); // closed from the UI: give up the history entry too
      release = null;
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    // Back closes the viewer first (never the conversation or the app underneath).
    const v = h(
      'div',
      { class: 'att-viewer', role: 'dialog', 'aria-label': f.name, onclick: (e: Event) => e.target === v && close() },
      h('div', { class: 'att-viewer-bar' }, h('span', { class: 'grow att-viewer-name' }, f.name), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Save', title: 'Save', html: icons.download, onclick: () => void this.saveFile(m) }), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', title: 'Close', html: icons.close, onclick: () => close() })),
      h('img', { src: url, alt: f.name }),
    );
    document.addEventListener('keydown', onKey);
    document.body.append(v);
    release = backStack.push(() => close(true));
  }

  private async saveFile(m: DirectMessage): Promise<void> {
    const f = m.file!;
    const blob = await this.app.files.blob(f.id);
    if (!blob) return this.toast('Not available');
    if (isNative && (await native.saveFile(f.name, f.mime, blob))) return this.toast('Saved to Downloads');
    const a = h('a', { href: URL.createObjectURL(blob), download: f.name });
    document.body.append(a);
    a.click();
    setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 4000);
  }

  private toast(text: string): void {
    const t = h('div', { class: 'dm-toast', role: 'status' }, text);
    this.el.append(t);
    setTimeout(() => t.remove(), 2200);
  }

  // ── message actions (long-press sheet) ───────────────────────────────────

  private closeSheet(viaBack = false): void {
    if (this.sheet.hidden) return;
    this.sheet.hidden = true;
    if (!viaBack) this.releaseSheetBack?.();
    this.releaseSheetBack = null;
  }

  private openSheet(m: DirectMessage): void {
    if (m.deleted || !this.peerId) return;
    const me = this.app.identity.deviceId;
    const act = (icon: string, label: string, run: () => void, cls = '') =>
      h('button', { class: `menu-item ${cls}`.trim(), type: 'button', role: 'menuitem', onclick: () => (this.closeSheet(), run()) }, h('span', { html: icon }), label);
    this.sheet.replaceChildren(
      h(
        'div',
        { class: 'dm-reactbar' },
        ...REACTIONS.map((e) => h('button', { class: `dm-react${m.reactions?.[me] === e ? ' on' : ''}`, type: 'button', 'aria-label': `React ${e}`, onclick: () => (this.closeSheet(), this.app.dms.react(m.messageId, e)) }, e)),
      ),
      act(icons.reply, 'Reply', () => this.startReply(m)),
      ...nodes(
        act(icons.copy, 'Copy', () => void navigator.clipboard?.writeText(m.text).then(() => this.toast('Copied'), () => undefined)),
        this.app.dms.canEdit(m) ? act(icons.edit, 'Edit', () => this.startEdit(m)) : null,
        act(icons.trash, 'Delete for me', async () => {
          if (await confirmDialog({ title: 'Delete?', confirmLabel: 'Delete', danger: true, icon: icons.trash })) this.app.dms.deleteForMe(m.messageId);
        }, 'danger'),
        m.own
          ? act(icons.trash, 'Delete for all', async () => {
              if (!(await confirmDialog({ title: 'Delete for all?', confirmLabel: 'Delete', danger: true, icon: icons.trash }))) return;
              if (!this.app.dms.deleteForEveryone(m.messageId)) this.toast('Offline');
            }, 'danger')
          : null,
      ),
    );
    this.sheet.hidden = false;
    this.releaseSheetBack ??= backStack.push(() => this.closeSheet(true));
  }

  /** Long-press / right-click opens the sheet; a right swipe replies. */
  private bindGestures(li: HTMLElement, m: DirectMessage): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sx = 0;
    let sy = 0;
    let dx = 0;
    let swiping = false;
    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      li.style.transform = '';
      li.classList.remove('swiping');
      swiping = false;
      dx = 0;
    };
    li.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
      sx = e.clientX;
      sy = e.clientY;
      timer = setTimeout(() => {
        timer = undefined;
        navigator.vibrate?.(15);
        this.openSheet(m);
      }, 480);
    });
    li.addEventListener('pointermove', (e) => {
      if (!timer && !swiping) return;
      const mx = e.clientX - sx;
      const my = e.clientY - sy;
      if (Math.abs(my) > 10 && !swiping) return reset(); // vertical scroll
      if (mx > 12 && Math.abs(my) < 12) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        swiping = true;
        dx = Math.min(mx, 80);
        li.classList.add('swiping');
        li.style.transform = `translateX(${dx}px)`;
      }
    });
    const end = () => {
      if (swiping && dx >= 60) this.startReply(m);
      reset();
    };
    li.addEventListener('pointerup', end);
    li.addEventListener('pointercancel', reset);
    li.addEventListener('pointerleave', () => !swiping && reset());
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openSheet(m);
    });
  }

  // ── rendering ───────────────────────────────────────────────────────────

  private onScroll(): void {
    const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
    if (nearBottom) this.newBelow = 0;
    this.jump.hidden = nearBottom;
    this.jumpBadge.hidden = !this.newBelow;
    this.jumpBadge.textContent = String(this.newBelow);
  }

  private scrollBottom(): void {
    this.newBelow = 0;
    this.list.scrollTo({ top: this.list.scrollHeight, behavior: 'smooth' });
    this.jump.hidden = true;
  }

  private render(): void {
    if (!this.peerId || this.el.hidden) return;
    const peerId = this.peerId;
    const conv = this.app.dms.conversation(peerId);
    const user = this.app.presence.get(peerId);
    const name = user?.name ?? conv.peerName;
    const status = user?.status ?? 'unknown';
    const muted = this.app.dms.isMuted(peerId);
    const typing = this.app.dms.isTyping(peerId);
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
    const item = (icon: string, label: string, run: () => void, cls = '') =>
      h('button', { class: `menu-item ${cls}`.trim(), role: 'menuitem', type: 'button', onclick: () => (this.setMenu(false), run()) }, h('span', { html: icon }), label);
    this.menu.replaceChildren(
      item(icons.search, 'Search', () => this.setSearch(true)),
      item(muted ? icons.bell : icons.bellOff, muted ? 'Unmute' : 'Mute', () => this.app.dms.setMuted(peerId, !muted)),
      item(
        icons.trash,
        'Remove',
        async () => {
          if (!(await confirmDialog({ title: `Remove ${name}?`, message: 'They are removed from your contacts and your conversation is deleted.', confirmLabel: 'Remove', danger: true, icon: icons.trash }))) return;
          this.app.dms.deleteConversation(peerId);
          this.app.presence.removeContact(peerId);
          this.close();
        },
        'danger',
      ),
    );
    this.head.replaceChildren(
      h('button', { class: 'icon-btn dm-back', 'aria-label': 'Back', title: 'Back', html: icons.back, onclick: () => this.close() }),
      h('span', { class: 'avatar sm', style: `--avatar:${colorFor(peerId)}` }, initials(name)),
      h(
        'div',
        { class: 'grow dm-title' },
        h('strong', {}, name, muted ? h('span', { class: 'dm-muted', html: icons.bellOff, title: 'Muted' }) : null),
        h('small', { class: `presence ${typing ? 'online' : status}` }, typing ? 'typing…' : `${status === 'online' ? '●' : '○'} ${status[0]!.toUpperCase()}${status.slice(1)}`),
      ),
      h('button', { class: 'icon-btn', 'aria-label': `Audio call ${name}`, title: 'Audio call', html: icons.phone, onclick: () => this.onCall(peerId, 'audio') }),
      h('button', { class: 'icon-btn', 'aria-label': `Video call ${name}`, title: 'Video call', html: icons.cam, onclick: () => this.onCall(peerId, 'video') }),
      h('div', { class: 'top-menu-wrap' }, menuBtn, this.menu),
    );
    const offline = status !== 'online';
    this.banner.hidden = !offline;
    this.banner.textContent = offline ? `${name} is offline – messages are delivered when they're back.` : '';

    const shown = this.query ? conv.messages.filter((m) => !m.deleted && m.text.toLowerCase().includes(this.query)) : conv.messages;
    const sig = shown.map((m) => `${m.messageId}:${m.status ?? ''}:${m.text.length}:${m.edited ? 1 : 0}:${m.deleted ? 1 : 0}:${Object.values(m.reactions ?? {}).join('')}:${m.file ? `${this.app.files.url(m.file.id) ? 1 : 0}${this.app.files.state(m.file.id)?.pct ?? ''}${this.app.files.state(m.file.id)?.status ?? ''}` : ''}`).join(',') + this.highlight + this.query;
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      // Follow new messages only if the reader was already at the bottom (or just sent one).
      const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
      const follow = this.stickToBottom || nearBottom;
      this.stickToBottom = false;
      for (const m of conv.messages) {
        if (!this.knownIds.has(m.messageId)) {
          this.knownIds.add(m.messageId);
          if (!m.own && !follow) this.newBelow++;
        }
      }
      this.list.replaceChildren(...(shown.length ? shown.map((m) => this.item(m)) : this.query ? [h('li', { class: 'empty' }, 'No match')] : []));
      const target = this.highlight ? this.list.querySelector(`[data-id="${CSS.escape(this.highlight)}"]`) : null;
      // After layout, so the new message's height is known.
      requestAnimationFrame(() => {
        if (target) target.scrollIntoView({ block: 'center' });
        else if (follow) this.list.scrollTop = this.list.scrollHeight;
        this.onScroll();
      });
    }
    this.syncComposer();
    this.markRead();
  }

  private item(m: DirectMessage): HTMLLIElement {
    const me = this.app.identity.deviceId;
    let body: HTMLElement;
    if (m.deleted) {
      body = h('div', { class: 'msg-text msg-deleted' }, 'Deleted message');
    } else {
      body = h('div', { class: 'msg-text' });
      body.textContent = m.text; // never innerHTML
      if (m.file) body = h('div', { class: 'msg-body' }, this.attachment(m), ...nodes(m.text ? body : null));
    }
    const tick = m.own && m.status ? TICK[m.status] : null;
    const retry = m.own && (m.status === 'queued' || m.status === 'failed') && this.app.presence.status(m.peerId) === 'online';
    const reactions = Object.entries(m.reactions ?? {});
    const quote = m.replyTo && !m.deleted
      ? h(
          'button',
          {
            class: 'msg-quote',
            type: 'button',
            onclick: () => {
              const t = this.list.querySelector(`[data-id="${CSS.escape(m.replyTo!.messageId)}"]`);
              if (t) {
                t.scrollIntoView({ block: 'center', behavior: 'smooth' });
                t.classList.add('flash');
                setTimeout(() => t.classList.remove('flash'), 1200);
              }
            },
          },
          h('strong', {}, m.replyTo.name),
          h('span', {}, m.replyTo.text),
        )
      : null;
    const li = h(
      'li',
      { class: `msg ${m.own ? 'own' : 'remote'}${m.messageId === this.highlight ? ' highlight' : ''}${m.deleted ? ' deleted' : ''}`, 'data-id': m.messageId },
      ...nodes(
        m.own ? null : h('div', { class: 'msg-meta' }, h('span', { class: 'msg-name' }, m.senderName)),
        quote,
        body,
        h(
          'div',
          { class: 'msg-foot' },
          ...nodes(
            m.edited && !m.deleted ? h('span', { class: 'msg-edited' }, 'edited') : null,
            h('time', {}, time(m.timestamp)),
            tick ? h('span', { class: `msg-tick ${m.status}`, title: m.statusDetail || tick.label, 'aria-label': tick.label }, tick.icon) : null,
            retry ? h('button', { class: 'link-btn', type: 'button', onclick: () => this.app.dms.retry(m.messageId) }, 'Retry') : null,
          ),
        ),
        reactions.length
          ? h(
              'div',
              { class: 'msg-reactions' },
              ...Object.entries(
                reactions.reduce<Record<string, number>>((acc, [, e]) => ((acc[e] = (acc[e] ?? 0) + 1), acc), {}),
              ).map(([e, n]) => h('span', { class: `msg-react${reactions.some(([u, x]) => u === me && x === e) ? ' mine' : ''}`, onclick: () => this.app.dms.react(m.messageId, e) }, n > 1 ? `${e} ${n}` : e)),
            )
          : null,
      ),
    );
    this.bindGestures(li, m);
    return li;
  }
}
