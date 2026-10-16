// Agent Desk's MCP server: lets Claude Code (inside Agent Desk, or your own terminal) read and drive the
// shared task board and the other agents. Speaks MCP over stdio: one JSON-RPC message per line.
import readline from 'node:readline';

const BASE = process.env.AGENT_DESK_URL || 'http://127.0.0.1:4747';
const TOKEN = process.env.AGENT_DESK_TOKEN || '';
const SESSION = process.env.AGENT_DESK_SESSION || '';

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-desk-token': TOKEN, 'x-desk-session': SESSION },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Agent Desk answered ${res.status}`);
  return data;
}

const me = async () => SESSION ? (await api('GET', '/api/sessions')).find(s => s.id === SESSION) : null;
const myTaskId = async id => id || (await me())?.taskId || (() => { throw new Error('Give a task id (this session is not working on a task)'); })();
const q = encodeURIComponent;

const str = description => ({ type: 'string', description });
const tool = (name, description, properties, required, run) => ({ name, description, inputSchema: { type: 'object', properties, required }, run });

const TOOLS = [
  tool('get_project', 'The project folder, and which session and task you are, if any.', {}, [], async () => {
    const self = await me();
    return { project: self?.project ?? null, you: self ?? 'not an Agent Desk session' };
  }),
  tool('list_tasks', 'List tasks on the board, optionally only one status.', {
    status: { type: 'string', enum: ['todo', 'doing', 'review', 'done'] },
  }, [], async ({ status }) => {
    const tasks = await api('GET', '/api/tasks');
    return tasks.filter(t => !status || t.status === status)
      .map(({ id, title, status, agent, branch, sessionId, notes }) => ({ id, title, status, agent, branch, sessionId, comments: notes.length }));
  }),
  tool('create_task', 'Add a task to the To do column. Make the description self-contained: goal, files, how to check it works.', {
    title: str('Short title'), description: str('What to do, in detail'),
    agent: { type: 'string', enum: ['claude', 'codex', 'gemini', 'cursor'] },
  }, ['title'], args => api('POST', '/api/tasks', args)),
  tool('update_task', 'Change a task\'s status, title or description. Leave id out to update your own task.', {
    id: str('Task id'), status: { type: 'string', enum: ['todo', 'doing', 'review', 'done'] }, title: str('New title'), description: str('New description'),
  }, [], async ({ id, ...changes }) => api('PATCH', `/api/tasks/${q(await myTaskId(id))}`, changes)),
  tool('comment_on_task', 'Post a progress note or summary on a task. Leave id out to comment on your own task.', {
    id: str('Task id'), text: str('The comment'),
  }, ['text'], async ({ id, text }) => api('POST', `/api/tasks/${q(await myTaskId(id))}/comments`, { text })),
  tool('start_task', 'Start a worker agent on a task. By default it gets its own git worktree.', {
    id: str('Task id'), agent: { type: 'string', enum: ['claude', 'codex', 'gemini', 'cursor'] }, worktree: { type: 'boolean' },
  }, ['id'], ({ id, ...opts }) => api('POST', `/api/tasks/${q(id)}/start`, opts)),
  tool('start_agent', 'Start a new agent session with a first message (not tied to a task).', {
    prompt: str('First message for the agent'), name: str('Pane title'),
    agent: { type: 'string', enum: ['claude', 'codex', 'gemini', 'cursor'] }, worktree: { type: 'boolean' },
  }, ['prompt'], args => api('POST', '/api/sessions', { kind: 'agent', ...args })),
  tool('list_agents', 'List running agents and shells with their status: working, idle, needs-input or exited.', {}, [], async () =>
    (await api('GET', '/api/sessions')).map(({ id, name, agent, kind, role, status, taskId, worktree }) =>
      ({ id, name, agent: agent || kind, role, status, taskId, branch: worktree?.branch ?? null }))),
  tool('read_agent_output', 'Read the last lines of another agent\'s terminal screen.', {
    id: str('Session id'), lines: { type: 'number', description: 'How many lines (default 60, max 500)' },
  }, ['id'], async ({ id, lines = 60 }) => (await api('GET', `/api/sessions/${q(id)}/output?lines=${lines}`)).text),
  tool('send_to_agent', 'Type a message into another agent\'s terminal and press Enter.', {
    id: str('Session id'), text: str('What to type'),
  }, ['id', 'text'], ({ id, text }) => api('POST', `/api/sessions/${q(id)}/input`, { text })),
  tool('stop_agent', 'Stop an agent session and close its pane.', { id: str('Session id') }, ['id'],
    ({ id }) => api('DELETE', `/api/sessions/${q(id)}`)),
  tool('get_agent_diff', 'See what an agent changed in its worktree, as a diff against where it branched.', {
    id: str('Session id'),
  }, ['id'], async ({ id }) => {
    const s = (await api('GET', '/api/sessions')).find(x => x.id === id);
    if (!s) throw new Error('No such session');
    return (await api('GET', `/api/review/diff?worktree=${q(s.cwd)}`)).text;
  }),
];

const send = msg => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notifications need no answer
  if (method === 'initialize') {
    return send({ id, result: {
      protocolVersion: params.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-desk', version: '1.0.0' },
    } });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'tools/list') return send({ id, result: { tools: TOOLS.map(({ run, ...t }) => t) } });
  if (method === 'tools/call') {
    const t = TOOLS.find(x => x.name === params.name);
    if (!t) return send({ id, error: { code: -32602, message: `Unknown tool ${params.name}` } });
    try {
      const out = await t.run(params.arguments || {});
      return send({ id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] } });
    } catch (e) {
      return send({ id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
    }
  }
  send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});
