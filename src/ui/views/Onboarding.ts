import { logo } from '../icons';
import { h } from '../dom';

export interface AuthResult {
  token: string;
  name: string;
  phone: string;
  role: string;
}

/**
 * First-launch / sign-in screen.
 * Users register with a phone number, password and display name, or sign in
 * with their phone + password. On success, `onDone` is called with the
 * server-issued JWT and account details.
 */
export function renderOnboarding(
  root: HTMLElement,
  serverUrl: string,
  onDone: (result: AuthResult) => void,
): void {
  let mode: 'login' | 'register' = 'login';

  function render() {
    const isRegister = mode === 'register';

    const phoneInput = h('input', {
      type: 'tel',
      id: 'ob-phone',
      placeholder: '+91 98765 43210',
      autocomplete: 'tel',
      required: true,
    });
    const passwordInput = h('input', {
      type: 'password',
      id: 'ob-password',
      placeholder: isRegister ? 'At least 6 characters' : 'Password',
      autocomplete: isRegister ? 'new-password' : 'current-password',
      required: true,
    });
    const nameInput = h('input', {
      type: 'text',
      id: 'ob-name',
      maxlength: 40,
      autocomplete: 'nickname',
      placeholder: 'e.g. Aquib',
      required: true,
    });

    const errorEl = h('p', { class: 'ob-error', style: 'display:none;color:var(--color-danger,#e74c3c);font-size:.875rem;margin:.25rem 0 0' });

    const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, isRegister ? 'Create account' : 'Sign in');

    const switchLink = h(
      'p',
      { class: 'hint' },
      isRegister ? 'Already have an account? ' : "Don't have an account? ",
    );
    const switchAnchor = h('a', { href: '#', style: 'cursor:pointer' }, isRegister ? 'Sign in' : 'Register');
    switchLink.appendChild(switchAnchor);

    const fields: HTMLElement[] = [
      h('label', { for: 'ob-phone' }, 'Mobile number'),
      phoneInput,
      ...(isRegister ? [h('label', { for: 'ob-name' }, 'Display name'), nameInput] : []),
      h('label', { for: 'ob-password' }, 'Password'),
      passwordInput,
    ];

    const form = h(
      'form',
      { class: 'onboarding card' },
      h('div', { class: 'brand-mark big', html: logo }),
      h('h1', {}, isRegister ? 'Create account' : 'Welcome back'),
      ...fields,
      errorEl,
      submitBtn,
      switchLink,
      h('p', { class: 'hint' }, 'Calls are peer-to-peer (WebRTC). Your account lives on this server.'),
    );

    switchAnchor.addEventListener('click', (e) => {
      e.preventDefault();
      mode = isRegister ? 'login' : 'register';
      render();
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorEl.style.display = 'none';
      submitBtn.setAttribute('disabled', '');
      submitBtn.textContent = isRegister ? 'Creating…' : 'Signing in…';

      const phone = (phoneInput as HTMLInputElement).value.trim();
      const password = (passwordInput as HTMLInputElement).value;
      const name = isRegister ? (nameInput as HTMLInputElement).value.trim() : '';

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
        if (!res.ok) {
          throw new Error(data.error || `Server error ${res.status}`);
        }
        onDone({ token: data.token, name: data.name, phone: data.phone, role: data.role ?? 'user' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Network error – check the server URL';
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
        submitBtn.removeAttribute('disabled');
        submitBtn.textContent = isRegister ? 'Create account' : 'Sign in';
      }
    });

    root.replaceChildren(h('div', { class: 'onboarding-wrap' }, form));
    (phoneInput as HTMLInputElement).focus();
  }

  render();
}
