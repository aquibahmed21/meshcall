import { h } from '../dom';

/** First launch: ask for a display name (the device ID is generated silently). */
export function renderOnboarding(root: HTMLElement, onDone: (name: string) => void): void {
  const input = h('input', { type: 'text', id: 'name', maxlength: 40, autocomplete: 'nickname', required: true, placeholder: 'e.g. Aquib' });
  const form = h(
    'form',
    { class: 'onboarding card' },
    h('div', { class: 'brand-mark big' }, '◉'),
    h('h1', {}, 'Welcome'),
    h('label', { for: 'name' }, 'Enter your name:'),
    input,
    h('button', { class: 'btn primary', type: 'submit' }, 'Continue'),
    h('p', { class: 'hint' }, 'Your identity is tied to this browser/device. Calls are peer-to-peer (WebRTC mesh).'),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (name) onDone(name);
  });
  root.replaceChildren(h('div', { class: 'onboarding-wrap' }, form));
  input.focus();
}
