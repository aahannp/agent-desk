// Shared by every view: live state, API calls, a tiny DOM builder, icons, toasts, menus and dialogs.

export const state = { project: '', projects: [], tasks: [], sessions: [], chats: [], artifacts: [], specialists: [], agents: [], settings: {}, info: {}, termTheme: {}, theme: null };

// Views register what they can do here, so they can call each other without importing each other.
export const actions = {};
export const commands = [];
export const command = (title, run, extra = {}) => commands.push({ title, run, ...extra });

const listeners = new Map();
export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type).delete(fn);
}
export const emit = (type, detail) => listeners.get(type)?.forEach(fn => fn(detail));

export async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) location.reload(); // the secret changed; the page shows how to get back in
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Runs an async action and shows its error as a toast instead of failing silently.
export const guard = fn => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    toast(e.message, 'error');
  }
};

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in el && typeof el[key] !== 'object') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter(c => c != null && c !== false).map(c => (c instanceof Node ? c : document.createTextNode(String(c)))));
  return el;
}

const ICONS = {
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  board: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18M15 3v12"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  branch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  maximize: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  minimize: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  arrow: '<line x1="5" y1="19" x2="19" y2="5"/><polyline points="9 5 19 5 19 15"/>',
  box: '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  text: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="3"/><line x1="9" y1="4" x2="9" y2="20"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  graph: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
};

export function icon(name, size = 16) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

export function toast(message, kind = 'info', action) {
  const ms = kind === 'error' ? 7000 : 4000;
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}` },
    icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info'), h('span', {}, message),
    action && h('button', { class: 'btn xs', onClick: () => { action.onClick(); t.remove(); } }, action.label));
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 300);
}

export function modal({ title, body, actions: buttons = [], width = 520, onClose }) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  const overlay = h('div', { class: 'overlay', onMousedown: e => e.target === overlay && close() },
    h('div', { class: 'modal', style: { width: `${width}px` } },
      h('header', {}, h('h3', {}, title), h('button', { class: 'icon-btn', title: 'Close', onClick: close }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      buttons.length > 0 && h('footer', {}, buttons.map(b => h('button', {
        class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`,
        onClick: async () => { if ((await b.onClick?.()) !== false) close(); },
      }, b.label)))));
  document.body.append(overlay);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => overlay.querySelector('input, textarea, select')?.focus());
  return close;
}

export function confirmDialog(title, message, { label = 'Confirm', danger = false } = {}) {
  return new Promise(resolve => {
    let answered = false;
    const answer = value => () => { answered = true; resolve(value); };
    modal({
      title, body: h('p', { class: 'muted' }, message), width: 440,
      actions: [{ label: 'Cancel', onClick: answer(false) }, { label, danger, primary: !danger, onClick: answer(true) }],
      onClose: () => answered || resolve(false),
    });
  });
}

export function askText(title, { label = '', value = '', placeholder = '', ok = 'Save', multiline = false } = {}) {
  return new Promise(resolve => {
    let answered = false;
    const input = h(multiline ? 'textarea' : 'input', { class: 'input', value, placeholder });
    const submit = () => { answered = true; resolve(input.value.trim()); };
    if (!multiline) input.addEventListener('keydown', e => e.key === 'Enter' && (submit(), close()));
    const close = modal({
      title, width: 480, body: h('label', { class: 'field' }, label && h('span', {}, label), input),
      actions: [{ label: 'Cancel' }, { label: ok, primary: true, onClick: submit }],
      onClose: () => answered || resolve(null),
    });
  });
}

// A dropdown under `anchor`. Items: { label, icon, sub, onClick, disabled }, 'sep', or { heading }.
export function menu(anchor, items, { align = 'left' } = {}) {
  document.querySelector('.menu')?.remove();
  const r = anchor.getBoundingClientRect();
  const m = h('div', { class: 'menu' }, items.map(item => {
    if (item === 'sep') return h('div', { class: 'sep' });
    if (item.heading) return h('div', { class: 'menu-label' }, item.heading);
    return h('button', { class: 'menu-item', disabled: item.disabled, onClick: () => { m.remove(); item.onClick(); } },
      item.icon && icon(item.icon, 15), h('span', {}, item.label), item.sub && h('span', { class: 'sub' }, item.sub));
  }));
  document.body.append(m);
  const width = m.offsetWidth;
  m.style.top = `${Math.min(r.bottom + 6, innerHeight - m.offsetHeight - 8)}px`;
  m.style.left = `${Math.max(8, Math.min(align === 'right' ? r.right - width : r.left, innerWidth - width - 8))}px`;
  setTimeout(() => document.addEventListener('mousedown', function off(e) {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); }
  }));
}

// A small coloured tile that says what kind of agent a session is.
// A specialist gets their initial on a colour of their own; the colour follows the name, so it never changes.
export const TEAM_COLORS = ['#e8590c', '#0ca678', '#7048e8', '#1c7ed6', '#d6336c', '#f59f00', '#0b7285', '#5c940d'];
export const teamColor = name => TEAM_COLORS[[...String(name)].reduce((n, ch) => (n * 31 + ch.codePointAt(0)) >>> 0, 7) % TEAM_COLORS.length];
export function avatar(s, small = false) {
  if (s.specialist) return h('span', { class: `avatar${small ? ' sm' : ''}`, style: { background: teamColor(s.specialist.name) }, title: s.specialist.role }, s.specialist.name.slice(0, 1).toUpperCase());
  const kind = s.kind === 'browser' ? 'browser' : s.role === 'lead' ? 'lead' : s.kind === 'shell' ? 'shell' : s.agent;
  const letters = { claude: 'C', codex: 'Cx', gemini: 'G', cursor: 'Cu' };
  const glyph = { lead: 'star', shell: 'terminal', browser: 'globe' }[kind];
  return h('span', { class: `avatar ${kind}${small ? ' sm' : ''}` }, glyph ? icon(glyph, small ? 11 : 14) : letters[kind] ?? 'A');
}
export const STATUS_LABEL = { working: 'Working', idle: 'Idle', 'needs-input': 'Needs you', exited: 'Exited' };

export const agentLabel = id => state.agents.find(a => a.id === id)?.label ?? (id || 'Agent');
export const shortBranch = branch => (branch || '').replace(/^desk\//, '');
export const projectSessions = () => state.sessions.filter(s => s.project === state.project);
export const projectTasks = () => state.tasks.filter(t => t.project === state.project);
export const projectChats = () => state.chats.filter(c => c.project === state.project);
// A chat's best name: your rename, Claude's own title, or what the pane was called.
export const chatTitle = s => state.chats.find(c => c.id === s.chatId)?.title ?? s.name;
// Drag payloads between the sidebar and the grid.
export const DRAG = { chat: 'application/x-desk-chat', pane: 'application/x-desk-pane' };
export const baseName = p => p.split('/').filter(Boolean).pop() || p;
// For text shown cut off on the left (direction: rtl), so leading "~" or "/" stays where it belongs.
export const ltr = text => `\u200E${text}\u200E`;

export function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

export async function copy(text) {
  await navigator.clipboard.writeText(text);
  toast('Copied', 'ok');
}
