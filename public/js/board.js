// Board view: tasks in four columns. Drag cards between columns; Run hands a task to an agent.
import { state, api, h, icon, on, toast, guard, actions, modal, confirmDialog, command, agentLabel, shortBranch, projectTasks, ago } from './ui.js';

const COLUMNS = [
  { id: 'todo', label: 'To do', color: 'var(--dim)', empty: 'Add a task above, or ask a lead agent to plan one.' },
  { id: 'doing', label: 'In progress', color: 'var(--info)', empty: 'Press Run on a task and an agent picks it up.' },
  { id: 'review', label: 'Review', color: 'var(--warn)', empty: 'Finished work waits here for you to check.' },
  { id: 'done', label: 'Done', color: 'var(--ok)', empty: 'Merged and finished tasks.' },
];
let root;
let boardEl;
let drawer = null;
let openId = null;
let dragId = null;

// The quick-add box survives re-renders, so an agent updating the board never eats what you're typing.
const quick = h('input', { placeholder: 'Add a task and press Enter…', onKeydown: e => e.key === 'Enter' && quickAdd() });

export function mount(el) {
  root = el;
  boardEl = h('div', { class: 'board' });
  root.append(boardEl);
  on('tasks', render);
  on('project', () => { closeDrawer(); render(); });
  on('sessions', refreshDots);
  document.addEventListener('keydown', e => e.key === 'Escape' && drawer && !document.querySelector('.overlay') && closeDrawer());
}

export const toolbar = () => [
  h('button', { class: 'btn', onClick: () => fromTaskNotes(), title: 'Bring tasks over from the Task Notes app' }, icon('clipboard', 15), 'Task Notes'),
  h('button', { class: 'btn primary', onClick: () => newTask() }, icon('plus', 15), 'New task')];
export const show = () => render();

function render() {
  if (!boardEl) return;
  const tasks = projectTasks();
  const typing = document.activeElement === quick; // moving the box drops focus, so give it back
  boardEl.replaceChildren(...COLUMNS.map(col => column(col, tasks.filter(t => t.status === col.id))));
  if (typing) quick.focus();
  if (openId) renderDrawer();
}

function refreshDots() {
  for (const dot of boardEl?.querySelectorAll('.card .dot') ?? []) {
    const s = state.sessions.find(x => x.id === dot.dataset.session);
    if (s) dot.className = `dot ${actions.statusOf(s)}`;
  }
  if (drawer) renderActivity();
}

function column(col, tasks) {
  const body = h('div', { class: 'col-body' }, tasks.length ? tasks.map(card) : h('div', { class: 'col-empty' }, col.empty));
  const el = h('div', {
    class: 'col',
    onDragover: e => {
      if (!dragId) return;
      e.preventDefault();
      el.classList.add('drop');
      markDrop(body, e.clientY);
    },
    onDragleave: e => {
      if (el.contains(e.relatedTarget)) return;
      el.classList.remove('drop');
      clearDrop();
    },
    onDrop: e => {
      e.preventDefault();
      el.classList.remove('drop');
      const before = body.querySelector('.drop-before')?.dataset.id ?? '';
      clearDrop();
      if (dragId && before !== dragId) move(dragId, col.id, before);
    },
  },
  h('div', { class: 'col-head' },
    h('span', { class: 'swatch', style: { background: col.color } }), h('h3', {}, col.label), h('span', { class: 'n' }, tasks.length),
    h('span', { class: 'grow' }),
    col.id === 'todo' && h('button', { class: 'icon-btn', title: 'New task with details', onClick: () => newTask() }, icon('plus', 15))),
  col.id === 'todo' && h('div', { class: 'quick-add' }, quick),
  body);
  return el;
}

function markDrop(body, y) {
  clearDrop();
  const target = [...body.querySelectorAll('.card:not(.dragging)')].find(c => {
    const r = c.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  target?.classList.add('drop-before');
}
const clearDrop = () => document.querySelectorAll('.drop-before').forEach(c => c.classList.remove('drop-before'));

function card(t) {
  const s = t.sessionId && state.sessions.find(x => x.id === t.sessionId);
  return h('div', {
    class: `card${openId === t.id ? ' selected' : ''}`, draggable: true, 'data-id': t.id,
    onDragstart: e => {
      dragId = t.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', t.id);
      e.currentTarget.classList.add('dragging');
    },
    onDragend: e => {
      dragId = null;
      e.currentTarget.classList.remove('dragging');
      clearDrop();
    },
    onClick: () => openTask(t.id),
  },
  h('div', { class: 'card-title' }, t.title),
  t.description && h('div', { class: 'card-desc' }, t.description),
  h('div', { class: 'card-foot' },
    s && h('span', { class: `dot ${actions.statusOf(s)}`, 'data-session': s.id, title: s.exited ? 'Agent finished' : 'Agent running' }),
    h('span', { class: `badge ${t.agent}` }, agentLabel(t.agent)),
    t.branch && h('span', { class: 'chip mono' }, icon('branch', 11), shortBranch(t.branch)),
    t.notes.length > 0 && h('span', { class: 'chip', title: 'Comments' }, icon('message', 11), t.notes.length),
    t.tasknotes && h('span', { class: 'chip', title: 'From Task Notes. Its status there follows this card.' }, icon('clipboard', 11), 'Task Notes'),
    h('span', { class: 'grow' }),
    t.status === 'todo' && h('button', { class: 'btn xs primary', onClick: e => { e.stopPropagation(); run(t); } }, icon('play', 10), 'Run'),
    t.status === 'review' && t.worktreePath && h('button', { class: 'btn xs', onClick: e => { e.stopPropagation(); actions.reviewWorktree(t.worktreePath); } }, icon('branch', 11), 'Review')));
}

// ---------- Changing tasks ----------
const move = guard(async (id, status, before) => {
  await api('PATCH', `/api/tasks/${id}`, { status, before });
});
const patch = guard(async (t, changes) => {
  await api('PATCH', `/api/tasks/${t.id}`, changes);
});

const run = guard(async t => {
  const { session } = await api('POST', `/api/tasks/${t.id}/start`, {});
  await actions.refresh('sessions');
  toast(`An agent is on “${t.title}”`, 'ok', { label: 'Show', onClick: () => actions.focusSession(session.id) });
});

const quickAdd = guard(async () => {
  const title = quick.value.trim();
  if (!title) return;
  if (!state.project) throw new Error('Add a project folder first');
  await api('POST', '/api/tasks', { project: state.project, title });
  quick.value = '';
});

function newTask() {
  if (!state.project) return toast('Add a project folder first', 'error');
  const title = h('input', { class: 'input', placeholder: 'Short title, like “Add a dark mode toggle”' });
  const description = h('textarea', { class: 'input', rows: 6, placeholder: 'Details for the agent: the goal, the files involved, how to check it works' });
  const agent = agentSelect(state.settings.defaultAgent);
  const worktree = h('input', { type: 'checkbox', checked: state.settings.worktreeByDefault });
  const create = async start => {
    if (!title.value.trim()) { toast('Give the task a title', 'error'); return false; }
    try {
      const t = await api('POST', '/api/tasks', { project: state.project, title: title.value, description: description.value, agent: agent.value, worktree: worktree.checked });
      if (start) await run(t);
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
  };
  modal({
    title: 'New task', width: 560,
    body: [
      h('label', { class: 'field' }, h('span', {}, 'Title'), title),
      h('label', { class: 'field' }, h('span', {}, 'Description'), description),
      h('div', { class: 'row', style: { marginBottom: '8px' } },
        h('label', { class: 'field', style: { flex: 1, margin: 0 } }, h('span', {}, 'Agent'), agent),
        h('label', { class: 'toggle', style: { marginTop: '18px' } }, worktree, 'Own git worktree')),
    ],
    actions: [{ label: 'Cancel' }, { label: 'Create', onClick: () => create(false) }, { label: 'Create and run', primary: true, onClick: () => create(true) }],
  });
}
actions.newTask = newTask;

// Task Notes: its open tasks, newest day first; Add puts one on this project's board.
async function fromTaskNotes() {
  if (!state.project) return toast('Add a project folder first', 'error');
  const list = h('div', { class: 'tn-list' }, h('p', { class: 'muted' }, 'Looking in Task Notes…'));
  modal({ title: 'From Task Notes', width: 600, body: [
    h('p', { class: 'muted' }, 'Add a task to this board to hand it to an agent. Task Notes follows the card: In progress and Review show as in progress there, and Done marks it done.'),
    list] });
  const add = guard(async (t, btn) => {
    btn.disabled = true;
    await api('POST', '/api/tasknotes/import', { id: t.id, date: t.date, project: state.project }).catch(e => { btn.disabled = false; throw e; });
    btn.replaceChildren(icon('check', 12), 'Added');
  });
  try {
    const tasks = await api('GET', '/api/tasknotes');
    list.replaceChildren(...(tasks.length ? tasks.map(t => h('div', { class: 'tn-row' },
      h('div', { class: 'tn-text' }, h('div', {}, t.text), t.note && h('div', { class: 'muted' }, t.note)),
      t.project && h('span', { class: 'chip' }, t.project),
      t.priority === 'high' && h('span', { class: 'chip' }, 'High'),
      t.status !== 'todo' && h('span', { class: 'chip' }, { progress: 'In progress', blocked: 'Blocked' }[t.status] ?? t.status),
      t.onBoard ? h('span', { class: 'muted' }, 'On a board')
        : h('button', { class: 'btn xs primary', onClick: e => add(t, e.currentTarget) }, icon('plus', 11), 'Add'))) : [h('p', { class: 'muted' }, 'No open tasks in Task Notes.')]));
  } catch (e) {
    list.replaceChildren(h('p', { class: 'muted' }, e.message));
  }
}
actions.fromTaskNotes = fromTaskNotes;
command('Bring a task over from Task Notes', () => fromTaskNotes(), { icon: 'clipboard' });

const agentSelect = value => h('select', { class: 'input' },
  state.agents.map(a => h('option', { value: a.id, selected: a.id === value, disabled: !a.installed }, a.installed ? a.label : `${a.label} (not installed)`)));

// ---------- Task drawer ----------
function openTask(id) {
  openId = id;
  actions.showView('board');
  render();
}
actions.openTask = openTask;

function closeDrawer() {
  drawer?.remove();
  drawer = null;
  openId = null;
  boardEl?.querySelectorAll('.card.selected').forEach(c => c.classList.remove('selected'));
}

function renderDrawer() {
  const t = state.tasks.find(x => x.id === openId);
  if (!t) return closeDrawer();
  // While you're typing in the drawer, only refresh the status and the activity list, not what you're typing.
  const typing = document.activeElement?.matches('input:not([type=checkbox]), textarea');
  if (drawer?.dataset.id === t.id && drawer.contains(document.activeElement) && typing) {
    drawer.querySelector('.drawer-head select').value = t.status;
    return renderActivity();
  }
  drawer?.remove();
  const s = t.sessionId && state.sessions.find(x => x.id === t.sessionId);
  const running = s && !s.exited;

  const title = h('input', { class: 'title-edit', value: t.title, onChange: () => title.value.trim() && patch(t, { title: title.value.trim() }) });
  const description = h('textarea', { class: 'input', rows: 7, value: t.description, placeholder: 'Details for the agent: the goal, the files involved, how to check it works', onChange: () => patch(t, { description: description.value }) });
  const status = h('select', { class: 'input', style: { width: 'auto' }, onChange: () => patch(t, { status: status.value }) },
    COLUMNS.map(c => h('option', { value: c.id, selected: c.id === t.status }, c.label)));
  const agent = agentSelect(t.agent);
  agent.addEventListener('change', () => patch(t, { agent: agent.value }));
  const worktree = h('input', { type: 'checkbox', checked: t.worktree, onChange: () => patch(t, { worktree: worktree.checked }) });
  const comment = h('input', { class: 'input', placeholder: 'Add a comment and press Enter', onKeydown: guard(async e => {
    if (e.key !== 'Enter' || !comment.value.trim()) return;
    await api('POST', `/api/tasks/${t.id}/comments`, { text: comment.value });
    comment.value = '';
  }) });

  drawer = h('div', { class: 'drawer', 'data-id': t.id },
    h('div', { class: 'drawer-head' }, status, h('span', { class: 'muted', style: { fontSize: '12px' } }, `Created by ${t.createdBy} · ${ago(t.createdAt)}`),
      h('span', { class: 'grow' }), h('button', { class: 'icon-btn', title: 'Close', onClick: closeDrawer }, icon('x'))),
    h('div', { class: 'drawer-body' },
      title,
      h('div', { class: 'actions-row' },
        !running && h('button', { class: 'btn primary sm', onClick: () => run(t) }, icon('play', 12), t.sessionId ? 'Run again' : 'Run with an agent'),
        running && h('button', { class: 'btn sm', onClick: () => actions.focusSession(s.id) }, icon('terminal', 13), 'Show terminal'),
        t.worktreePath && h('button', { class: 'btn sm', onClick: () => actions.reviewWorktree(t.worktreePath) }, icon('branch', 13), 'Review changes'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm danger', onClick: guard(async () => {
          if (!(await confirmDialog('Delete this task?', `“${t.title}” and its comments will be removed from the board.`, { label: 'Delete', danger: true }))) return;
          await api('DELETE', `/api/tasks/${t.id}`);
          closeDrawer();
        }) }, icon('trash', 13), 'Delete')),
      h('label', { class: 'field' }, h('span', {}, 'Description'), description),
      h('div', { class: 'row', style: { marginBottom: '18px' } },
        h('label', { class: 'field', style: { flex: 1, margin: 0 } }, h('span', {}, 'Agent'), agent),
        h('label', { class: 'toggle', style: { marginTop: '18px' } }, worktree, 'Own git worktree')),
      t.branch && h('p', { class: 'muted', style: { margin: '0 0 18px' } }, icon('branch', 12), ' ', h('code', {}, t.branch)),
      h('div', { class: 'section-label' }, 'Activity'),
      h('div', { class: 'activity' }),
      h('div', { style: { marginTop: '12px' } }, comment)));
  root.append(drawer);
  renderActivity();
  boardEl.querySelectorAll('.card').forEach(c => c.classList.toggle('selected', c.dataset.id === t.id));
}

function renderActivity() {
  const t = state.tasks.find(x => x.id === openId);
  const list = drawer?.querySelector('.activity');
  if (!t || !list) return;
  list.replaceChildren(...(t.notes.length ? t.notes.map(n => h('div', { class: 'note' },
    h('div', { class: 'who' }, h('b', {}, n.by), ` · ${ago(n.at)}`), h('div', { class: 'what' }, n.text)))
    : [h('div', { class: 'muted' }, 'No comments yet. Agents post their progress and summaries here.')]));
}
