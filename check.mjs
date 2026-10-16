// Smoke check for the server: security, a shell with command blocks, the task board, worktree review and
// merge, and the MCP tools. Uses a throwaway data folder and git repo, never your real ones.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import WebSocket from 'ws';
import { start } from './server.mjs';
import { createWorktree } from './lib/git.mjs';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-desk-check-')));
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
const sh = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
sh('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
sh('add', '.');
sh('-c', 'user.name=check', '-c', 'user.email=check@example.com', 'commit', '-qm', 'first');

const desk = await start({ port: 0, dataDir: path.join(tmp, 'data') });
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

  // MCP server: handshake, tool list, and a real tool call against this server
  const mcp = spawn(process.execPath, ['mcp.mjs'], { cwd: import.meta.dirname, env: { ...process.env, AGENT_DESK_URL: SELF, AGENT_DESK_TOKEN: desk.token } });
  const replies = readline.createInterface({ input: mcp.stdout });
  const pending = new Map();
  replies.on('line', line => { const m = JSON.parse(line); pending.get(m.id)?.(m); });
  let nextId = 1;
  const rpc = (method, params) => new Promise(resolve => {
    const id = nextId++;
    pending.set(id, resolve);
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } })).result.serverInfo.name, 'agent-desk');
  const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name);
  assert.equal(tools.length, 12, `12 MCP tools, got ${tools.join(', ')}`);
  const listed = await rpc('tools/call', { name: 'list_tasks', arguments: {} });
  assert.match(listed.result.content[0].text, /Add a greeting/, 'MCP list_tasks reads the board');
  const agents = await rpc('tools/call', { name: 'list_agents', arguments: {} });
  assert.match(agents.result.content[0].text, new RegExp(shell.id), 'MCP list_agents sees the shell');
  mcp.kill();

  await ok('DELETE', `/api/sessions/${shell.id}`);
  assert.deepEqual(await ok('GET', '/api/sessions'), [], 'no sessions left');
  console.log('All checks passed');
} finally {
  desk.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(0);
