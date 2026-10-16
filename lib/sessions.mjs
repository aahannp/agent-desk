// Agent and shell sessions: each one is a real terminal (node-pty) mirrored into a headless xterm,
// so pages can reattach to the exact screen and agents can read each other's output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { db, changed } from './store.mjs';
import { createWorktree } from './git.mjs';

const { Terminal } = headless;
const { SerializeAddon } = serialize;

// Inside the packaged Mac app these files sit next to app.asar, because zsh and claude read them directly.
const unpacked = p => p.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
const ROOT = path.dirname(import.meta.dirname);
const ZSH_DIR = unpacked(path.join(ROOT, 'shell', 'zsh'));
const MAX_RUNNING = 16;

export const AGENTS = {
  claude: { label: 'Claude Code', bin: 'claude' },
  codex: { label: 'Codex', bin: 'codex' },
  gemini: { label: 'Gemini CLI', bin: 'gemini' },
  cursor: { label: 'Cursor Agent', bin: 'cursor-agent' },
};

const onPath = bin => (process.env.PATH || '').split(':').some(dir => {
  try { fs.accessSync(path.join(dir, bin), fs.constants.X_OK); return true; } catch { return false; }
});
export const availableAgents = () => Object.entries(AGENTS).map(([id, a]) => ({ id, label: a.label, installed: onPath(a.bin) }));

// Board tools agents may use without asking. send_to_agent and stop_agent still ask you first,
// so a lead agent can't answer a worker's permission prompt or kill it on its own.
const AUTO_ALLOWED = ['get_project', 'list_tasks', 'create_task', 'update_task', 'comment_on_task',
  'start_task', 'start_agent', 'list_agents', 'read_agent_output', 'get_agent_diff'];

export const sessions = new Map();
let server = { url: '', token: '', dataDir: '' };
export const setServer = info => (server = info);
export const serverUrl = () => server.url;

function systemPrompt(s, task) {
  const intro = 'You are running inside Agent Desk, an app where several coding agents work side by side on one project. ' +
    'The "agent-desk" MCP tools show the shared task board and the other agents.';
  if (s.role === 'lead') {
    return `${intro}
You are the LEAD agent. Turn the user's goal into small, independent tasks and run them in parallel:
1. Read enough of the code to plan well. Don't write the code yourself unless the user asks.
2. Create one task per piece of work with create_task. Make each description self-contained: the goal, the files involved, and how to check it works.
3. Start workers with start_task. Each gets its own git worktree, so they can't clash. Run at most 4 at once unless told otherwise.
4. Watch them with list_agents and read_agent_output. If a worker is stuck or asks something, answer with send_to_agent.
5. When workers finish, check their work with get_agent_diff, then tell the user what is ready in the Review tab. Never merge yourself.`;
  }
  if (task) {
    return `${intro}
You are a WORKER on the task "${task.title}" (task id ${task.id}).${s.worktree ? ` You are in your own git worktree on branch ${s.worktree.branch}. Commit your work there when you're done.` : ''}
When you finish, post a short summary with comment_on_task, then set the task status to "review" with update_task. If you're blocked, say why with comment_on_task.`;
  }
  return `${intro} Use them when the user asks about tasks or other agents.`;
}

// A prompt that starts with "-" would be read as a command-line flag (think "--dangerously-skip-permissions"
// in a task title). A leading space makes every CLI treat it as plain text.
const asText = prompt => (prompt.startsWith('-') ? ` ${prompt}` : prompt);

// The MCP config carries the secret, so it goes in a file only you can read, never on the command line
// (other users on the Mac can see command lines with `ps`).
function mcpConfigFile(s) {
  const dir = path.join(server.dataDir, 'mcp');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = { type: 'http', url: `${server.url}/mcp`, headers: { 'x-desk-token': server.token, 'x-desk-session': s.id } };
  const file = path.join(dir, `${s.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'agent-desk': config } }), { mode: 0o600 });
  return file;
}

function command(s, prompt, task) {
  // Agents use your own Claude Code login (your subscription). Drop variables that would switch them to
  // API-key billing, make claude think it's nested in another session, or claim to be the parent terminal.
  const env = { ...process.env, COLORTERM: 'truecolor' };
  for (const key of ['ANTHROPIC_API_KEY', 'CLAUDECODE', 'ELECTRON_RUN_AS_NODE', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION']) delete env[key];

  if (s.kind === 'shell') {
    const shell = process.env.SHELL || '/bin/zsh';
    // ponytail: command blocks need zsh's hooks; bash shells run fine, just without blocks.
    if (shell.endsWith('zsh') && fs.existsSync(ZSH_DIR)) {
      Object.assign(env, { AGENT_DESK_USER_ZDOTDIR: process.env.ZDOTDIR || os.homedir(), ZDOTDIR: ZSH_DIR, AGENT_DESK_NONCE: s.nonce });
    }
    return { file: shell, args: [], env };
  }

  const args = [];
  const text = asText(prompt);
  if (s.agent === 'claude') {
    if (text) args.push(text); // first, because the options below take lists and would swallow it
    const mode = db.settings.permissionMode;
    if (mode && mode !== 'default') args.push('--permission-mode', mode);
    args.push('--append-system-prompt', systemPrompt(s, task));
    args.push('--allowedTools', AUTO_ALLOWED.map(t => `mcp__agent-desk__${t}`).join(','));
    args.push('--mcp-config', mcpConfigFile(s));
  } else if (text) {
    // ponytail: only Claude gets the board's MCP tools; Codex, Gemini and Cursor each configure MCP their own way.
    args.push(...(s.agent === 'gemini' ? ['-i', text] : [text]));
  }
  return { file: AGENTS[s.agent].bin, args, env };
}

const flag = s => {
  if (s.attention || s.exited) return;
  s.attention = true;
  changed('sessions');
};

export async function createSession({ project, kind = 'agent', agent = 'claude', prompt = '', name, taskId = null, role = null, worktree = false }) {
  if (!project) throw new Error('Pick a project folder first');
  if (kind === 'agent' && !AGENTS[agent]) throw new Error(`Unknown agent "${agent}"`);
  if ([...sessions.values()].filter(s => !s.exited).length >= MAX_RUNNING) {
    throw new Error(`${MAX_RUNNING} sessions are already running. Stop one first.`);
  }
  const task = taskId ? db.tasks.find(t => t.id === taskId) : null;
  const wt = worktree && kind === 'agent' ? await createWorktree(project, name || task?.title || prompt || agent, taskId) : null;
  const s = {
    id: randomUUID().slice(0, 8), kind, agent: kind === 'agent' ? agent : null, role, project, taskId,
    worktree: wt, cwd: wt?.path ?? project,
    name: name || task?.title || (role === 'lead' ? 'Lead agent' : kind === 'shell' ? 'Shell' : AGENTS[agent].label),
    startedAt: Date.now(), lastOutputAt: Date.now(), attention: false, exited: false, exitCode: null, sockets: new Set(),
    nonce: randomUUID().replace(/-/g, ''), // signs the shell's command marks, see shell/zsh/.zshrc
  };
  const { file, args, env } = command(s, prompt, task);
  s.pty = pty.spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 32, cwd: s.cwd, env });
  s.term = new Terminal({ cols: 120, rows: 32, scrollback: 5000, allowProposedApi: true });
  s.serializer = new SerializeAddon();
  s.term.loadAddon(s.serializer);
  // An agent that needs you rings the bell or sends a desktop notification (OSC 9 / OSC 777).
  s.term.onBell(() => flag(s));
  s.term.parser.registerOscHandler(9, data => (data.startsWith('4;') || flag(s), true)); // 9;4 is a progress bar, not a ping
  s.term.parser.registerOscHandler(777, () => (flag(s), true));

  // Send output from the parser's callback, so a page attaching mid-stream never misses or repeats a chunk.
  const emit = data => {
    if (sessions.has(s.id)) s.term.write(data, () => { for (const ws of s.sockets) ws.send(data); });
  };
  s.pty.onData(data => {
    s.lastOutputAt = Date.now();
    emit(data);
  });
  s.pty.onExit(({ exitCode }) => {
    Object.assign(s, { exited: true, exitCode });
    removeMcpConfig(s);
    emit(`\r\n\x1b[2m[exited with code ${exitCode}]\x1b[0m\r\n`);
    const t = db.tasks.find(x => x.sessionId === s.id);
    if (t?.status === 'doing') {
      t.status = 'review';
      changed('tasks');
    }
    changed('sessions');
  });
  sessions.set(s.id, s);
  changed('sessions');
  return s;
}

// What pages and agents see: "working" while output is flowing, "idle" when it's waiting.
export const status = s => s.exited ? 'exited' : s.attention ? 'needs-input' : Date.now() - s.lastOutputAt < 3000 ? 'working' : 'idle';

export const info = s => ({
  id: s.id, kind: s.kind, agent: s.agent, role: s.role, name: s.name, project: s.project, cwd: s.cwd, taskId: s.taskId,
  worktree: s.worktree && { path: s.worktree.path, branch: s.worktree.branch, base: s.worktree.base },
  startedAt: s.startedAt, exited: s.exited, exitCode: s.exitCode, status: status(s),
  nonce: s.kind === 'shell' ? s.nonce : undefined,
});

export function write(s, data) {
  if (s.exited) return;
  s.pty.write(data);
  if (s.attention) {
    s.attention = false;
    changed('sessions');
  }
}

// Typed text and the Enter key go separately; TUIs like Claude Code treat one big chunk as a paste.
export function send(s, text, submit = true) {
  write(s, text);
  if (submit) setTimeout(() => write(s, '\r'), 150);
}

export function resize(s, cols, rows) {
  if (s.exited || !(cols >= 2 && cols <= 1000 && rows >= 2 && rows <= 1000)) return;
  s.pty.resize(cols | 0, rows | 0);
  s.term.resize(cols | 0, rows | 0);
}

export function attach(s, ws) {
  s.term.write('', () => {
    ws.send(s.serializer.serialize({ scrollback: 2000 }));
    s.sockets.add(ws);
  });
  ws.on('close', () => s.sockets.delete(ws));
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.t === 'in') write(s, String(msg.d));
      if (msg.t === 'resize') resize(s, msg.cols, msg.rows);
    } catch {} // ignore malformed messages
  });
}

export function screenText(s, lines = 60) {
  const buffer = s.term.buffer.active;
  const out = [];
  for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '');
  while (out.length && !out.at(-1).trim()) out.pop();
  return out.slice(-Math.min(Math.max(lines, 1), 500)).join('\n');
}

const removeMcpConfig = s => fs.rmSync(path.join(server.dataDir, 'mcp', `${s.id}.json`), { force: true });

export function stop(s) {
  if (!s.exited) s.pty.kill();
  removeMcpConfig(s);
  for (const ws of s.sockets) ws.close();
  s.term.dispose();
  sessions.delete(s.id);
  changed('sessions');
}

export const stopAll = () => { for (const s of sessions.values()) if (!s.exited) s.pty.kill(); };
