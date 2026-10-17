// The app shell: navigation, projects, live updates from the server, the command palette and shortcuts.
import { state, api, h, icon, avatar, on, emit, toast, guard, actions, command, commands, menu, modal, askText, confirmDialog, ago, baseName, ltr, projectSessions, projectTasks, projectChats, chatTitle, DRAG, STATUS_LABEL } from './ui.js';
import { THEMES, applyTheme } from './themes.js';
import * as agents from './agents.js';
import * as board from './board.js';
import * as files from './files.js';
import * as review from './review.js';
import * as graph from './graph.js';
import * as artifacts from './artifacts.js';
import * as shots from './shots.js';
import * as spend from './spend.js';
import * as settings from './settings.js';
import './voice.js';
import './cursor.js';
import './updates.js';

if (navigator.userAgent.includes('Electron')) document.documentElement.classList.add('is-app');

const VIEWS = [
  { id: 'agents', label: 'Agents', icon: 'terminal', module: agents, hint: 'Every agent and shell, side by side' },
  { id: 'board', label: 'Board', icon: 'board', module: board, hint: 'Plan tasks and hand them to agents' },
  { id: 'files', label: 'Files', icon: 'file', module: files, hint: 'Browse and edit the project' },
  { id: 'review', label: 'Review', icon: 'branch', module: review, hint: 'Check what agents changed, then merge it' },
  { id: 'artifacts', label: 'Artifacts', icon: 'layers', module: artifacts, hint: 'Pages and reports your agents made' },
  { id: 'shots', label: 'Screenshots', icon: 'camera', module: shots, hint: 'Capture, mark up and hand to an agent' },
  { id: 'graph', label: 'Graph', icon: 'graph', module: graph, hint: 'Who is doing what, and who is talking to whom' },
  { id: 'spend', label: 'Spend', icon: 'dollar', module: spend, hint: 'What Claude Code cost each day, and where it went' },
  { id: 'settings', label: 'Settings', icon: 'settings', module: settings, hint: 'Themes, agents, voice and MCP' },
];
const $ = id => document.getElementById(id);
let current = '';
let live = false; // is the event stream from the server connected

// ---------- Live data ----------
const loaders = {
  sessions: async () => { state.sessions = await api('GET', '/api/sessions'); },
  tasks: async () => { state.tasks = await api('GET', '/api/tasks'); },
  projects: async () => { state.projects = await api('GET', '/api/projects'); },
  settings: async () => { state.settings = await api('GET', '/api/settings'); },
  chats: async () => { state.chats = await api('GET', '/api/chats'); },
  artifacts: async () => { [state.artifacts, state.artifactFolders] = await Promise.all([api('GET', '/api/artifacts'), api('GET', '/api/artifact-folders')]); },
  specialists: async () => { state.specialists = await api('GET', '/api/specialists'); },
};

// Refetch one kind of data. If more changes arrive mid-fetch, fetch once more so nothing stale sticks.
const inflight = new Map();
function refresh(kind) {
  const running = inflight.get(kind);
  if (running) {
    running.again = true;
    return running.promise;
  }
  const entry = { again: false };
  entry.promise = (async () => {
    do {
      entry.again = false;
      await loaders[kind]();
    } while (entry.again);
    inflight.delete(kind);
    loaded(kind);
  })().catch(e => {
    inflight.delete(kind);
    console.error(e);
  });
  inflight.set(kind, entry);
  return entry.promise;
}
actions.refresh = refresh;

function loaded(kind) {
  if (kind === 'settings' || kind === 'projects') {
    const before = state.project;
    state.project = state.settings.lastProject || state.projects[0]?.path || '';
    if (kind === 'settings') applyTheme();
    if (before !== state.project) emit('project');
  }
  emit(kind);
  renderChrome();
  if (!state.projects.length) showWelcome();
}

function listen() {
  const events = new EventSource('/api/events');
  events.onmessage = e => {
    const event = JSON.parse(e.data);
    if (['voice', 'update-progress', 'agent-message', 'specialist-changed', 'groups'].includes(event.type)) emit(event.type, event);
    else if (loaders[event.type]) refresh(event.type);
  };
  events.onopen = () => {
    live = true;
    Object.keys(loaders).forEach(refresh); // after a reconnect, catch up on everything
  };
  events.onerror = () => { live = false; renderStatus(); };
}

actions.setSetting = guard(async patch => {
  state.settings = await api('PATCH', '/api/settings', patch);
  loaded('settings');
});

// ---------- Views ----------
function showView(id) {
  const view = VIEWS.find(v => v.id === id) || VIEWS[0];
  if (current !== view.id) VIEWS.find(v => v.id === current)?.module.hide?.();
  current = view.id;
  for (const v of VIEWS) {
    $(`view-${v.id}`).classList.toggle('active', v.id === view.id);
    $(`nav-${v.id}`).classList.toggle('active', v.id === view.id);
  }
  $('viewIcon').replaceChildren(icon(view.icon, 16));
  $('viewTitle').textContent = view.label;
  $('viewHint').textContent = view.hint;
  renderToolbar();
  view.module.show?.();
}
actions.showView = showView;
actions.currentView = () => current;

function renderToolbar() {
  const view = VIEWS.find(v => v.id === current);
  $('viewActions').replaceChildren(...(view?.module.toolbar?.() ?? []));
}
actions.renderToolbar = renderToolbar;

// Hiding the sidebar gives the panes the whole window. ⌘B, the button in the top bar, or Settings.
function applySidebar() {
  const hidden = state.settings.sidebarHidden === true;
  document.querySelector('.app').classList.toggle('no-side', hidden);
  $('sideToggle').replaceChildren(icon('sidebar', 16));
  $('sideToggle').title = `${hidden ? 'Show' : 'Hide'} the sidebar (⌘B)`;
}
const toggleSidebar = () => actions.setSetting({ sidebarHidden: state.settings.sidebarHidden !== true });
actions.toggleSidebar = toggleSidebar;
on('settings', applySidebar);
on('settings', renderToolbar);
on('project', renderToolbar);

// ---------- Sidebar ----------
function renderChrome() {
  const project = state.projects.find(p => p.path === state.project);
  $('projectSwitch').querySelector('.project-name').textContent = project?.name ?? 'No project';
  $('projectSwitch').querySelector('.project-avatar').textContent = (project?.name ?? 'A').replace(/[^a-z0-9]/gi, '').slice(0, 1).toUpperCase() || 'A';
  $('projectSwitch').querySelector('.project-path').textContent = project ? ltr(project.path.replace(state.info.home, '~')) : 'Add a folder to start';
  document.title = project ? `${project.name} · Agent Desk` : 'Agent Desk';

  const sessions = projectSessions();
  const live = sessions.filter(s => !s.exited);
  const waiting = sessions.filter(s => s.status === 'needs-input').length;
  const counts = {
    agents: waiting ? h('span', { class: 'count attn', title: 'Waiting for you' }, waiting) : live.length ? h('span', { class: 'count' }, live.length) : null,
    board: (() => { const n = projectTasks().filter(t => t.status !== 'done').length; return n ? h('span', { class: 'count' }, n) : null; })(),
    review: (() => { const n = projectTasks().filter(t => t.status === 'review').length; return n ? h('span', { class: 'count attn' }, n) : null; })(),
  };
  for (const v of VIEWS) {
    const btn = $(`nav-${v.id}`);
    btn.querySelector('.count')?.remove();
    if (counts[v.id]) btn.append(counts[v.id]);
  }

  renderChats(sessions);
  renderStatus();
}

// Sidebar chats: what's open now, then earlier chats you can click or drag into the grid to pick up again.
let sidebarDrag = false; // rebuilding the list mid-drag would detach the dragged button and lose its dragend

function renderChats(unordered) {
  if (sidebarDrag) return;
  const order = actions.paneOrder?.() ?? [];
  const sessions = [...unordered].sort((a, b) => (order.indexOf(a.id) + 1 || Infinity) - (order.indexOf(b.id) + 1 || Infinity));
  const openIds = new Set(sessions.map(s => s.chatId).filter(Boolean));
  const recent = projectChats().filter(c => !openIds.has(c.id)).slice(0, 40);
  const drag = (type, id) => e => {
    e.dataTransfer.setData(type, id);
    e.dataTransfer.effectAllowed = 'move';
    sidebarDrag = true;
    e.currentTarget.addEventListener('dragend', () => { sidebarDrag = false; renderChrome(); }, { once: true });
  };
  const open = sessions.map(s => h('button', {
    class: 'run-item', title: s.cwd, draggable: true, onDragstart: drag(DRAG.pane, s.id),
    onClick: () => actions.focusSession(s.id),
    onContextmenu: e => s.chatId && chatMenu(e, state.chats.find(c => c.id === s.chatId)),
  }, avatar(s, true), h('span', { class: 'name' }, chatTitle(s)), h('span', { class: `dot ${actions.statusOf?.(s) ?? s.status}` })));
  const earlier = recent.map(c => h('button', {
    class: `run-item chat${c.folderMissing ? ' gone' : ''}`, draggable: !c.folderMissing, onDragstart: drag(DRAG.chat, c.id),
    title: c.folderMissing ? `Its folder is gone: ${c.cwd}` : `Click or drag into the grid to ${c.resumable ? 'pick this chat up again' : 'start it again'}`,
    onClick: () => !c.folderMissing && actions.openChat(c.id),
    onContextmenu: e => chatMenu(e, c),
  }, avatar(c, true), h('span', { class: 'name' }, c.title), h('span', { class: 'when' }, ago(c.lastActiveAt).replace(' ago', ''))));
  $('running').replaceChildren(
    ...(open.length ? open : [h('div', { class: 'run-empty' }, 'Nothing open')]),
    ...(earlier.length ? [h('div', { class: 'side-label sub' }, 'Recent'), ...earlier] : []));
}

function chatMenu(e, chat) {
  if (!chat) return;
  e.preventDefault();
  menu(e.currentTarget, [
    { label: chat.running ? 'Show' : 'Open', icon: 'play', disabled: chat.folderMissing, onClick: () => actions.openChat(chat.id) },
    { label: 'Rename…', icon: 'pen', onClick: guard(async () => {
      const title = await askText('Rename chat', { value: chat.title, ok: 'Rename', label: 'Leave it empty to use Claude\'s own title' });
      if (title !== null) await api('PATCH', `/api/chats/${encodeURIComponent(chat.id)}`, { title });
    }) },
    'sep',
    { label: 'Remove from the list', icon: 'trash', onClick: guard(async () => {
      if (chat.running && !(await confirmDialog(`Stop and remove "${chat.title}"?`, 'The agent is still running. This stops it and takes the chat off the list.', { label: 'Stop and remove', danger: true }))) return;
      await api('DELETE', `/api/chats/${encodeURIComponent(chat.id)}`);
      toast('Removed. Claude\'s own copy of the conversation is untouched.', 'ok');
    }) },
  ]);
}

// The thin bar along the bottom: connection, what's running, and the guardrails in force.
const PERMISSION_NAMES = { default: 'Ask me', acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan only' };
function renderStatus() {
  const sessions = projectSessions();
  const running = sessions.filter(s => !s.exited);
  const waiting = sessions.filter(s => s.status === 'needs-input');
  const busy = running.filter(s => actions.statusOf?.(s) === 'working');
  $('statusBar').replaceChildren(...[
    h('span', {}, h('i', { class: `live-dot${live ? '' : ' off'}` }), live ? 'Live' : 'Reconnecting…'),
    h('span', {}, icon('terminal', 12), `${running.length} running`),
    busy.length > 0 && h('span', {}, icon('zap', 12), `${busy.length} ${STATUS_LABEL.working.toLowerCase()}`),
    waiting.length > 0 && h('span', { class: 'warn' }, icon('alert', 12), `${waiting.length} waiting for you`),
    h('span', {}, icon('board', 12), `${projectTasks().filter(t => t.status === 'doing').length} in progress`),
    h('span', { class: 'grow' }),
    h('span', { title: 'What Claude agents may do without asking' }, icon('shield', 12), PERMISSION_NAMES[state.settings.permissionMode] ?? 'Ask me'),
    h('span', {}, icon('sparkles', 12), state.theme?.name ?? ''),
    h('span', {}, h('kbd', {}, '⌘K'), 'commands'),
  ].filter(Boolean));
}
on('tick', renderChrome);

function buildSidebar() {
  $('nav').replaceChildren(...VIEWS.map((v, i) => h('button', { class: 'nav-item', id: `nav-${v.id}`, title: `${v.label} (⌘${i + 1})`, onClick: () => showView(v.id) },
    icon(v.icon), h('span', {}, v.label))));
  $('projectSwitch').querySelector('.chev').replaceWith(icon('chevron', 14));
  $('projectSwitch').onclick = e => menu(e.currentTarget, [
    { heading: 'Projects' },
    ...state.projects.map(p => ({ label: p.name, sub: p.path.replace(state.info.home, '~'), icon: p.path === state.project ? 'check' : 'folder', onClick: () => switchProject(p.path) })),
    'sep',
    { label: 'Add a project folder…', icon: 'plus', onClick: addProject },
    ...(state.project ? [{ label: 'Remove this project from the list', icon: 'x', onClick: removeProject }] : []),
  ]);
  const voice = $('voiceBtn');
  voice.querySelector('.mic').replaceWith(icon('mic', 15));
  voice.onclick = () => actions.toggleVoice();
  const palette = $('paletteBtn');
  palette.querySelector('.search').replaceWith(icon('search', 15));
  palette.onclick = openPalette;
}

// ---------- Projects ----------
const switchProject = path => actions.setSetting({ lastProject: path });
actions.switchProject = switchProject;

// A folder input that suggests folders as you type.
function folderField(onSubmit) {
  const input = h('input', { class: 'input mono', placeholder: '~/code/my-app', spellcheck: false, value: '~/' });
  const list = h('div', { class: 'suggest' });
  const suggest = async () => {
    const found = await api('GET', `/api/fs/suggest?prefix=${encodeURIComponent(input.value)}`).catch(() => []);
    list.replaceChildren(...found.slice(0, 12).map(p => h('button', { onClick: () => { input.value = `${p}/`; input.focus(); suggest(); } }, baseName(p))));
  };
  input.addEventListener('input', suggest);
  input.addEventListener('keydown', e => e.key === 'Enter' && onSubmit(input.value));
  setTimeout(suggest);
  return { input, el: h('div', {}, input, list) };
}

const openProject = guard(async path => {
  await api('POST', '/api/projects', { path: path.replace(/\/+$/, '') || path });
  await Promise.all([refresh('projects'), refresh('settings')]);
  document.querySelector('.welcome')?.remove();
  toast(`Opened ${baseName(state.project)}`, 'ok');
  return true;
});
actions.openProject = openProject;

function addProject() {
  let close;
  const field = folderField(async value => (await openProject(value)) && close());
  close = modal({
    title: 'Add a project folder', width: 520,
    body: [h('p', { class: 'muted' }, 'Agents start in this folder. A git repository lets each agent work in its own worktree.'), field.el],
    actions: [{ label: 'Cancel' }, { label: 'Add project', primary: true, onClick: async () => Boolean(await openProject(field.input.value)) }],
  });
}

const removeProject = guard(async () => {
  await api('DELETE', `/api/projects?path=${encodeURIComponent(state.project)}`);
  toast('Removed from the list. No files were touched.', 'ok');
});

function showWelcome() {
  if (document.querySelector('.welcome')) return;
  const field = folderField(openProject);
  const feature = (name, text) => h('span', {}, icon(name, 14), text);
  document.body.append(h('div', { class: 'welcome' }, h('div', { class: 'welcome-card' },
    document.querySelector('.logo').cloneNode(true),
    h('h1', {}, 'Run a team of ', h('em', {}, 'coding agents'), '.'),
    h('p', {}, 'Agent Desk runs Claude Code and other coding agents side by side, each in a real terminal using your own login. Pick the project folder to start.'),
    field.el,
    h('div', { class: 'row', style: { marginTop: '16px' } }, h('button', { class: 'btn primary', onClick: () => openProject(field.input.value) }, icon('folder', 15), 'Open folder')),
    h('div', { class: 'features' },
      feature('terminal', 'Up to 16 agents at once'), feature('star', 'A lead agent that splits the work'),
      feature('board', 'Task board agents update'), feature('branch', 'Worktrees, diffs and merge'),
      feature('mic', 'Voice input'), feature('camera', 'Screenshots for agents')))));
  setTimeout(() => field.input.focus());
}

// ---------- Command palette ----------
function openPalette() {
  if (document.querySelector('.palette')) return;
  const input = h('input', { placeholder: 'Search commands, agents, themes and projects…', spellcheck: false });
  const list = h('div', { class: 'list' });
  let items = [];
  let selected = 0;
  const all = () => [
    ...commands,
    ...VIEWS.map((v, i) => ({ title: `Go to ${v.label}`, icon: v.icon, sub: `⌘${i + 1}`, run: () => showView(v.id) })),
    ...projectSessions().map(s => ({ title: `Show ${s.name}`, icon: 'terminal', sub: s.agent || s.kind, run: () => actions.focusSession(s.id) })),
    ...state.projects.filter(p => p.path !== state.project).map(p => ({ title: `Switch to ${p.name}`, icon: 'folder', sub: p.path.replace(state.info.home, '~'), run: () => switchProject(p.path) })),
    ...Object.entries(THEMES).map(([id, t]) => ({ title: `Theme: ${t.name}`, icon: 'sparkles', run: () => actions.setSetting({ theme: id }) })),
  ];
  const select = i => {
    list.children[selected]?.classList.remove('sel');
    selected = i;
    list.children[selected]?.classList.add('sel');
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  };
  const render = () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    items = all().filter(c => words.every(w => `${c.title} ${c.sub || ''}`.toLowerCase().includes(w))).slice(0, 80);
    list.replaceChildren(...(items.length ? items.map((c, i) => h('button', { class: 'menu-item', onMousemove: () => selected !== i && select(i), onClick: () => run(c) },
      icon(c.icon || 'chevronRight', 15), h('span', {}, c.title), c.sub && h('span', { class: 'sub' }, c.sub))) : [h('div', { class: 'empty' }, 'Nothing matches')]));
    select(0);
  };
  const close = () => overlay.remove();
  const run = c => { close(); c.run(); };
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(selected + 1, items.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(selected - 1, 0)); }
    if (e.key === 'Enter' && items[selected]) run(items[selected]);
    if (e.key === 'Escape') close();
  });
  const overlay = h('div', { class: 'overlay', onMousedown: e => e.target === overlay && close() }, h('div', { class: 'modal palette' },
    h('div', { class: 'pal-input' }, icon('search', 18), input, h('kbd', {}, 'esc')), list,
    h('div', { class: 'pal-foot' }, h('span', {}, h('kbd', {}, '↑'), h('kbd', {}, '↓'), 'move'), h('span', {}, h('kbd', {}, '↵'), 'run'), h('span', { class: 'grow' }), h('span', {}, 'Agent Desk'))));
  document.body.append(overlay);
  render();
  input.focus();
}
actions.openPalette = openPalette;

document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && !e.shiftKey && key === 'k') { e.preventDefault(); e.stopPropagation(); openPalette(); }
  else if (mod && e.shiftKey && key === 'm') { e.preventDefault(); e.stopPropagation(); actions.toggleVoice(); }
  else if (mod && !e.shiftKey && !e.altKey && key === 'b') { e.preventDefault(); e.stopPropagation(); toggleSidebar(); }
  else if (mod && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); showView(VIEWS[Number(e.key) - 1].id); }
}, true);

command('New task', () => { showView('board'); actions.newTask?.(); }, { icon: 'plus' });
command('Show or hide the sidebar', () => toggleSidebar(), { icon: 'sidebar', sub: '⌘B' });
$('sideToggle').addEventListener('click', () => toggleSidebar());
command('Add a project folder', addProject, { icon: 'folder' });

// ---------- Start ----------
(async () => {
  applyTheme();
  [state.info, state.agents] = await Promise.all([api('GET', '/api/info'), api('GET', '/api/agents')]);
  await Promise.all(Object.values(loaders).map(load => load()));
  state.project = state.settings.lastProject || state.projects[0]?.path || '';
  applyTheme();

  const views = $('views');
  for (const v of VIEWS) {
    const section = h('section', { class: 'view', id: `view-${v.id}` });
    views.append(section);
    v.module.mount(section);
  }
  buildSidebar();
  showView('agents');
  for (const kind of ['project', 'settings', 'projects', 'tasks', 'sessions', 'chats', 'artifacts', 'specialists']) emit(kind);
  renderChrome();
  listen();
  setInterval(() => refresh('sessions'), 4000); // keeps "working / idle" fresh for the board and agents
  setInterval(() => refresh('chats'), 15000); // picks up the titles Claude gives chats as they go
  if (!state.projects.length) showWelcome();
})().catch(e => toast(`Agent Desk could not start: ${e.message}`, 'error'));
