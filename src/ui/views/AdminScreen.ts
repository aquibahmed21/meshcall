import { h } from '../dom';
import { icons } from '../icons';
import type { AppContext } from '../../app';

interface AdminUser {
  phone: string;
  name: string;
  role: 'user' | 'admin' | 'root';
  blocked: boolean;
  online: boolean;
  createdAt: number;
}

export class AdminScreen {
  readonly el: HTMLElement;
  private listEl: HTMLElement;
  private statusEl: HTMLElement;
  private users: AdminUser[] = [];

  constructor(private readonly app: AppContext, onBack: () => void) {
    this.statusEl = h('p', { class: 'contacts-status' }, '');
    this.listEl = h('div', { class: 'contacts-list' });

    const header = h('div', { class: 'contacts-header' },
      h('button', { class: 'icon-btn', type: 'button', html: icons.back, onclick: () => onBack() }),
      h('span', { class: 'contacts-me-name' }, 'Admin — Users'),
      h('button', { class: 'icon-btn', type: 'button', title: 'Refresh', html: icons.refresh, onclick: () => void this.load() }),
    );

    this.el = h('div', { class: 'contacts-screen' },
      header,
      this.statusEl,
      this.listEl,
    );
  }

  async init(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    this.setStatus('Loading…');
    try {
      const res = await fetch(`${this.app.config.serverUrl}/api/admin/users`, {
        headers: { Authorization: `Bearer ${this.app.identity.token}` },
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: string };
        this.setStatus(e.error ?? `Error ${res.status}`);
        return;
      }
      this.users = await res.json() as AdminUser[];
      this.setStatus('');
      this.render();
    } catch {
      this.setStatus('Network error');
    }
  }

  private render(): void {
    if (!this.users.length) {
      this.listEl.replaceChildren(h('p', { class: 'contacts-empty' }, 'No users yet'));
      return;
    }
    this.listEl.replaceChildren(...this.users.map(u => this.renderUser(u)));
  }

  private renderUser(u: AdminUser): HTMLElement {
    const onlineEl = h('span', { class: `contact-status ${u.online ? 'online' : 'offline'}` });
    const nameEl = h('span', { class: 'contact-name' }, u.name + (u.role !== 'user' ? ` [${u.role}]` : '') + (u.blocked ? ' 🚫' : ''));
    const phoneEl = h('span', { class: 'contact-phone' }, u.phone);

    const blockBtn = h('button', {
      class: 'btn btn-sm',
      type: 'button',
      title: u.blocked ? 'Unblock' : 'Block',
      html: u.blocked ? icons.check : icons.lock,
      onclick: (e: Event) => { e.stopPropagation(); void this.setBlocked(u, !u.blocked); },
    });

    const resetBtn = h('button', {
      class: 'btn btn-sm',
      type: 'button',
      title: 'Reset password',
      html: icons.settings,
      onclick: (e: Event) => { e.stopPropagation(); void this.resetPassword(u); },
    });

    const deleteBtn = h('button', {
      class: 'btn btn-sm btn-danger',
      type: 'button',
      title: 'Delete user',
      html: icons.trash,
      onclick: (e: Event) => { e.stopPropagation(); void this.deleteUser(u); },
    });

    return h('div', { class: `contact-row ${u.online ? 'is-online' : ''} ${u.blocked ? 'is-blocked' : ''}` },
      h('div', { class: 'contact-info' }, onlineEl, h('div', { class: 'contact-text' }, nameEl, phoneEl)),
      h('div', { class: 'contact-actions' }, blockBtn, resetBtn, deleteBtn),
    );
  }

  private async setBlocked(u: AdminUser, blocked: boolean): Promise<void> {
    await this.patch(u.phone, { blocked });
  }

  private async resetPassword(u: AdminUser): Promise<void> {
    const password = prompt(`New password for ${u.name} (${u.phone}):`);
    if (!password || password.length < 6) { alert('Password must be at least 6 characters'); return; }
    await this.patch(u.phone, { password });
  }

  private async deleteUser(u: AdminUser): Promise<void> {
    if (!confirm(`Delete ${u.name} (${u.phone})? This cannot be undone.`)) return;
    try {
      const res = await fetch(`${this.app.config.serverUrl}/api/admin/users/${encodeURIComponent(u.phone)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${this.app.identity.token}` },
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: string };
        this.setStatus(e.error ?? 'Delete failed');
        return;
      }
      this.setStatus(`${u.name} deleted`);
      setTimeout(() => this.setStatus(''), 3000);
      await this.load();
    } catch {
      this.setStatus('Network error');
    }
  }

  private async patch(phone: string, body: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(`${this.app.config.serverUrl}/api/admin/users/${encodeURIComponent(phone)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${this.app.identity.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: string };
        this.setStatus(e.error ?? 'Request failed');
        return;
      }
      this.setStatus('Done');
      setTimeout(() => this.setStatus(''), 2000);
      await this.load();
    } catch {
      this.setStatus('Network error');
    }
  }

  private setStatus(msg: string): void {
    this.statusEl.textContent = msg;
    this.statusEl.hidden = !msg;
  }
}
