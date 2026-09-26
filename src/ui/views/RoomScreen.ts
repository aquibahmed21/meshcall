import { MAX_ROOM_NAME_LENGTH, validateRoomName, type RoomContext } from '../../services/RoomService';
import { h } from '../dom';

export interface RoomScreenOptions {
  userName: string;
  prefill?: string;
  error?: string;
  recent: string[];
  onJoin: (room: RoomContext) => Promise<void>;
}

/**
 * Shown on EVERY fresh page load (and after leaving a room). Never auto-joins: recent rooms
 * are offered as shortcuts that only fill the field.
 */
export function renderRoomScreen(root: HTMLElement, opts: RoomScreenOptions): void {
  const input = h('input', {
    type: 'text',
    id: 'room-name',
    name: 'room',
    maxlength: MAX_ROOM_NAME_LENGTH,
    autocomplete: 'off',
    autocapitalize: 'words',
    enterkeyhint: 'go',
    placeholder: 'Enter room name…',
    'aria-describedby': 'room-error',
    value: opts.prefill ?? '',
  });
  const error = h('p', { class: 'field-error', id: 'room-error', role: 'alert' }, opts.error ?? '');
  const join = h('button', { class: 'btn primary', type: 'submit', disabled: true }, 'Join Room');
  let touched = !!opts.prefill;
  let busy = false;

  const validate = () => {
    const v = validateRoomName(input.value);
    join.disabled = busy || !v.ok;
    if (touched && !v.ok && input.value.trim()) error.textContent = v.error;
    else if (!busy && error.textContent && v.ok && !opts.error) error.textContent = '';
    input.setAttribute('aria-invalid', String(touched && !v.ok && !!input.value.trim()));
    return v;
  };
  input.addEventListener('input', () => {
    touched = true;
    opts.error = undefined;
    validate();
  });

  const recent = opts.recent.length
    ? h(
        'div',
        { class: 'recent-rooms' },
        h('span', { class: 'hint' }, 'Recent:'),
        ...opts.recent.map((r) =>
          h('button', {
            type: 'button',
            class: 'chip',
            onclick: () => {
              input.value = r; // fills only – the user still has to press Join
              touched = true;
              validate();
              input.focus();
            },
          }, r),
        ),
      )
    : null;

  const form = h(
    'form',
    { class: 'onboarding card room-screen', novalidate: true },
    h('div', { class: 'brand-mark big' }, '◉'),
    h('h1', {}, 'MeshCall'),
    h('h2', {}, 'Join a Room'),
    h('p', { class: 'hint' }, `Signed in as ${opts.userName}. People only see and call others in the same room.`),
    h('label', { for: 'room-name' }, 'Room Name'),
    input,
    error,
    recent,
    join,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    touched = true;
    const v = validate();
    if (!v.ok) {
      error.textContent = v.error;
      return;
    }
    busy = true;
    join.disabled = true;
    input.disabled = true;
    join.textContent = 'Joining…';
    error.textContent = '';
    try {
      await opts.onJoin(v.room);
    } catch (err) {
      busy = false;
      input.disabled = false;
      join.textContent = 'Join Room';
      error.textContent = err instanceof Error ? err.message : 'Unable to join room';
      validate();
    }
  });
  root.replaceChildren(h('div', { class: 'onboarding-wrap' }, form));
  validate();
  input.focus();
}
