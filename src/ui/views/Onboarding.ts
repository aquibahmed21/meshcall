import { logo, icons } from '../icons';
import { h } from '../dom';

export interface AuthResult {
  token: string;
  name: string;
  phone: string;
  role: string;
}

export function renderOnboarding(
  root: HTMLElement,
  serverUrl: string,
  onDone: (result: AuthResult) => void,
): void {
  let mode: 'login' | 'register' = 'login';

  function render() {
    const isRegister = mode === 'register';

    // ── inputs ────────────────────────────────────────────────────
    const phoneInput = h('input', {
      type: 'tel',
      id: 'ob-phone',
      placeholder: '+91 98765 43210',
      autocomplete: 'tel',
      required: true,
    }) as HTMLInputElement;

    const nameInput = h('input', {
      type: 'text',
      id: 'ob-name',
      maxlength: 40,
      autocomplete: 'nickname',
      placeholder: 'Your display name',
      required: true,
    }) as HTMLInputElement;

    const passwordInput = h('input', {
      type: 'password',
      id: 'ob-password',
      placeholder: isRegister ? 'At least 6 characters' : 'Password',
      autocomplete: isRegister ? 'new-password' : 'current-password',
      required: true,
    }) as HTMLInputElement;

    // Eye toggle button
    let showPw = false;
    const eyeBtn = h('button', {
      type: 'button',
      class: 'ob-eye',
      'aria-label': 'Toggle password visibility',
      html: icons.eyeOff,
      onclick: () => {
        showPw = !showPw;
        passwordInput.type = showPw ? 'text' : 'password';
        eyeBtn.innerHTML = showPw ? icons.eye : icons.eyeOff;
      },
    });
    const passwordWrap = h('div', { class: 'ob-pw-wrap' }, passwordInput, eyeBtn);

    // ── field groups ──────────────────────────────────────────────
    const phoneGroup = h('div', { class: 'ob-field' },
      h('label', { for: 'ob-phone', class: 'ob-label' }, 'Mobile number'),
      h('div', { class: 'ob-input-wrap' }, phoneInput),
    );
    const nameGroup = h('div', { class: 'ob-field' },
      h('label', { for: 'ob-name', class: 'ob-label' }, 'Display name'),
      h('div', { class: 'ob-input-wrap' }, nameInput),
    );
    const passwordGroup = h('div', { class: 'ob-field' },
      h('label', { for: 'ob-password', class: 'ob-label' }, 'Password'),
      passwordWrap,
    );

    // ── error ─────────────────────────────────────────────────────
    const errorEl = h('div', { class: 'ob-error', hidden: true });

    // ── submit ────────────────────────────────────────────────────
    const submitBtn = h('button', { class: 'ob-submit', type: 'submit' },
      isRegister ? 'Create account' : 'Sign in',
    );

    // ── mode switch ───────────────────────────────────────────────
    const switchBtn = h('button', { type: 'button', class: 'ob-switch' },
      isRegister ? 'Already have an account? ' : "Don't have an account? ",
      h('span', {}, isRegister ? 'Sign in' : 'Register'),
    );
    switchBtn.addEventListener('click', () => {
      mode = isRegister ? 'login' : 'register';
      render();
    });

    // ── form ──────────────────────────────────────────────────────
    const form = h('form', { class: 'ob-card' },
      h('div', { class: 'ob-brand' },
        h('div', { class: 'ob-logo', html: logo }),
        h('h1', { class: 'ob-title' }, 'MeshCall'),
        h('p', { class: 'ob-subtitle' }, isRegister ? 'Create your account' : 'Welcome back'),
      ),
      h('div', { class: 'ob-fields' },
        phoneGroup,
        ...(isRegister ? [nameGroup] : []),
        passwordGroup,
      ),
      errorEl,
      submitBtn,
      h('div', { class: 'ob-divider' }),
      switchBtn,
    );

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.hidden = true;
      submitBtn.setAttribute('disabled', '');
      submitBtn.textContent = isRegister ? 'Creating account…' : 'Signing in…';

      const phone = phoneInput.value.trim();
      const password = passwordInput.value;
      const name = isRegister ? nameInput.value.trim() : '';

      try {
        const endpoint = isRegister ? '/api/register' : '/api/login';
        const body: Record<string, string> = { phone, password };
        if (isRegister) body.name = name;

        const res = await fetch(`${serverUrl}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
        onDone({ token: data.token, name: data.name, phone: data.phone, role: data.role ?? 'user' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Network error – check the server URL';
        errorEl.textContent = msg;
        errorEl.hidden = false;
        submitBtn.removeAttribute('disabled');
        submitBtn.textContent = isRegister ? 'Create account' : 'Sign in';
      }
    });

    root.replaceChildren(h('div', { class: 'ob-wrap' }, form));
    phoneInput.focus();
  }

  render();
}
