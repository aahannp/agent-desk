// Smoke check: starts the server, runs a shell through it, and confirms other websites are refused.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import WebSocket from 'ws';

const PORT = 4399;
const SELF = `http://127.0.0.1:${PORT}`;
const EVIL = 'https://evil.example';

function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data && JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body && JSON.stringify(body));
  });
}

const server = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, env: { ...process.env, PORT } });
await new Promise((resolve, reject) => {
  server.stdout.once('data', resolve);
  server.once('exit', () => reject(new Error('server exited before it started')));
});

try {
  const created = await request('POST', '/api/sessions', { headers: { origin: SELF }, body: { kind: 'shell', cwd: os.tmpdir() } });
  assert.equal(created.status, 201, 'shell session is created');
  const { id } = created.body;

  const output = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?id=${id}`, { origin: SELF });
    let seen = '';
    const timer = setTimeout(() => reject(new Error(`no shell output, got: ${seen.slice(-300)}`)), 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'in', d: 'echo ok-$((6*7))\r' })));
    ws.on('message', data => {
      seen += data;
      if (seen.includes('ok-42')) { clearTimeout(timer); ws.close(); resolve(seen); }
    });
  });
  assert.ok(output.includes('ok-42'), 'typed command runs in the shell');

  const evilSocket = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?id=${id}`, { origin: EVIL });
    ws.on('open', () => resolve('opened'));
    ws.on('error', () => resolve('refused'));
  });
  assert.equal(evilSocket, 'refused', 'websocket from another website is refused');

  assert.equal((await request('GET', '/api/sessions', { headers: { host: `evil.example:${PORT}` } })).status, 403, 'DNS-rebinding host is refused');
  assert.equal((await request('PUT', '/api/tasks', { headers: { origin: EVIL }, body: [] })).status, 403, 'task write from another website is refused');
  assert.equal((await request('POST', '/api/sessions', { headers: { origin: SELF }, body: { kind: 'shell', cwd: '/no/such/folder' } })).status, 400, 'missing folder is rejected');

  assert.equal((await request('DELETE', `/api/sessions/${id}`, { headers: { origin: SELF } })).status, 200, 'session is stopped');
  assert.deepEqual((await request('GET', '/api/sessions')).body, [], 'no sessions left');
  console.log('All checks passed');
} finally {
  server.kill();
}
