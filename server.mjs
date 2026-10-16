// Agent Desk server: serves the app, runs agent sessions, and exposes the API used by the page and by agents.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';
import { db, load, changed, bus } from './lib/store.mjs';
import * as S from './lib/sessions.mjs';
import * as G from './lib/git.mjs';
import { mcpTools, handleMcp } from './lib/mcp.mjs';

const DIR = import.meta.dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
};
const VENDOR = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
};
const STATUSES = ['todo', 'doing', 'review', 'done'];
const PERMISSION_MODES = ['default', 'acceptEdits', 'auto', 'plan'];
const SKIP_IN_TREE = new Set(['.git', 'node_modules', '.DS_Store', '.agent-desk']);

let TOKEN = '';
let COOKIE = '';
let LOCAL = new Set();
let VOICE_HELPER = null;
let voice = null;

// ---------- Security ----------
// Every request passes two checks.
// 1. Host and Origin must be this server. Any website you visit can try to reach localhost, and this
//    server hands out shells. Checking Host also stops DNS rebinding.
// 2. It carries this run's secret: a cookie for the page, a header for agents' MCP servers. Other
//    programs and other users on this Mac can reach the port too.
function sameSite(req) {
  if (!LOCAL.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || LOCAL.has(origin.replace(/^https?:\/\//, ''));
}

function hasToken(req, url) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')));
  const given = Buffer.from(String(req.headers['x-desk-token'] || cookies[COOKIE] || url.searchParams.get('t') || ''));
  const want = Buffer.from(TOKEN);
  return want.length >= 32 && given.length === want.length && timingSafeEqual(given, want);
}

// ---------- Helpers ----------
const fail = (status, message) => Object.assign(new Error(message), { status });
const expand = p => path.resolve(String(p || '').trim().replace(/^~(?=$|\/)/, os.homedir()));
const isDir = p => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
const findTask = id => db.tasks.find(t => t.id === id) ?? (() => { throw fail(404, 'No such task'); })();
const findSession = id => S.sessions.get(id) ?? (() => { throw fail(404, 'No such session'); })();
const caller = req => S.sessions.get(req.headers['x-desk-session']);
const projectFor = (req, value) => {
  const project = value ? expand(value) : caller(req)?.project || db.settings.lastProject;
  if (!project) throw fail(400, 'No project selected');
  return project;
};

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(fail(413, 'Request is too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(fail(400, 'Request body is not JSON')); }
    });
  });
}

function writeAtomic(file, content) {
  fs.writeFileSync(`${file}.desk-tmp`, content);
  fs.renameSync(`${file}.desk-tmp`, file);
}

// ---------- Routes ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, key) => (keys.push(key), '([^/]+)'))}$`);
  routes.push({ method, re, keys, handler });
}

route('GET', '/api/info', () => ({
  url: S.serverUrl(), token: TOKEN, mcpUrl: `${S.serverUrl()}/mcp`,
  electron: Boolean(process.versions.electron), voice: Boolean(VOICE_HELPER), home: os.homedir(),
}));

// Projects
route('GET', '/api/projects', () => db.projects);
route('POST', '/api/projects', ({ body }) => {
  const dir = expand(body.path);
  if (!isDir(dir)) throw fail(400, `Not a folder: ${dir}`);
  if (!db.projects.some(p => p.path === dir)) db.projects.push({ path: dir, name: path.basename(dir) || dir, addedAt: Date.now() });
  db.settings.lastProject = dir;
  changed('projects');
  changed('settings');
  return db.projects.find(p => p.path === dir);
});
route('DELETE', '/api/projects', ({ query }) => {
  db.projects = db.projects.filter(p => p.path !== query.get('path'));
  if (db.settings.lastProject === query.get('path')) db.settings.lastProject = db.projects[0]?.path ?? '';
  changed('projects');
  changed('settings');
  return {};
});

// Settings
route('GET', '/api/settings', () => db.settings);
route('PATCH', '/api/settings', ({ body }) => {
  for (const [key, value] of Object.entries(body)) {
    if (!(key in db.settings)) continue;
    if (key === 'permissionMode' && !PERMISSION_MODES.includes(value)) throw fail(400, 'Unknown permission mode');
    if (key === 'browserPanes') {
      const ok = value && typeof value === 'object' && Object.values(value).every(list => Array.isArray(list)
        && list.every(b => typeof b?.id === 'string' && /^https?:\/\//i.test(String(b.url))));
      if (!ok) throw fail(400, 'Browser panes can only open http and https pages');
    }
    db.settings[key] = value;
  }
  changed('settings');
  return db.settings;
});

// Sessions
route('GET', '/api/agents', () => S.availableAgents());
route('GET', '/api/sessions', () => [...S.sessions.values()].map(S.info));
route('POST', '/api/sessions', async ({ req, body }) => {
  const { kind = 'agent', agent = db.settings.defaultAgent, prompt = '', name, worktree = false, role = null } = body;
  const project = projectFor(req, body.project);
  if (!isDir(project)) throw fail(400, `Not a folder: ${project}`);
  return S.info(await S.createSession({ project, kind, agent, prompt, name, worktree, role }));
});
route('DELETE', '/api/sessions/:id', ({ params }) => (S.stop(findSession(params.id)), {}));

// Chats: agent conversations kept after their pane closes or the app quits, so they can be opened again
const findChat = id => db.chats.find(c => c.id === id) ?? (() => { throw fail(404, 'No such chat'); })();
route('GET', '/api/chats', ({ query }) => {
  const project = query.get('project') ? expand(query.get('project')) : null;
  return db.chats.filter(c => !project || c.project === project).map(S.chatInfo).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
});
route('POST', '/api/chats/:id/open', async ({ params }) => {
  const chat = findChat(params.id);
  const current = chat.sessionId && S.sessions.get(chat.sessionId);
  if (current && !current.exited) return { session: S.info(current), replaced: null };
  if (current) S.stop(current); // a finished pane for this chat gives way to the reopened one
  const s = await S.createSession({ chatId: chat.id });
  const task = chat.taskId && db.tasks.find(t => t.id === chat.taskId);
  if (task) {
    task.sessionId = s.id;
    changed('tasks');
  }
  return { session: S.info(s), replaced: current?.id ?? null };
});
route('PATCH', '/api/chats/:id', ({ params, body }) => {
  const chat = findChat(params.id);
  const title = String(body.title ?? '').trim().slice(0, 120);
  chat.title = title || null; // empty goes back to Claude's own title
  changed('chats');
  return S.chatInfo(chat);
});
route('DELETE', '/api/chats/:id', ({ params }) => {
  const chat = findChat(params.id);
  const s = chat.sessionId && S.sessions.get(chat.sessionId);
  if (s) S.stop(s);
  db.chats = db.chats.filter(c => c.id !== chat.id); // Claude's own copy of the conversation is left alone
  changed('chats');
  return {};
});
route('GET', '/api/sessions/:id/output', ({ params, query }) => ({ text: S.screenText(findSession(params.id), Number(query.get('lines')) || 60) }));
route('POST', '/api/sessions/:id/input', ({ params, body }) => (S.send(findSession(params.id), String(body.text ?? ''), body.submit !== false), {}));

// Tasks
route('GET', '/api/tasks', ({ req, query }) => {
  const project = query.get('project') ? expand(query.get('project')) : caller(req)?.project;
  return project ? db.tasks.filter(t => t.project === project) : db.tasks;
});
route('POST', '/api/tasks', ({ req, body }) => {
  if (!String(body.title || '').trim()) throw fail(400, 'A task needs a title');
  const task = {
    id: randomUUID().slice(0, 8), project: projectFor(req, body.project), title: body.title.trim(),
    description: String(body.description || '').trim(), status: STATUSES.includes(body.status) ? body.status : 'todo',
    agent: body.agent || db.settings.defaultAgent, worktree: body.worktree ?? db.settings.worktreeByDefault,
    sessionId: null, branch: null, worktreePath: null, notes: [], createdBy: caller(req)?.name || 'You', createdAt: Date.now(), updatedAt: Date.now(),
  };
  db.tasks.push(task);
  changed('tasks');
  return task;
});
route('PATCH', '/api/tasks/:id', ({ params, body }) => {
  const task = findTask(params.id);
  if (body.status !== undefined && !STATUSES.includes(body.status)) throw fail(400, `Status must be one of: ${STATUSES.join(', ')}`);
  for (const key of ['title', 'description', 'status', 'agent', 'worktree']) if (body[key] !== undefined) task[key] = body[key];
  if (body.before !== undefined) { // drag-and-drop: place this task just before another one
    db.tasks.splice(db.tasks.indexOf(task), 1);
    const at = db.tasks.findIndex(t => t.id === body.before);
    db.tasks.splice(at < 0 ? db.tasks.length : at, 0, task);
  }
  task.updatedAt = Date.now();
  changed('tasks');
  return task;
});
route('DELETE', '/api/tasks/:id', ({ params }) => {
  db.tasks = db.tasks.filter(t => t.id !== params.id);
  changed('tasks');
  return {};
});
route('POST', '/api/tasks/:id/comments', ({ req, params, body }) => {
  const task = findTask(params.id);
  if (!String(body.text || '').trim()) throw fail(400, 'Comment is empty');
  task.notes.push({ at: Date.now(), by: caller(req)?.name || 'You', text: body.text.trim() });
  task.updatedAt = Date.now();
  changed('tasks');
  return task;
});
route('POST', '/api/tasks/:id/start', async ({ params, body }) => {
  const task = findTask(params.id);
  const running = task.sessionId && S.sessions.get(task.sessionId);
  if (running && !running.exited) throw fail(409, 'This task already has a running agent');
  const agent = body.agent || task.agent || db.settings.defaultAgent;
  const worktree = body.worktree ?? task.worktree;
  const prompt = task.description ? `${task.title}\n\n${task.description}` : task.title;
  const s = await S.createSession({ project: task.project, agent, prompt, name: task.title, taskId: task.id, worktree });
  Object.assign(task, { status: 'doing', sessionId: s.id, agent, worktree, branch: s.worktree?.branch ?? null, worktreePath: s.worktree?.path ?? null, updatedAt: Date.now() });
  changed('tasks');
  return { task, session: S.info(s) };
});

// Review: what each agent worktree changed, and committing, merging or discarding it
route('GET', '/api/review', async ({ req, query }) => {
  const result = await G.review(projectFor(req, query.get('project')));
  for (const item of result.items) {
    const s = [...S.sessions.values()].find(x => x.cwd === item.path && !x.exited);
    item.session = s ? S.info(s) : null;
    item.task = item.taskId ? db.tasks.find(t => t.id === item.taskId) ?? null : null;
  }
  return result;
});
const existingDir = p => {
  const dir = expand(p);
  if (!isDir(dir)) throw fail(404, 'No such worktree');
  return dir;
};
route('GET', '/api/review/file', ({ query }) => G.fileVersions(existingDir(query.get('worktree')), query.get('file')));
route('GET', '/api/review/diff', async ({ query }) => ({ text: await G.diffText(existingDir(query.get('worktree'))) }));
route('POST', '/api/review/commit', ({ body }) => G.commit(existingDir(body.worktree), String(body.message || 'Agent Desk changes')));
route('POST', '/api/review/merge', async ({ body }) => {
  const meta = await G.merge(existingDir(body.worktree));
  const task = meta.taskId && db.tasks.find(t => t.id === meta.taskId);
  if (task) {
    task.status = 'done';
    task.notes.push({ at: Date.now(), by: 'You', text: `Merged ${meta.branch} into ${meta.base}.` });
    changed('tasks');
  }
  return { merged: meta.branch, into: meta.base };
});
route('POST', '/api/review/remove', async ({ body }) => {
  const dir = existingDir(body.worktree);
  if ([...S.sessions.values()].some(s => s.cwd === dir && !s.exited)) throw fail(409, 'An agent is still running in this worktree. Stop it first.');
  await G.removeWorktree(dir);
  return {};
});

// Files (the editor, folder suggestions, images)
route('GET', '/api/fs/list', ({ query }) => {
  const dir = expand(query.get('path'));
  if (!isDir(dir)) throw fail(404, `Not a folder: ${dir}`);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !SKIP_IN_TREE.has(e.name))
    .map(e => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() }))
    .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
});
route('GET', '/api/fs/file', ({ query }) => {
  const file = expand(query.get('path'));
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw fail(404, 'No such file');
  if (stat.size > 5 * 1024 * 1024) throw fail(413, 'File is over 5 MB, open it in a shell instead');
  const data = fs.readFileSync(file);
  if (data.subarray(0, 8000).includes(0)) throw fail(415, 'This looks like a binary file');
  return { content: data.toString('utf8') };
});
route('PUT', '/api/fs/file', ({ body }) => {
  const file = expand(body.path);
  if (!isDir(path.dirname(file))) throw fail(404, 'Folder does not exist');
  writeAtomic(file, String(body.content ?? ''));
  return {};
});
route('GET', '/api/fs/suggest', ({ query }) => {
  const raw = query.get('prefix') || '~/';
  const full = expand(raw);
  const [dir, start] = raw.endsWith('/') ? [full, ''] : [path.dirname(full), path.basename(full)];
  if (!isDir(dir)) return [];
  const shown = raw.endsWith('/') ? raw : raw.slice(0, raw.length - start.length);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(start.toLowerCase()))
    .slice(0, 30).map(e => `${shown}${e.name}`);
});
// Raster images only: an SVG opened from here would run its scripts with this app's access.
const RASTER = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
route('GET', '/api/fs/raw', ({ query }) => {
  const file = expand(query.get('path'));
  if (!RASTER.has(path.extname(file).toLowerCase()) || !fs.existsSync(file)) throw fail(404, 'No such image');
  return { raw: fs.readFileSync(file), type: MIME[path.extname(file).toLowerCase()] };
});

// Screenshots for agents, saved inside the project (kept out of git)
const shotsDir = project => path.join(project, '.agent-desk', 'shots');
route('GET', '/api/shots', ({ req, query }) => {
  const dir = shotsDir(projectFor(req, query.get('project')));
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.png'))
    .map(f => ({ name: f, path: path.join(dir, f), at: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at).slice(0, 40);
});
route('POST', '/api/shots', async ({ req, body }) => {
  const project = projectFor(req, body.project);
  const match = /^data:image\/png;base64,(.+)$/.exec(body.dataUrl || '');
  if (!match) throw fail(400, 'Expected a PNG image');
  const root = await G.repoRoot(project);
  if (root) await G.excludeDeskFolder(root);
  fs.mkdirSync(shotsDir(project), { recursive: true });
  const file = path.join(shotsDir(project), `shot-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
  fs.writeFileSync(file, Buffer.from(match[1], 'base64'));
  return { path: file };
});

// Voice: an on-device speech helper (macOS Speech framework) streams what you say to the page
route('POST', '/api/voice/start', ({ body }) => {
  if (!VOICE_HELPER) throw fail(501, 'The voice helper is not built. Run: npm run build:native');
  if (voice) return {};
  voice = spawn(VOICE_HELPER, [String(body.lang || db.settings.voiceLang)], { stdio: ['pipe', 'pipe', 'ignore'] });
  readline.createInterface({ input: voice.stdout }).on('line', line => {
    const [kind, ...rest] = line.split(':');
    const text = rest.join(':');
    if (kind === 'PARTIAL' || kind === 'FINAL') bus.emit('event', { type: 'voice', text, final: kind === 'FINAL' });
    if (kind === 'ERROR') bus.emit('event', { type: 'voice', error: text });
  });
  voice.on('exit', () => {
    voice = null;
    bus.emit('event', { type: 'voice', stopped: true });
  });
  return {};
});
route('POST', '/api/voice/stop', () => {
  voice?.stdin.write('stop\n');
  return {};
});

// ---------- HTTP ----------
function staticPath(pathname) {
  const inside = (base, rel) => {
    const file = path.resolve(base, decodeURIComponent(rel));
    return file.startsWith(base + path.sep) ? file : null;
  };
  if (pathname === '/') return path.join(DIR, 'public', 'index.html');
  if (pathname.startsWith('/vendor/monaco/')) return inside(path.join(DIR, 'node_modules', 'monaco-editor', 'min'), pathname.slice(15));
  if (pathname.startsWith('/vendor/')) return Object.hasOwn(VENDOR, pathname.slice(8)) ? path.join(DIR, 'node_modules', VENDOR[pathname.slice(8)]) : null;
  return inside(path.join(DIR, 'public'), pathname.slice(1));
}

const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><title>Agent Desk</title>
<body style="font:15px -apple-system,system-ui,sans-serif;background:#0b0c10;color:#e7e9ef;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:420px;text-align:center"><h2>Agent Desk is locked</h2>
<p style="color:#8a90a2">Open it with the link printed in the terminal where you ran <code>npm start</code>.</p></div>`;

// One bad request must never take the server (and every running agent) down.
async function handle(req, res) {
  try {
    await respond(req, res);
  } catch (e) {
    if (!res.headersSent) res.writeHead(e instanceof URIError ? 400 : 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e instanceof URIError ? 'Bad URL' : e.message }));
  }
}

async function respond(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!sameSite(req)) return json(403, { error: 'Forbidden' });
  if (url.pathname === '/mcp') return hasToken(req, url) ? mcp(req, res, json) : json(401, { error: 'Missing or wrong Agent Desk token' });

  if (!url.pathname.startsWith('/api/')) {
    if (url.pathname === '/' && url.searchParams.has('t')) { // trade the link's secret for a cookie, then drop it from the address bar
      if (!hasToken(req, url)) return res.writeHead(302, { location: '/' }).end();
      return res.writeHead(302, { location: '/', 'set-cookie': `${COOKIE}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/` }).end();
    }
    if (url.pathname === '/' && !hasToken(req, url)) return res.writeHead(401, { 'content-type': 'text/html' }).end(LOCKED_PAGE);
    const file = req.method === 'GET' && staticPath(url.pathname);
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  }

  if (!hasToken(req, url)) return json(401, { error: 'Missing or wrong Agent Desk token' });

  if (url.pathname === '/api/events') { // server-sent events: the page refetches whatever changed
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    bus.on('event', send);
    return req.on('close', () => { clearInterval(ping); bus.off('event', send); });
  }

  for (const r of routes) {
    const m = r.method === req.method && r.re.exec(url.pathname);
    if (!m) continue;
    try {
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const result = await r.handler({ req, params, query: url.searchParams, body });
      if (result?.raw) {
        res.writeHead(200, { 'content-type': result.type, 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' });
        return res.end(result.raw);
      }
      return json(200, result ?? {});
    } catch (e) {
      return json(e.status || 500, { error: e.message });
    }
  }
  json(404, { error: 'Not found' });
}

// MCP over HTTP: each POST carries one JSON-RPC message (or a batch). The tools act as the session named
// in the x-desk-session header, so "update my task" knows which task. No server-to-client stream is offered.
async function mcp(req, res, json) {
  if (req.method !== 'POST') return json(405, { error: 'POST JSON-RPC messages here' });
  const body = await readBody(req);
  const session = String(req.headers['x-desk-session'] || '');
  const api = async (method, apiPath, payload) => {
    const r = await fetch(`${S.serverUrl()}${apiPath}`, {
      method, headers: { 'content-type': 'application/json', 'x-desk-token': TOKEN, 'x-desk-session': session },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Agent Desk answered ${r.status}`);
    return data;
  };
  const tools = mcpTools({ api, session });
  const answers = (await Promise.all((Array.isArray(body) ? body : [body]).map(m => handleMcp(m, tools)))).filter(Boolean);
  if (!answers.length) return res.writeHead(202).end();
  json(200, Array.isArray(body) ? answers : answers[0]);
}

// Each terminal pane attaches to one session: it gets the current screen, then live output.
const wss = new WebSocketServer({ noServer: true });
function upgrade(req, socket, head) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const s = url.pathname === '/ws' && S.sessions.get(url.searchParams.get('id'));
    if (!sameSite(req) || !hasToken(req, url) || !s) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => S.attach(s, ws));
  } catch {
    socket.destroy();
  }
}

// Starts Agent Desk. The Mac app calls this with its own data folder; `npm start` runs it directly.
export async function start({ port = Number(process.env.PORT) || 4747, dataDir = path.join(DIR, 'data'), voiceHelper } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  load(dataDir);
  S.forgetRunningChats();
  VOICE_HELPER = [voiceHelper, path.join(DIR, 'native', 'build', 'desk-listen')].find(p => p && fs.existsSync(p)) ?? null;
  // The secret is kept in a file only you can read, so links and MCP setups keep working across restarts.
  const tokenFile = path.join(dataDir, 'token');
  TOKEN = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  if (!/^[A-Za-z0-9_-]{32,}$/.test(TOKEN)) { // missing, empty or damaged: make a new one
    TOKEN = randomBytes(24).toString('base64url');
    fs.writeFileSync(`${tokenFile}.tmp`, TOKEN, { mode: 0o600 });
    fs.renameSync(`${tokenFile}.tmp`, tokenFile);
  }
  const server = http.createServer(handle);
  server.on('upgrade', upgrade);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = server.address().port;
  LOCAL = new Set([`localhost:${actual}`, `127.0.0.1:${actual}`]);
  COOKIE = `desk_${actual}`;
  S.setServer({ url: `http://127.0.0.1:${actual}`, token: TOKEN, dataDir });
  // 127.0.0.1, not localhost: localhost may resolve to ::1, where some other program could be listening.
  const url = `http://127.0.0.1:${actual}/?t=${TOKEN}`;
  console.log(`Agent Desk is running. Open ${url}`);
  return {
    port: actual, url, token: TOKEN,
    close: () => { S.stopAll(); voice?.kill(); server.close(); },
  };
}

if (process.argv[1] && import.meta.filename === fs.realpathSync(process.argv[1])) {
  const { close } = await start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { close(); process.exit(0); });
}
