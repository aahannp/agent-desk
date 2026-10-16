// Agent Desk: a local control room for running several Claude Code sessions side by side.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

const DIR = import.meta.dirname;
const SCROLLBACK = 200_000; // characters replayed when a page reattaches to a session
let TASKS_FILE;
let LOCAL = new Set();

const STATIC = {
  '/': ['public/index.html', 'text/html'],
  '/xterm.js': ['node_modules/@xterm/xterm/lib/xterm.js', 'text/javascript'],
  '/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/addon-fit.js': ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'text/javascript'],
};

// Agents use your Claude Code login (your subscription). Drop the variables that would switch
// them to API-key billing or make claude think it is nested inside another Claude session.
const agentEnv = { ...process.env, COLORTERM: 'truecolor' };
delete agentEnv.ANTHROPIC_API_KEY;
delete agentEnv.CLAUDECODE;

const sessions = new Map();

// Any website you visit can try to reach localhost, and this server hands out shells.
// So only answer requests addressed to localhost (stops DNS rebinding) and sent from this page.
function trusted(req) {
  if (!LOCAL.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || LOCAL.has(origin.replace(/^https?:\/\//, ''));
}

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'task';

function createSession({ kind = 'claude', cwd = '~', prompt = '', worktree = false, name } = {}) {
  cwd = path.resolve(cwd.trim().replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Not a folder: ${cwd}`);
  const id = randomUUID().slice(0, 8);
  const args = [];
  if (kind === 'claude') {
    // Name the worktree explicitly, otherwise claude would read the prompt as its name.
    if (worktree) args.push('--worktree', `${slug(name || prompt)}-${id}`);
    if (prompt) args.push(prompt);
  }
  const file = kind === 'claude' ? 'claude' : process.env.SHELL || '/bin/zsh';
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 32, cwd, env: agentEnv });
  const s = { id, kind, cwd, name: name || kind, pty: p, buf: '', sockets: new Set(), exited: false };
  const emit = data => {
    s.buf += data;
    // ponytail: trimming can cut an escape sequence in half; the next redraw fixes the screen.
    if (s.buf.length > 2 * SCROLLBACK) s.buf = s.buf.slice(-SCROLLBACK);
    for (const ws of s.sockets) ws.send(data);
  };
  p.onData(emit);
  p.onExit(({ exitCode }) => {
    s.exited = true;
    emit(`\r\n\x1b[2m[exited with code ${exitCode}]\x1b[0m\r\n`);
  });
  sessions.set(id, s);
  return s;
}

const info = s => ({ id: s.id, kind: s.kind, name: s.name, cwd: s.cwd, exited: s.exited });

const readJson = req => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Request body is not JSON')); }
  });
});

const server = http.createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  };
  if (!trusted(req)) return send(403, { error: 'Forbidden' });
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(200, fs.readFileSync(path.join(DIR, file)), type);
    }
    if (route === 'GET /api/sessions') return send(200, [...sessions.values()].map(info));
    if (route === 'POST /api/sessions') return send(201, info(createSession(await readJson(req))));
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) {
      const s = sessions.get(url.pathname.split('/').pop());
      if (!s) return send(404, { error: 'No such session' });
      if (!s.exited) s.pty.kill();
      for (const ws of s.sockets) ws.close();
      sessions.delete(s.id);
      return send(200, {});
    }
    if (route === 'GET /api/tasks') {
      return send(200, fs.existsSync(TASKS_FILE) ? JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) : []);
    }
    if (route === 'PUT /api/tasks') {
      const tasks = await readJson(req);
      if (!Array.isArray(tasks)) return send(400, { error: 'Expected a list of tasks' });
      // Write a temp file and rename it, so a crash mid-write can't wipe the board.
      fs.writeFileSync(`${TASKS_FILE}.tmp`, JSON.stringify(tasks, null, 2));
      fs.renameSync(`${TASKS_FILE}.tmp`, TASKS_FILE);
      return send(200, {});
    }
    send(404, { error: 'Not found' });
  } catch (e) {
    send(400, { error: e.message });
  }
});

// Each browser pane attaches to one session: it gets the scrollback, then the live output.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const s = sessions.get(new URL(req.url, 'http://localhost').searchParams.get('id'));
  if (!trusted(req) || !s) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    ws.send(s.buf);
    s.sockets.add(ws);
    ws.on('close', () => s.sockets.delete(ws));
    ws.on('message', raw => {
      if (s.exited) return;
      try {
        const msg = JSON.parse(raw);
        if (msg.t === 'in') s.pty.write(String(msg.d));
        if (msg.t === 'resize' && msg.cols > 0 && msg.rows > 0) s.pty.resize(msg.cols | 0, msg.rows | 0);
      } catch {} // ignore malformed messages
    });
  });
});

// Starts Agent Desk. The Mac app calls this with its own data folder; `npm start` runs it directly.
export function start({ port = Number(process.env.PORT) || 4747, dataDir = path.join(DIR, 'data') } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  TASKS_FILE = path.join(dataDir, 'tasks.json');
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      LOCAL = new Set([`localhost:${actual}`, `127.0.0.1:${actual}`]);
      const url = `http://localhost:${actual}`;
      console.log(`Agent Desk running at ${url}`);
      resolve({ port: actual, url, close: () => { for (const s of sessions.values()) if (!s.exited) s.pty.kill(); server.close(); } });
    });
  });
}

if (process.argv[1] && import.meta.filename === fs.realpathSync(process.argv[1])) start();
