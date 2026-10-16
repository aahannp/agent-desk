// Link to the Task Notes app on this Mac: bring its open tasks onto the board, and move them along in
// Task Notes as their cards move here. Only tasks you brought over are ever written back, and only
// their status, through Task Notes' own one-task PATCH (never by rewriting its files or whole days).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, changed, bus } from './store.mjs';

const dataDir = () => process.env.TASKNOTES_DATA || path.join(os.homedir(), 'task-notes', 'data');
// Signal 0 only checks the process exists. It fails with EPERM for another user's process, so success
// also means the process is yours.
const yours = pid => { try { return Number.isInteger(pid) && process.kill(pid, 0); } catch { return false; } };

// Task Notes writes its port and pid to port.json when it starts and removes it on quit, and its own MCP
// server finds it the same way. There's no fallback to a fixed port: another account on this Mac could be
// listening there. So port.json must be yours, and so must the process it names.
function base() {
  const file = path.join(dataDir(), 'port.json');
  try {
    if (fs.statSync(file).uid !== process.getuid()) return null;
    const { port, pid } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Number.isInteger(port) && yours(pid) ? `http://127.0.0.1:${port}` : null;
  } catch { return null; }
}

const NOT_RUNNING = 'Task Notes is not running. Open it and try again.';
async function call(method, url, body) {
  const at = base();
  if (!at) throw Object.assign(new Error(NOT_RUNNING), { status: 503 });
  let res;
  try {
    res = await fetch(at + url, {
      method, signal: AbortSignal.timeout(3000),
      headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error(NOT_RUNNING), { status: 503 });
  }
  if (!res.ok) throw Object.assign(new Error(`Task Notes said ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: 502 });
  return res.json();
}

// Task Notes keeps tasks per day, in local time, and copies unfinished ones into each new day.
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Open tasks from the latest day Task Notes has (carrying means that day holds everything still open).
export async function openTasks() {
  const [{ days }, projects] = await Promise.all([call('GET', `/api/alldays?to=${day()}`), call('GET', '/api/projects')]);
  const latest = days.filter(d => d.tasks.length).at(-1);
  if (!latest) return [];
  const title = id => (projects.projects ?? []).find(p => p.id === id)?.title ?? null; // it answers { projects: [...] }
  const linked = new Set(db.tasks.flatMap(t => t.tasknotes ? [t.tasknotes.id] : []));
  return latest.tasks.filter(t => t.status !== 'done').map(t => ({
    id: t.id, date: latest.date, text: t.text, note: t.note || '', status: t.status, priority: t.priority || 'normal',
    project: title(t.projectId), onBoard: linked.has(t.id) || linked.has(t.srcId),
  }));
}

// A carried task gets a new id each day, with srcId pointing at the day before. Follow that forward
// from the copy you brought over to the newest one.
export function newestCopy(days, link) {
  let cur = link;
  for (const d of days) {
    if (d.date <= cur.date) continue;
    const next = d.tasks.find(t => t.srcId === cur.id);
    if (next) cur = { id: next.id, date: d.date };
  }
  return cur;
}

export const STATUS = { todo: 'todo', doing: 'progress', review: 'progress', done: 'done' };

async function push(task) {
  const want = STATUS[task.status];
  const link = task.tasknotes;
  const { days } = await call('GET', `/api/alldays?from=${link.date}&to=${day()}`);
  const copy = newestCopy(days, link);
  await call('PATCH', `/api/tasks?date=${copy.date}&id=${encodeURIComponent(copy.id)}`, { status: want });
  link.synced = want;
}

// Every status change on the board, from you, an agent, a merge or an agent exiting, ends in
// changed('tasks'), so watching that covers them all. A failed push is retried on the next change.
let pushing = null;
let again = false;
function sync() {
  if (pushing) { again = true; return pushing; } // a card moved mid-push: look again when this one ends
  pushing = (async () => {
    for (const task of db.tasks.filter(t => t.tasknotes && STATUS[t.status] !== t.tasknotes.synced)) {
      try { await push(task); changed('tasks'); } catch (e) { console.warn(`Task Notes: couldn't update “${task.title}”: ${e.message}`); }
    }
  })().finally(() => {
    pushing = null;
    if (again) { again = false; sync(); }
  });
  return pushing;
}
let watching = false;
export const watch = () => watching || (watching = Boolean(bus.on('event', e => e.type === 'tasks' && sync())));

// Bring one Task Notes task onto a project's board.
export async function bringOver({ id, date }, project) {
  const found = (await openTasks()).find(t => t.id === id && t.date === date);
  if (!found) throw Object.assign(new Error('That task is no longer open in Task Notes'), { status: 404 });
  if (found.onBoard) throw Object.assign(new Error('That task is already on a board'), { status: 409 });
  return {
    title: found.text, description: found.note, project,
    tasknotes: { id, date, synced: STATUS.todo }, // nothing is written back until the card moves
  };
}
