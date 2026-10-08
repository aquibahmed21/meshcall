const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** MeshCall mark (three fully connected nodes), same geometry as public/icon.svg. */
export const logo = `<svg class="logo" viewBox="3 3 18 18" width="1em" height="1em" aria-hidden="true"><path d="M12 7.2 6.4 16.8h11.2z" fill="currentColor" fill-opacity=".16" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><g fill="currentColor"><circle cx="12" cy="7.2" r="2.8"/><circle cx="6.4" cy="16.8" r="2.8"/><circle cx="17.6" cy="16.8" r="2.8"/></g></svg>`;

export const icons = {
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  micOff: svg('<path d="M3 3l18 18"/><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3"/><path d="M5 11a7 7 0 0 0 11.6 5.3M19 11a7 7 0 0 1-.7 3M12 18v3"/>'),
  cam: svg('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>'),
  camOff: svg('<path d="M3 3l18 18"/><path d="M16 16H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1M10 6h4a2 2 0 0 1 2 2v3l5-3v10"/>'),
  phone: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>'),
  hangup: svg('<path d="M2.4 13.5c5.4-4.6 13.8-4.6 19.2 0 .6.5.7 1.4.2 2l-1.6 1.9c-.4.5-1.1.6-1.7.3l-2.7-1.4a1.3 1.3 0 0 1-.7-1.2V13a12 12 0 0 0-6.2 0v2.1c0 .5-.3 1-.7 1.2l-2.7 1.4c-.6.3-1.3.2-1.7-.3L2.2 15.5c-.5-.6-.4-1.5.2-2z"/>'),
  screen: svg('<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4M12 8v5M9.5 10.5 12 8l2.5 2.5"/>'),
  flip: svg('<path d="M20 7h-3.5l-2-3h-5l-2 3H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z"/><path d="M9 13a3 3 0 0 0 5.5 1.5M15 12a3 3 0 0 0-5.5-1.5M14 15h1v1M10 10H9V9"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  stats: svg('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
  users: svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
  userPlus: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/>'),
  live: svg('<circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19.1 4.9a10 10 0 0 1 0 14.2M4.9 19.1a10 10 0 0 1 0-14.2"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  bell: svg('<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>'),
  refresh: svg('<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15"/>'),
  remove: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  send: svg('<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>'),
  fullscreen: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  exitFullscreen: svg('<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>'),
  pip: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><rect x="12" y="11" width="8" height="6" rx="1" fill="currentColor"/>'),
  pipExit: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  share: svg('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  layout: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15h18M9 15v6M15 15v6"/>'),
  exit: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"/>'),
  trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>'),
  more: svg('<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>'),
  volume: svg('<path d="M11 5 6 9H2v6h4l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'),
};
