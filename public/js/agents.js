// Agents view: every agent, shell and browser pane for the project, tiled in a grid of real terminals.
import { state, api, h, icon, avatar, on, emit, toast, guard, actions, command, commands, menu, askText, modal, confirmDialog, agentLabel, shortBranch, baseName, copy, chatTitle, DRAG, MONO, STATUS_LABEL } from './ui.js';

const panes = new Map(); // id -> pane (a session's terminal, or a browser)
const seen = new Map(); // session id -> last status we told you about
let grid;
let empty;
let focusedId = null;

export function mount(root) {
  grid = h('div', { class: 'grid' });
  empty = h('div', { class: 'empty-state' }, h('div', { class: 'empty-card' },
    h('div', { class: 'art' }, icon('terminal', 36)),
    h('h2', {}, 'Your agents work here'),
    h('p', {}, 'Start a Claude Code agent, let a lead agent plan and split the work, or open a plain shell. Every pane is a real terminal using your own login.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onClick: () => newSession() }, icon('plus', 15), 'New agent'),
      h('button', { class: 'btn', onClick: () => actions.startLead() }, icon('star', 15), 'Lead agent'),
      h('button', { class: 'btn', onClick: () => newSession({ kind: 'shell' }) }, icon('terminal', 15), 'Shell')),
    h('div', { class: 'tips' },
      h('span', {}, h('kbd', {}, '⌘K'), 'commands'),
      h('span', {}, h('kbd', {}, '⌘⇧M'), 'voice'),
      h('span', {}, 'Double-click a pane header to maximise it'))));
  root.append(grid, empty);
  new ResizeObserver(layout).observe(grid);
  dropTarget(root);
  on('sessions', sync);
  on('chats', () => { for (const p of panes.values()) if (p.kind === 'term') renderHead(p); });
  on('project', sync);
  on('settings', syncBrowsers);
  on('theme', retheme);
  setInterval(tick, 1000);
}

export function toolbar() {
  const installed = state.agents.filter(a => a.installed);
  return [
    h('button', { class: 'btn', onClick: () => actions.startLead(), title: 'A lead agent plans the work and starts workers' }, icon('star', 15), 'Lead agent'),
    h('div', { class: 'split' },
      h('button', { class: 'btn primary', onClick: () => newSession() }, icon('plus', 15), `New ${agentLabel(state.settings.defaultAgent)}`),
      h('button', { class: 'btn primary', title: 'More kinds of pane', onClick: e => menu(e.currentTarget, [
        { heading: 'In the project folder' },
        ...installed.map(a => ({ label: a.label, icon: 'terminal', onClick: () => newSession({ agent: a.id }) })),
        { heading: 'In its own git worktree' },
        ...installed.map(a => ({ label: a.label, icon: 'branch', onClick: () => newSession({ agent: a.id, worktree: true }) })),
        ...(claudeReady() && state.specialists.length ? [{ heading: 'Specialists' },
          ...state.specialists.map(x => ({ label: x.name, sub: x.role.split(':')[0], icon: 'sparkles', onClick: () => startSpecialist(x) }))] : []),
        'sep',
        { label: 'Shell', icon: 'terminal', onClick: () => newSession({ kind: 'shell' }) },
        { label: 'Browser pane', icon: 'globe', onClick: () => newBrowser() },
      ], { align: 'right' }) }, icon('chevron', 14))),
  ];
}

// ---------- Starting things ----------
const newSession = guard(async (opts = {}) => {
  if (!state.project) throw new Error('Add a project folder first');
  const s = await api('POST', '/api/sessions', { project: state.project, kind: 'agent', agent: state.settings.defaultAgent, ...opts });
  await actions.refresh('sessions');
  focusSession(s.id);
  return s;
});
actions.newSession = newSession;

// Opens a chat: shows it if it's running, otherwise starts it again (Claude picks up the same conversation).
// `place` puts its pane before or after another one; a finished pane for the chat keeps its spot.
actions.openChat = guard(async (chatId, place = null) => {
  if (!state.chats.some(c => c.id === chatId)) return; // drag data can come from anywhere, so only known chats
  const old = [...panes.values()].find(p => p.session?.chatId === chatId);
  const spot = place ?? (old && { ref: old.id, side: 'replace' });
  const anchor = spot?.side === 'replace' ? old.el.nextElementSibling : null;
  const { session, replaced } = await api('POST', `/api/chats/${encodeURIComponent(chatId)}/open`);
  if (replaced) dispose(replaced);
  await actions.refresh('sessions');
  if (anchor?.isConnected) put(panes.get(session.id).el, anchor);
  else if (spot && spot.side !== 'replace') movePane(session.id, spot);
  saveOrder();
  layout();
  focusSession(session.id);
});

// Naming an agent names its chat too, and other agents reach it by that name ("ask Adam").
const renameAgent = guard(async s => {
  const title = await askText('Name this agent', { value: chatTitle(s), placeholder: 'Like Adam or Emilie', ok: 'Name' });
  if (title?.trim()) await api('PATCH', `/api/chats/${encodeURIComponent(s.chatId)}`, { title });
});
actions.renameAgent = renameAgent;

// ---------- Specialists ----------
const claudeReady = () => state.agents.some(a => a.id === 'claude' && a.installed);
const MODELS = [['', 'Their usual model'], ['opus', 'Opus: the most capable'], ['sonnet', 'Sonnet: everyday work'], ['haiku', 'Haiku: quick and cheap']];
export const modelSelect = value => h('select', { class: 'input' }, MODELS.map(([id, label]) => h('option', { value: id, selected: id === value }, label)));
const EFFORTS = [['', 'Their usual effort'], ['low', 'Low: quickest'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max: most thorough']];
export const effortSelect = value => h('select', { class: 'input' }, EFFORTS.map(([id, label]) => h('option', { value: id, selected: id === value }, label)));
const usual = x => [x.model || 'default model', x.effort ? `${x.effort} effort` : 'default effort'].join(' · ');

// Starts a specialist. The first message is optional: Christie, say, starts by asking what you want to learn.
function startSpecialist(x) {
  if (!state.project) return toast('Add a project folder first', 'error');
  const ask = h('textarea', { class: 'input', rows: 4, placeholder: `What should ${x.name} help with? You can leave this empty and tell them in the pane.` });
  const model = modelSelect('');
  const effort = effortSelect('');
  const worktree = h('input', { type: 'checkbox' });
  modal({
    title: `Start ${x.name}`, width: 560,
    body: [
      h('div', { class: 'specialist-head' }, avatar({ specialist: x }), h('div', {}, h('b', {}, x.name), h('p', { class: 'muted' }, `${x.role}. Usually ${usual(x)}.`))),
      h('label', { class: 'field' }, h('span', {}, 'First message'), ask),
      h('div', { class: 'row', style: { marginBottom: '8px' } },
        h('label', { class: 'field', style: { flex: 1, margin: 0 } }, h('span', {}, 'Model'), model),
        h('label', { class: 'field', style: { flex: 1, margin: 0 } }, h('span', {}, 'Effort'), effort)),
      h('label', { class: 'toggle', style: { margin: '6px 0' } }, worktree, 'Own git worktree'),
    ],
    actions: [{ label: 'Cancel' }, { label: `Start ${x.name}`, primary: true, onClick: () =>
      newSession({ agent: 'claude', specialist: x.id, model: model.value, effort: effort.value, prompt: ask.value.trim(), worktree: worktree.checked }) }],
  });
}
actions.startSpecialist = startSpecialist;
// One agent messaged another: say so, and offer to jump to the pane where it arrived.
on('agent-message', e => toast(e.started ? `${e.from} started ${e.to} with a message` : `${e.from} → ${e.to}`, 'info',
  { label: 'Show', onClick: () => focusSession(e.toId) }));
on('specialist-changed', e => toast(`${e.name}'s profile was changed by ${e.by}`, 'info', { label: 'Show', onClick: () => actions.showView('settings') }));
on('specialists', () => {
  for (const x of state.specialists) {
    if (!commands.some(c => c.specialist === x.id)) command(`Start ${x.name}`, () => startSpecialist(state.specialists.find(y => y.id === x.id) ?? x), { icon: 'sparkles', specialist: x.id });
  }
});

actions.startLead = () => {
  if (!state.project) return toast('Add a project folder first', 'error');
  const goal = h('textarea', { class: 'input', rows: 5, placeholder: 'For example: add a dark mode toggle to the settings page, with tests, and update the docs' });
  modal({
    title: 'Start a lead agent', width: 580,
    body: [
      h('p', { class: 'muted' }, 'The lead reads the code, turns your goal into tasks on the board, and starts a worker for each one in its own git worktree. You review and merge what they make.'),
      h('label', { class: 'field' }, h('span', {}, 'What should the team do?'), goal),
    ],
    actions: [{ label: 'Cancel' }, {
      label: 'Start lead', primary: true, onClick: async () => {
        if (!goal.value.trim()) { toast('Describe the goal first', 'error'); return false; }
        await newSession({ agent: 'claude', role: 'lead', prompt: goal.value.trim(), name: 'Lead agent' });
      },
    }],
  });
};

command('New agent', () => newSession(), { icon: 'plus' });
command('New agent in its own worktree', () => newSession({ worktree: true }), { icon: 'branch' });
command('Start a lead agent', () => actions.startLead(), { icon: 'star' });
command('New shell', () => newSession({ kind: 'shell' }), { icon: 'terminal' });
command('New browser pane', () => newBrowser(), { icon: 'globe' });

// ---------- Keeping panes in step with the server ----------
function sync() {
  if (!grid) return;
  const live = new Set();
  for (const s of state.sessions) {
    live.add(s.id);
    const p = panes.get(s.id) ?? terminalPane(s);
    p.session = s;
    p.el.classList.toggle('hidden', s.project !== state.project);
    renderHead(p);
    announce(s);
  }
  for (const [id, p] of panes) if (p.kind === 'term' && !live.has(id)) dispose(id);
  syncBrowsers();
  restoreOrder();
}

// The order you arrange panes in is remembered per project, in this browser only (a convenience, not data).
const orderKey = () => `agent-desk:order:${state.project}`;
function saveOrder() {
  try { localStorage.setItem(orderKey(), JSON.stringify([...grid.children].map(el => el.dataset.id))); } catch {}
  emit('tick'); // the sidebar lists open panes in the same order
}
function restoreOrder() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(orderKey()) || '[]'); } catch {}
  const rank = new Map(saved.map((id, i) => [id, i]));
  const sorted = [...grid.children].sort((a, b) => (rank.get(a.dataset.id) ?? Infinity) - (rank.get(b.dataset.id) ?? Infinity));
  sorted.forEach((el, i) => grid.children[i] !== el && put(el, grid.children[i])); // only what's out of place moves
}
actions.paneOrder = () => [...grid.children].map(el => el.dataset.id);

function layout() {
  if (!grid) return;
  const visible = [...panes.values()].filter(p => !p.el.classList.contains('hidden'));
  const n = visible.length;
  empty.hidden = n > 0;
  let cols = Math.ceil(Math.sqrt(n)) || 1;
  if (n === 3 && grid.clientWidth > 1300) cols = 3;
  if (n === 2 && grid.clientWidth < 900) cols = 1;
  grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grid.classList.toggle('one-col', cols === 1); // panes stack, so "before" and "after" mean above and below
  grid.style.gridTemplateRows = `repeat(${Math.ceil(n / cols) || 1}, minmax(0, 1fr))`;
  const max = grid.querySelector('.pane.max');
  if (max && max.classList.contains('hidden')) unmaximise();
}

// What a session is doing right now. Output in the last 2.5s means it's working.
const statusOf = s => {
  if (s.exited) return 'exited';
  if (s.status === 'needs-input') return 'needs-input';
  const p = panes.get(s.id);
  if (!p) return s.status;
  return Date.now() - p.lastData < 2500 ? 'working' : 'idle';
};
actions.statusOf = statusOf;

function tick() {
  for (const p of panes.values()) {
    if (p.kind !== 'term') continue;
    const status = statusOf(p.session);
    p.state.className = `state ${status}`;
    p.dot.className = `dot ${status}`;
    p.stateText.textContent = STATUS_LABEL[status] ?? status;
  }
  emit('tick');
}

// Tell you when an agent needs you or finishes, unless you're already looking at it.
function announce(s) {
  const now = s.exited ? 'exited' : s.status === 'needs-input' ? 'needs-input' : 'running';
  const before = seen.get(s.id);
  seen.set(s.id, now);
  if (!before || before === now || now === 'running') return;
  if (document.hasFocus() && focusedId === s.id) return;
  const body = now === 'exited' ? `Finished (exit code ${s.exitCode})` : 'Needs your input';
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(s.name, { body }).onclick = () => { window.focus(); focusSession(s.id); };
  }
  toast(`${s.name}: ${body.toLowerCase()}`, 'info', { label: 'Show', onClick: () => focusSession(s.id) });
}

// On a light background, xterm darkens any text colour that would read below 4.5:1, so pale prompt and
// truecolor output from other tools stays legible. Dark themes keep their colours exactly.
const contrast = () => state.theme?.dark === false ? 4.5 : 1;

function retheme() {
  for (const p of panes.values()) {
    if (p.kind !== 'term') continue;
    p.term.options.theme = state.termTheme;
    p.term.options.minimumContrastRatio = contrast();
    p.term.options.fontSize = Number(state.settings.fontSize) || 13;
    Object.assign(p.peek.options, lookOf(p.term));
    p.fit();
  }
}

// ---------- Terminal panes ----------
// Scroll like Terminal and iTerm: smoothly, pixel by pixel, exactly as far as the trackpad or wheel says,
// momentum included. xterm only draws whole rows, so between rows the text is shifted up by the leftover
// pixels, and a one-row "peek" below it (a copy of the next line, colours and all) slides into view.
// Programs that read the mouse (Claude Code does, full screen) get one wheel click per row moved, as
// Terminal and iTerm send. xterm alone sends a single click per scroll event at 30% of the distance, which
// is what made scrolling Claude feel so slow. Settings has a scroll speed for the rest.
function smoothScroll(term, host) {
  const screen = host.querySelector('.xterm-screen');
  const peekEl = h('div', { class: 'term-peek', 'aria-hidden': 'true' });
  screen.append(peekEl);
  const peek = new Terminal({ ...lookOf(term), rows: 1, cols: term.cols, scrollback: 0, disableStdin: true, cursorInactiveStyle: 'none' });
  peek.open(peekEl);
  const copy = new SerializeAddon.SerializeAddon();
  term.loadAddon(copy);

  let f = 0; // pixels past the top row on screen, 0 up to one row
  let top = -1; // the row we put at the top, so we can tell our scrolling from xterm's own
  let peekRow = -1;
  let clicks = 0; // wheel clicks owed to a program that reads the mouse, in fractions of a row
  let sgr = false; // the mouse encoding Claude Code asks for (1006); other encodings are left to xterm
  const mouseMode = on => params => { if (params.includes(1006)) sgr = on; return false; };
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, mouseMode(true));
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, mouseMode(false));
  const rowPx = () => screen.offsetHeight / term.rows;
  const show = () => {
    const below = term.buffer.active.viewportY + term.rows;
    const visible = f > 0 && below < term.buffer.active.length;
    screen.style.transform = f ? `translateY(${-f}px)` : '';
    peekEl.style.top = `${screen.offsetHeight}px`;
    peekEl.style.visibility = visible ? 'visible' : 'hidden';
    if (visible && below !== peekRow) {
      peekRow = below;
      peek.reset();
      peek.write(`\x1b[?25l${copy.serialize({ range: { start: below, end: below } })}`);
    }
  };
  // New output at the bottom, typing, a resize or a full-screen program moves the view itself: line up again.
  const settle = () => {
    if (term.buffer.active.viewportY === top && term.buffer.active.type === 'normal') return;
    f = 0;
    peekRow = -1;
    show();
  };
  term.onScroll(settle);
  term.buffer.onBufferChange(settle);
  term.onResize(({ cols }) => { peek.resize(cols, 1); peekRow = -1; settle(); });

  host.addEventListener('wheel', e => {
    if (e.ctrlKey || !e.deltaY) return;
    const ch = rowPx();
    if (!ch) return;
    const speed = Number(state.settings.scrollSpeed) || 1;
    const px = (e.deltaMode === 1 ? e.deltaY * ch : e.deltaMode === 2 ? e.deltaY * ch * term.rows : e.deltaY) * speed;
    if (term.modes.mouseTrackingMode !== 'none') {
      if (!sgr) return;
      e.preventDefault();
      e.stopPropagation(); // in the capture phase, so xterm's own handler never sees it
      if (Math.sign(px) !== Math.sign(clicks)) clicks = 0;
      clicks += px / ch;
      const n = Math.trunc(clicks);
      if (!n) return;
      clicks -= n;
      const r = screen.getBoundingClientRect();
      const col = Math.min(term.cols, Math.max(1, Math.floor((e.clientX - r.left) / (r.width / term.cols)) + 1));
      const row = Math.min(term.rows, Math.max(1, Math.floor((e.clientY - r.top) / ch) + 1));
      const button = (n < 0 ? 64 : 65) + (e.shiftKey ? 4 : 0) + (e.altKey ? 8 : 0); // wheel up or down
      term.input(`\x1b[<${button};${col};${row}M`.repeat(Math.abs(n)), true);
      return;
    }
    if (term.buffer.active.type !== 'normal') return; // full screen without the mouse: xterm sends arrow keys
    e.preventDefault();
    e.stopPropagation();
    const buf = term.buffer.active;
    const pos = Math.max(0, Math.min(buf.viewportY * ch + f + px, buf.baseY * ch));
    top = Math.floor(pos / ch);
    f = pos - top * ch;
    if (top !== buf.viewportY) term.scrollToLine(top);
    show();
  }, { capture: true, passive: false });
  return peek;
}

// What a terminal looks like, shared with its peek row so the two match.
const lookOf = term => Object.fromEntries(['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'fontWeight', 'fontWeightBold', 'theme', 'minimumContrastRatio'].map(k => [k, term.options[k]]));

function terminalPane(s) {
  const term = new Terminal({
    fontFamily: MONO, fontSize: Number(state.settings.fontSize) || 13, lineHeight: 1.2, cursorBlink: true,
    allowProposedApi: true, macOptionIsMeta: true, scrollback: 5000, theme: state.termTheme, minimumContrastRatio: contrast(),
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);

  const dot = h('span', { class: 'dot' });
  const stateText = h('span', {}, 'Starting');
  const state_ = h('span', { class: 'state' }, dot, stateText);
  const title = h('span', { class: 'pane-title' });
  const sub = h('span', { class: 'pane-sub' });
  const face = h('span', {});
  const host = h('div', { class: 'term-host' });
  const blocks = h('div', { class: 'blocks' });
  const exitBar = h('div', { class: 'exit-bar' });
  const id = s.id;
  const blocksBtn = s.kind === 'shell' && h('button', { class: 'icon-btn', title: 'Command blocks', onClick: () => blocksBtn.classList.toggle('on', el.classList.toggle('show-blocks')) }, icon('list', 15));
  const head = h('div', { class: 'pane-head', draggable: true, title: 'Drag to move this pane', onDragstart: e => dragPane(e, id), onDragend: () => el.classList.remove('dragging'), onDblclick: e => !e.target.closest('button') && toggleMaximise(id) },
    face, h('div', { class: 'pane-titles' }, title, sub), state_,
    h('div', { class: 'pane-tools' },
      blocksBtn,
      s.chatId && h('button', { class: 'icon-btn', title: 'Name this agent', onClick: () => renameAgent(s) }, icon('pen', 13)),
      h('button', { class: 'icon-btn', title: 'Maximise (double-click the header)', onClick: () => toggleMaximise(id) }, icon('maximize', 14)),
      h('button', { class: 'icon-btn', title: 'Stop and close', onClick: () => closePane(id) }, icon('x', 15))));
  const el = h('div', { class: 'pane', 'data-id': id }, head, h('div', { class: 'pane-body' }, host, blocks), exitBar);
  grid.append(el);
  term.open(host);
  // Draw on the GPU, as VS Code's terminal does: far less work per frame than the default renderer, which
  // rebuilds every row as page text on each scroll step. A page gets about 16 WebGL contexts, so a pane
  // that loses its context (or a Mac without WebGL) falls back to the default renderer and keeps working.
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {}

  const p = { id, kind: 'term', el, term, dot, state: state_, stateText, title, sub, face, exitBar, blocksEl: blocks, session: s, lastData: 0, ws: null, size: '' };
  p.send = data => p.ws?.readyState === WebSocket.OPEN && p.ws.send(JSON.stringify({ t: 'in', d: data }));
  p.fit = () => {
    if (!host.offsetWidth) return;
    fitAddon.fit();
    const size = `${term.cols}x${term.rows}`;
    if (size !== p.size && p.ws?.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }));
      p.size = size;
    }
  };
  term.onData(d => p.send(d));
  host.addEventListener('focusin', () => setFocus(id));
  p.peek = smoothScroll(term, host);
  new ResizeObserver(() => p.fit()).observe(host);
  if (s.kind === 'shell') commandBlocks(p);
  connect(p);
  panes.set(id, p);
  layout();
  return p;
}

// Each (re)connect gets a fresh copy of the screen from the server, so clear before drawing it.
function connect(p) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?id=${p.id}`);
  let first = true;
  p.ws = ws;
  ws.onopen = () => { p.size = ''; p.fit(); };
  ws.onmessage = e => {
    if (first) { p.term.reset(); first = false; }
    p.term.write(e.data);
    p.lastData = Date.now();
  };
  ws.onclose = () => {
    if (panes.get(p.id) === p && !p.session.exited) setTimeout(() => panes.get(p.id) === p && connect(p), 1500);
  };
}

function renderHead(p) {
  const s = p.session;
  p.title.textContent = chatTitle(s);
  p.face.replaceChildren(avatar(s));
  const kind = [s.specialist ? s.specialist.role.split(':')[0] : s.role === 'lead' ? 'Lead agent' : s.kind === 'shell' ? 'Shell' : agentLabel(s.agent), s.model, s.effort].filter(Boolean).join(' · ');
  p.sub.replaceChildren(...[
    h('span', {}, kind), h('span', { class: 'sep' }, '/'),
    s.worktree ? h('span', { title: s.worktree.path }, shortBranch(s.worktree.branch)) : h('span', { title: s.cwd }, baseName(s.cwd)),
    s.taskId && h('span', { class: 'sep' }, '/'),
    s.taskId && h('button', { title: 'Open the task', onClick: () => actions.openTask?.(s.taskId) }, 'task'),
  ].filter(Boolean));
  p.el.classList.toggle('exited', s.exited);
  p.el.classList.toggle('attn', s.status === 'needs-input');
  if (s.exited && !p.exitBar.childElementCount) {
    p.exitBar.append(...[
      h('span', {}, `Exited with code ${s.exitCode}`), h('span', { class: 'grow' }),
      s.chatId && h('button', { class: 'btn xs primary', onClick: () => actions.openChat(s.chatId) }, icon('refresh', 12), s.agent === 'claude' ? 'Resume' : 'Start again'),
      s.worktree && h('button', { class: 'btn xs', onClick: () => actions.reviewWorktree?.(s.worktree.path) }, icon('branch', 12), 'Review changes'),
      h('button', { class: 'btn xs', onClick: () => closePane(p.id) }, 'Close'),
    ].filter(Boolean));
  }
}

function setFocus(id) {
  focusedId = id;
  for (const p of panes.values()) p.el.classList.toggle('focus', p.id === id);
}
actions.focusedSession = () => (panes.get(focusedId)?.kind === 'term' ? focusedId : null);

function focusSession(id) {
  const p = panes.get(id);
  if (!p) return;
  if (p.session.project !== state.project) actions.switchProject(p.session.project);
  actions.showView('agents');
  if (grid.classList.contains('solo') && !p.el.classList.contains('max')) toggleMaximise(id);
  setFocus(id);
  setTimeout(() => p.term.focus());
}
actions.focusSession = focusSession;

// Type into a session's terminal (voice and screenshots use this). Enter is sent separately.
actions.typeInto = (id, text, submit = false) => {
  const p = panes.get(id);
  if (!p || p.kind !== 'term') return false;
  p.send(text);
  if (submit) setTimeout(() => p.send('\r'), 120);
  return true;
};
actions.runningAgents = () => [...panes.values()].filter(p => p.kind === 'term' && !p.session.exited && p.session.project === state.project).map(p => p.session);

function toggleMaximise(id) {
  const p = panes.get(id);
  const on = !p.el.classList.contains('max');
  grid.querySelectorAll('.pane.max').forEach(x => x.classList.remove('max'));
  p.el.classList.toggle('max', on);
  grid.classList.toggle('solo', on);
}
const unmaximise = () => {
  grid.querySelectorAll('.pane.max').forEach(x => x.classList.remove('max'));
  grid.classList.remove('solo');
};

const closePane = guard(async id => {
  const p = panes.get(id);
  if (p.kind === 'browser') return removeBrowser(p);
  const keeps = p.session.chatId ? ' The chat stays in the sidebar, so you can drag it back in to carry on.' : '';
  if (!p.session.exited && !(await confirmDialog(`Stop "${chatTitle(p.session)}"?`, `This ends the process running in this pane.${keeps}`, { label: 'Stop', danger: true }))) return;
  await api('DELETE', `/api/sessions/${id}`);
  dispose(id);
  actions.refresh('sessions');
});

function dispose(id) {
  const p = panes.get(id);
  if (!p) return;
  panes.delete(id);
  if (p.ws) { p.ws.onclose = null; p.ws.close(); }
  p.term?.dispose();
  p.peek?.dispose();
  if (p.el.classList.contains('max')) unmaximise();
  p.el.remove();
  if (focusedId === id) focusedId = null;
  layout();
}

// ---------- Drag and drop ----------
// Chats from the sidebar and pane headers can be dropped onto the grid: the left (or, when panes stack, top)
// half of a pane puts it before that pane, the other half after it, anywhere else at the end.
function dragPane(e, id) {
  e.dataTransfer.setData(DRAG.pane, id);
  e.dataTransfer.effectAllowed = 'move';
  panes.get(id)?.el.classList.add('dragging');
}

const carries = e => [DRAG.chat, DRAG.pane].some(t => e.dataTransfer.types.includes(t));

function spotAt(e) {
  const el = e.target.closest?.('.pane');
  const p = el && panes.get(el.dataset.id);
  if (!p || p.el.classList.contains('hidden')) return null;
  const r = el.getBoundingClientRect();
  const before = grid.classList.contains('one-col') ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
  return { ref: p.id, side: before ? 'before' : 'after' };
}

function markDrop(spot) {
  for (const p of panes.values()) p.el.classList.remove('drop-before', 'drop-after');
  grid.classList.toggle('drop-end', !spot);
  if (spot) panes.get(spot.ref)?.el.classList.add(`drop-${spot.side}`);
}
const clearDrop = () => {
  markDrop(null);
  grid.classList.remove('drop-end');
};

// moveBefore keeps a moved element alive; insertBefore would reload a browser pane's page.
function put(el, before) {
  try {
    if (grid.moveBefore) return grid.moveBefore(el, before);
  } catch {} // not movable in place (older browser): fall back
  grid.insertBefore(el, before);
}

function movePane(id, spot) {
  const el = panes.get(id)?.el;
  const ref = spot && panes.get(spot.ref)?.el;
  if (!el || !ref || ref === el) return;
  put(el, spot.side === 'before' ? ref : ref.nextSibling);
}

function dropTarget(root) {
  root.addEventListener('dragover', e => {
    if (!carries(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    markDrop(spotAt(e));
  });
  root.addEventListener('dragleave', e => !root.contains(e.relatedTarget) && clearDrop());
  root.addEventListener('drop', e => {
    if (!carries(e)) return;
    e.preventDefault();
    const spot = spotAt(e);
    clearDrop();
    const chat = e.dataTransfer.getData(DRAG.chat);
    const pane = e.dataTransfer.getData(DRAG.pane);
    if (chat) actions.openChat(chat, spot);
    else if (panes.has(pane)) {
      movePane(pane, spot ?? { ref: [...grid.children].at(-1)?.dataset.id, side: 'after' });
      saveOrder();
      layout();
    }
  });
  // Dragging a chat over another view switches to the agents so it can be dropped there.
  document.getElementById('views').addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes(DRAG.chat) && actions.currentView() !== 'agents') actions.showView('agents');
  });
  document.addEventListener('dragend', clearDrop);
}

// ---------- Command blocks (Warp style) ----------
// The shell marks each command (see shell/zsh/.zshrc), so every command and its output becomes a block
// you can jump to, copy or run again.
function commandBlocks(p) {
  const { term } = p;
  const list = h('div', { class: 'blocks-list' }, h('div', { class: 'blocks-empty' }, 'Run a command and it shows up here as a block.'));
  p.blocksEl.append(h('div', { class: 'blocks-head' }, icon('list', 14), 'Command blocks'), list);
  const blocks = [];
  let commandText = '';
  let prompt = null;
  let open = null;

  const output = b => {
    const buffer = term.buffer.active;
    const lines = [];
    for (let i = b.out.line; i >= 0 && i < b.end.line; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n').trimEnd();
  };
  const render = () => list.replaceChildren(...[...blocks].reverse().map(b => h('div', {
    class: `block-row ${b.code ? 'bad' : 'ok'}`, title: 'Jump to this command',
    onClick: () => b.start.line >= 0 && term.scrollToLine(b.start.line),
  },
  h('span', { class: 'st' }, icon(b.code ? 'x' : 'check', 13)),
  h('code', {}, b.cmd || '(command)'),
  h('span', { class: 'ms' }, b.ms < 1000 ? `${b.ms}ms` : `${(b.ms / 1000).toFixed(1)}s`),
  h('button', { class: 'icon-btn sm', title: 'Copy output', onClick: e => { e.stopPropagation(); copy(output(b)); } }, icon('copy', 12)),
  h('button', { class: 'icon-btn sm', title: 'Put this command back in the prompt (press Enter to run it)', onClick: e => { e.stopPropagation(); p.send(b.cmd); p.term.focus(); } }, icon('refresh', 12)))));

  // Marks only count when they carry this shell's secret; anything else is just text a program printed.
  const nonce = p.session.nonce;
  const signed = data => nonce && data.endsWith(`;${nonce}`);
  term.parser.registerOscHandler(633, data => {
    if (data.startsWith('E;') && signed(data)) commandText = data.slice(2, data.lastIndexOf(';')).replace(/[\x00-\x1f\x7f]/g, '');
    return true;
  });
  term.parser.registerOscHandler(133, data => {
    if (!signed(data)) return true;
    const [kind, code] = data.split(';');
    if (kind === 'A') prompt = term.registerMarker(0);
    if (kind === 'C') open = { cmd: commandText, start: prompt ?? term.registerMarker(0), out: term.registerMarker(0), at: Date.now() };
    if (kind === 'D' && open) {
      const b = Object.assign(open, { end: term.registerMarker(0), code: Number(code) || 0, ms: Date.now() - open.at });
      open = null;
      blocks.push(b);
      const height = Math.max(1, b.end.line - b.start.line);
      term.registerDecoration({ marker: b.start, height, layer: 'bottom' })?.onRender(node => {
        node.classList.add('block-line');
        node.classList.toggle('bad', Boolean(b.code));
      });
      render();
    }
    return true;
  });
}

// ---------- Browser panes ----------
// Saved per project in settings, so they come back after a restart.
const browserList = project => state.settings.browserPanes?.[project] ?? [];
const saveBrowsers = (project, list) => actions.setSetting({ browserPanes: { ...state.settings.browserPanes, [project]: list } });

function newBrowser(url = 'http://localhost:3000') {
  if (!state.project) return toast('Add a project folder first', 'error');
  saveBrowsers(state.project, [...browserList(state.project), { id: `b${Date.now().toString(36)}`, url }]);
}

function syncBrowsers() {
  if (!grid) return;
  for (const b of browserList(state.project)) if (!panes.has(b.id)) browserPane(b, state.project);
  for (const [id, p] of panes) {
    if (p.kind !== 'browser') continue;
    if (!browserList(p.project).some(b => b.id === id)) dispose(id);
    else p.el.classList.toggle('hidden', p.project !== state.project);
  }
  layout();
}

// Turns what you typed into an http(s) URL, or null. Agent Desk's own address is refused: framed with
// allow-same-origin it could reach out of the sandbox and into the app.
function safeUrl(raw) {
  let url = String(raw || '').trim();
  if (/^\d+$/.test(url)) url = `http://localhost:${url}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `${/^(localhost|127\.0\.0\.1)/.test(url) ? 'http' : 'https'}://${url}`;
  try {
    const u = new URL(url);
    const self = u.port === location.port && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return ['http:', 'https:'].includes(u.protocol) && !self ? u.href : null;
  } catch {
    return null;
  }
}

function browserPane(b, project) {
  const frame = h('iframe', { src: safeUrl(b.url) ?? 'about:blank', sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads', allow: 'clipboard-write' });
  const go = raw => {
    const url = safeUrl(raw);
    if (!url) return toast('Browser panes open http and https pages, other than Agent Desk itself.', 'error');
    frame.src = url;
    input.value = url;
    saveBrowsers(project, browserList(project).map(x => (x.id === b.id ? { ...x, url } : x)));
  };
  const input = h('input', { class: 'url-input', value: b.url, spellcheck: false, title: 'Type a URL or just a port, like 3000', onKeydown: e => e.key === 'Enter' && go(input.value) });
  const el = h('div', { class: 'pane', 'data-id': b.id },
    h('div', { class: 'pane-head', onDblclick: e => e.target === e.currentTarget && toggleMaximise(b.id) },
      // The globe is the drag handle here, so dragging in the address bar still selects text.
      h('span', { draggable: true, title: 'Drag to move this pane', style: { cursor: 'grab' }, onDragstart: e => dragPane(e, b.id), onDragend: () => el.classList.remove('dragging') }, avatar({ kind: 'browser' })), input,
      h('button', { class: 'icon-btn', title: 'Reload', onClick: () => { frame.src = frame.src; } }, icon('refresh', 14)),
      h('button', { class: 'icon-btn', title: 'Open in your browser', onClick: () => safeUrl(input.value) && window.open(safeUrl(input.value), '_blank', 'noopener') }, icon('external', 14)),
      h('button', { class: 'icon-btn', title: 'Maximise', onClick: () => toggleMaximise(b.id) }, icon('maximize', 14)),
      h('button', { class: 'icon-btn', title: 'Close', onClick: () => closePane(b.id) }, icon('x', 15))),
    h('div', { class: 'pane-body' }, frame));
  grid.append(el);
  panes.set(b.id, { id: b.id, kind: 'browser', el, project });
}

function removeBrowser(p) {
  saveBrowsers(p.project, browserList(p.project).filter(b => b.id !== p.id));
}
