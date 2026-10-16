// Smoke check for the server: security, a shell with command blocks, the task board, worktree review and
// merge, and the MCP tools. Uses a throwaway data folder and git repo, never your real ones.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { start } from './server.mjs';
import { createWorktree } from './lib/git.mjs';
import { db } from './lib/store.mjs';
import { command } from './lib/sessions.mjs';
import { randomUUID } from 'node:crypto';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-check-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const sh = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
sh('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
sh('add', '.');
sh('-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-qm', 'first');

fs.mkdirSync(path.join(tmp, 'data'));
process.env.TASKNOTES_DATA = path.join(tmp, 'tasknotes'); // a stand-in Task Notes, never the real one
fs.writeFileSync(path.join(tmp, 'data', 'token'), ''); // an empty secret file must never mean "no secret"
const desk = await start({ port: 0, dataDir: path.join(tmp, 'data') });
assert.ok(desk.token.length >= 32, 'an empty token file is replaced with a real secret');
const SELF = `http://127.0.0.1:${desk.port}`;
const EVIL = 'https://evil.example';

function request(method, url, { headers = {}, body, token = desk.token } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${SELF}${url}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { 'x-desk-token': token } : {}), ...headers },
    }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(body && JSON.stringify(body));
  });
}
const ok = async (method, url, body) => {
  const res = await request(method, url, { body });
  assert.ok(res.status < 300, `${method} ${url} → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};

function shellUntil(id, cookie, command, wanted) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${desk.port}/ws?id=${id}`, { origin: SELF, headers: { cookie } });
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`timed out, got: ${JSON.stringify(seen.slice(-400))}`)), 15_000);
    ws.on('open', () => setTimeout(() => ws.send(JSON.stringify({ t: 'in', d: `${command}\r` })), 500));
    ws.on('message', data => {
      seen += data;
      if (wanted.every(w => seen.includes(w))) {
        clearTimeout(timer);
        ws.close();
        resolve(seen);
      }
    });
    ws.on('error', reject);
  });
}

try {
  // Security: no token, wrong host, other websites
  assert.equal((await request('GET', '/api/sessions', { token: '' })).status, 401, 'API without the token is refused');
  assert.equal((await request('GET', '/', { token: '' })).status, 401, 'page without the token shows the lock screen');
  const login = await request('GET', `/?t=${desk.token}`, { token: '' });
  assert.equal(login.status, 302, 'the link with the token redirects');
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request('GET', '/api/sessions', { token: '', headers: { cookie } })).status, 200, 'the cookie works');
  assert.equal((await request('GET', '/api/sessions', { headers: { host: `evil.example:${desk.port}` } })).status, 403, 'DNS-rebinding host is refused');
  assert.equal((await request('PUT', '/api/fs/file', { headers: { origin: EVIL }, body: {} })).status, 403, 'other websites are refused');
  const evilSocket = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${desk.port}/ws?id=x`, { origin: EVIL, headers: { cookie } });
    ws.on('open', () => resolve('opened'));
    ws.on('error', () => resolve('refused'));
  });
  assert.equal(evilSocket, 'refused', 'websocket from another website is refused');
  assert.equal((await request('GET', '/%E0%A4%A', { token: '' })).status, 400, 'a malformed URL is a 400, not a crash');
  assert.equal((await request('GET', '/vendor/constructor', { token: '' })).status, 404, 'vendor lookup ignores prototype keys');
  assert.equal((await request('GET', '/api/sessions', { token: 'é'.repeat(16) })).status, 401, 'a multi-byte token is refused, not a crash');
  fs.writeFileSync(path.join(tmp, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await request('GET', `/api/fs/raw?path=${encodeURIComponent(path.join(tmp, 'x.svg'))}`)).status, 404, 'SVGs are never served same-origin');

  // Projects and a shell session with command blocks
  await ok('POST', '/api/projects', { path: repo });
  const shell = await ok('POST', '/api/sessions', { kind: 'shell' });
  assert.equal(shell.cwd, repo, 'shell starts in the project');
  const out = await shellUntil(shell.id, cookie, 'echo ok-$((6*7))', ['ok-42', '\x1b]133;D;0']);
  assert.ok(out.includes('\x1b]633;E;echo ok-$((6*7))'), 'the command text is marked for its block');
  assert.match((await ok('GET', `/api/sessions/${shell.id}/output?lines=20`)).text, /ok-42/, 'screen text is readable');
  assert.equal((await request('POST', '/api/sessions', { body: { kind: 'shell', project: '/no/such/folder' } })).status, 400, 'missing folder is rejected');

  // Task board
  const task = await ok('POST', '/api/tasks', { title: 'Add a greeting', project: repo });
  assert.equal(task.status, 'todo');
  assert.equal((await request('PATCH', `/api/tasks/${task.id}`, { body: { status: 'bogus' } })).status, 400, 'unknown status is rejected');
  await ok('POST', `/api/tasks/${task.id}/comments`, { text: 'looks good' });
  assert.equal((await ok('GET', `/api/tasks?project=${encodeURIComponent(repo)}`))[0].notes.length, 1);

  // Worktree → review → commit → merge → remove
  const wt = await createWorktree(repo, 'greeting', task.id);
  assert.ok(fs.existsSync(wt.path), 'worktree created');
  assert.ok(!sh('status', '--porcelain').includes('.agent-desk'), "Agent Desk's folder stays out of git status");
  fs.writeFileSync(path.join(wt.path, 'hello.txt'), 'hi from the agent\n');
  const review = await ok('GET', `/api/review?project=${encodeURIComponent(repo)}`);
  const item = review.items.find(i => i.path === wt.path);
  assert.deepEqual(item.files.map(f => f.path), ['hello.txt'], 'review lists the new file');
  const versions = await ok('GET', `/api/review/file?worktree=${encodeURIComponent(wt.path)}&file=hello.txt`);
  assert.equal(versions.modified, 'hi from the agent\n');
  assert.equal((await request('POST', '/api/review/merge', { body: { worktree: wt.path } })).status, 500, 'merge refuses uncommitted work');
  execFileSync('git', ['config', 'user.email', 'check@example.com'], { cwd: wt.path });
  execFileSync('git', ['config', 'user.name', 'check'], { cwd: wt.path });
  assert.equal((await ok('POST', '/api/review/commit', { worktree: wt.path, message: 'Add hello' })).committed, true);
  await ok('POST', '/api/review/merge', { worktree: wt.path });
  assert.ok(fs.existsSync(path.join(repo, 'hello.txt')), 'merged into main');
  assert.equal((await ok('GET', `/api/tasks?project=${encodeURIComponent(repo)}`))[0].status, 'done', 'merging marks the task done');
  await ok('POST', '/api/review/remove', { worktree: wt.path });
  assert.ok(!fs.existsSync(wt.path), 'worktree removed');

  // MCP over HTTP: handshake, tool list, real tool calls, and a tool acting as a specific session
  let nextId = 1;
  const rpc = async (method, params, headers = {}) => (await request('POST', '/mcp', { headers, body: { jsonrpc: '2.0', id: nextId++, method, params } })).body;
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } })).result.serverInfo.name, 'agent-desk');
  assert.equal((await request('POST', '/mcp', { body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202, 'notifications get 202');
  assert.equal((await request('POST', '/mcp', { token: '', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status, 401, 'MCP needs the token');
  const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
  assert.equal(tools.length, 12, `12 MCP tools, got ${tools.join(', ')}`);
  assert.match((await rpc('tools/call', { name: 'list_tasks', arguments: {} })).result.content[0].text, /Add a greeting/, 'MCP list_tasks reads the board');
  assert.match((await rpc('tools/call', { name: 'list_agents', arguments: {} })).result.content[0].text, new RegExp(shell.id), 'MCP list_agents sees the shell');
  const self = await rpc('tools/call', { name: 'get_project', arguments: {} }, { 'x-desk-session': shell.id });
  assert.match(self.result.content[0].text, new RegExp(shell.id), 'MCP tools know which session is asking');

  // Chats: titles come from Claude's own saved conversations; rename, remove, and a chat whose folder is gone
  const claudeHome = path.join(tmp, 'claude-home');
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const chatDir = path.join(claudeHome, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(chatDir, { recursive: true });
  const named = randomUUID();
  const plain = randomUUID();
  const line = o => JSON.stringify(o);
  fs.writeFileSync(path.join(chatDir, `${named}.jsonl`), [
    line({ type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>ignore me</system-reminder>' }, { type: 'text', text: 'Fix the login bug please' }] } }),
    line({ type: 'custom-title', customTitle: 'Login bug' }),
  ].join('\n'));
  fs.writeFileSync(path.join(chatDir, `${plain}.jsonl`), line({ type: 'user', message: { content: 'Add a dark mode toggle' } }));
  const chat = (id, claudeSessionId, cwd = repo) => ({ id, agent: 'claude', role: null, project: repo, cwd, taskId: null, name: 'Claude Code', title: null, worktree: null, claudeSessionId, createdAt: Date.now(), lastActiveAt: Date.now(), sessionId: null });
  db.chats.push(chat('c-named', named), chat('c-plain', plain), chat('c-gone', randomUUID(), path.join(tmp, 'deleted-worktree')));
  const byId = async () => Object.fromEntries((await ok('GET', `/api/chats?project=${encodeURIComponent(repo)}`)).map(c => [c.id, c]));
  let chats = await byId();
  assert.equal(chats['c-named'].title, 'Login bug', "Claude's own title is used");
  assert.equal(chats['c-plain'].title, 'Add a dark mode toggle', 'otherwise the first thing you typed');
  assert.equal(chats['c-named'].resumable, true, 'a saved conversation can be resumed');
  assert.equal(chats['c-gone'].folderMissing, true, 'a chat whose worktree is gone says so');
  const gone = await request('POST', '/api/chats/c-gone/open');
  assert.ok(gone.status >= 400 && /folder is gone/.test(gone.body.error), 'opening a chat whose folder is gone fails clearly');
  await ok('PATCH', '/api/chats/c-named', { title: 'My rename' });
  assert.equal((await byId())['c-named'].title, 'My rename', 'your rename wins');
  await ok('PATCH', '/api/chats/c-named', { title: '' });
  assert.equal((await byId())['c-named'].title, 'Login bug', 'an empty rename goes back to Claude\'s title');
  await ok('DELETE', '/api/chats/c-plain');
  assert.ok(!('c-plain' in (await byId())), 'removed from the list');
  assert.ok(fs.existsSync(path.join(chatDir, `${plain}.jsonl`)), "Claude's own copy is left alone");

  // What claude is started with: a fixed id for a new chat, --resume for one Claude has saved
  const base = { id: 'check001', kind: 'agent', agent: 'claude', role: null, worktree: null, claudeSessionId: named };
  const fresh = command({ ...base, resume: false }, '--sneaky prompt', null).args;
  assert.equal(fresh[0], ' --sneaky prompt', 'a prompt starting with "-" is passed as plain text');
  assert.deepEqual(fresh.slice(1, 3), ['--session-id', named], 'a new chat gets the id we chose');
  const resumed = command({ ...base, resume: true }, '', null).args;
  assert.deepEqual(resumed.slice(0, 2), ['--resume', named], 'a saved chat is resumed by id');
  assert.ok(!resumed.includes('--session-id'), 'never both');

  // The whole chat lifecycle, with a stand-in `claude` on the PATH that prints its arguments and exits
  const fakeBin = path.join(tmp, 'fake-bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\necho "FAKE-CLAUDE $*"\n', { mode: 0o755 });
  process.env.PATH = `${fakeBin}:${process.env.PATH}`;
  const exited = async id => {
    for (let i = 0; i < 50; i++) {
      const found = (await ok('GET', '/api/sessions')).find(x => x.id === id);
      if (!found || found.exited) return found;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`session ${id} never exited`);
  };
  const outputOf = async id => (await ok('GET', `/api/sessions/${id}/output?lines=40`)).text;
  const first = await ok('POST', '/api/sessions', { kind: 'agent', agent: 'claude', project: repo, name: 'Lifecycle chat' });
  await exited(first.id);
  const record = () => db.chats.find(c => c.id === first.chatId);
  assert.match(await outputOf(first.id), new RegExp(`--session-id ${record().claudeSessionId}`), 'a new chat starts with the id we chose');
  assert.match(await outputOf(first.id), /--settings /, 'claude gets the hook that reports its conversation id');
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'hooks', `${first.id}.headers`)), 'the hook secret file is gone once the agent exits');

  const reopened = await ok('POST', `/api/chats/${first.chatId}/open`);
  assert.equal(reopened.replaced, first.id, "reopening a finished chat replaces its pane, it doesn't add a second one");
  assert.ok(!(await ok('GET', '/api/sessions')).some(x => x.id === first.id), 'the finished pane is gone');
  await exited(reopened.session.id);

  // After /clear Claude is on a new conversation; the hook tells us, and the next reopen resumes that one
  const cleared = randomUUID();
  assert.equal((await request('POST', '/api/claude-session', { headers: { 'x-desk-session': 'nobody' }, body: { session_id: cleared } })).status, 404, 'the hook must name a real session');
  await request('POST', '/api/claude-session', { headers: { 'x-desk-session': reopened.session.id }, body: { session_id: '../../etc/passwd' } });
  assert.notEqual(record().claudeSessionId, '../../etc/passwd', 'only real ids are accepted');
  assert.equal((await request('POST', '/api/claude-session', { headers: { 'x-desk-session': reopened.session.id }, body: { session_id: cleared, source: 'clear' } })).status, 200);
  assert.equal(record().claudeSessionId, cleared, 'the chat follows the conversation the pane is on');
  const clearedDir = path.join(claudeHome, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.writeFileSync(path.join(clearedDir, `${cleared}.jsonl`), line({ type: 'user', message: { content: 'after the clear' } }));
  const third = await ok('POST', `/api/chats/${first.chatId}/open`);
  await exited(third.session.id);
  assert.match(await outputOf(third.session.id), new RegExp(`--resume ${cleared}`), 'reopening resumes the conversation after /clear');
  assert.equal((await byId())[first.chatId].title, 'after the clear', "and shows that conversation's title");

  await ok('DELETE', `/api/chats/${first.chatId}`);
  assert.ok(!(await ok('GET', '/api/sessions')).some(x => x.chatId === first.chatId), 'removing a chat also closes its finished pane');

  // Past the limit, the chats used longest ago go first, however old the favourite is
  const now = Date.now();
  db.chats.push(...Array.from({ length: 300 }, (_, i) => ({ ...chat(`filler-${i}`, randomUUID()), lastActiveAt: now - 10_000_000 + i, createdAt: now })));
  db.chats.push({ ...chat('favourite', randomUUID()), createdAt: 1, lastActiveAt: now });
  const newest = await ok('POST', '/api/sessions', { kind: 'agent', agent: 'claude', project: repo });
  await exited(newest.id);
  assert.ok(db.chats.length <= 300, `at most 300 chats are kept (have ${db.chats.length})`);
  assert.ok(db.chats.some(c => c.id === 'favourite'), 'a chat used just now survives the trim');
  assert.ok(!db.chats.some(c => c.id === 'filler-0'), 'the one used longest ago is dropped');
  await ok('DELETE', `/api/sessions/${newest.id}`);

  // Task Notes: bring a task over, then its status there follows the card, onto the day it was carried to
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = ymd(new Date());
  const yesterday = ymd(new Date(Date.now() - 86_400_000));
  const days = [{ date: yesterday, tasks: [
    { id: 'y1', text: 'Fix the login bug', note: 'Users get logged out', status: 'todo', projectId: 'p1' },
    { id: 'y2', text: 'Already done', status: 'done' }] }];
  const patches = [];
  const notes = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (u.pathname === '/api/projects') return send({ projects: [{ id: 'p1', title: 'Auth' }] });
    if (u.pathname === '/api/alldays') {
      const [from, to] = [u.searchParams.get('from') || '0', u.searchParams.get('to') || '9'];
      return send({ days: days.filter(d => d.date >= from && d.date <= to) });
    }
    if (u.pathname === '/api/tasks' && req.method === 'PATCH') {
      let body = '';
      req.on('data', c => (body += c));
      return req.on('end', () => {
        patches.push({ date: u.searchParams.get('date'), id: u.searchParams.get('id'), ...JSON.parse(body), origin: req.headers.origin });
        send({ ok: true });
      });
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise(resolve => notes.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(process.env.TASKNOTES_DATA);
  fs.writeFileSync(path.join(process.env.TASKNOTES_DATA, 'port.json'), JSON.stringify({ port: notes.address().port, pid: process.pid }));
  const until = async (fn, what) => {
    for (let i = 0; i < 60 && !fn(); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(fn(), what);
  };

  const open = await ok('GET', '/api/tasknotes');
  assert.deepEqual(open.map(t => [t.id, t.date, t.project]), [['y1', yesterday, 'Auth']], 'lists open Task Notes tasks with their project');
  const brought = await ok('POST', '/api/tasknotes/import', { id: 'y1', date: yesterday, project: repo });
  assert.equal(brought.title, 'Fix the login bug');
  assert.equal(brought.description, 'Users get logged out');
  assert.equal((await request('POST', '/api/tasknotes/import', { body: { id: 'y1', date: yesterday, project: repo } })).status, 409, 'the same task is not brought over twice');
  assert.equal((await ok('POST', '/api/tasks', { title: 'Sneaky', project: repo, tasknotes: { id: 'y2', date: yesterday } })).tasknotes, null, 'a plain new task cannot claim a Task Notes link');
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(patches, [], 'bringing a task over writes nothing back');

  days.push({ date: today, tasks: [{ id: 't1', srcId: 'y1', carried: true, text: 'Fix the login bug', status: 'todo', projectId: 'p1' }] }); // Task Notes carried it to today
  assert.equal((await ok('GET', '/api/tasknotes'))[0].onBoard, true, "today's copy shows as already on a board");
  await ok('PATCH', `/api/tasks/${brought.id}`, { status: 'doing' });
  await until(() => patches.length === 1, 'moving the card updates Task Notes');
  assert.deepEqual(patches[0], { date: today, id: 't1', status: 'progress', origin: undefined }, "the update lands on today's copy, as a local request");
  await ok('PATCH', `/api/tasks/${brought.id}`, { status: 'review' });
  await ok('PATCH', `/api/tasks/${brought.id}`, { status: 'done' });
  await until(() => patches.length === 2, 'done reaches Task Notes');
  assert.equal(patches[1].status, 'done', 'review is still in progress there, so only done is sent');
  await new Promise(resolve => notes.close(resolve));
  const down = await request('GET', '/api/tasknotes');
  assert.equal(down.status, 503, 'Task Notes being closed is a clear error');
  assert.match(down.body.error, /not running/);

  await ok('DELETE', `/api/sessions/${shell.id}`);
  assert.deepEqual(await ok('GET', '/api/sessions'), [], 'no sessions left');
  console.log('All checks passed');
} finally {
  desk.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
