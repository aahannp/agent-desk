// Agent Desk's MCP tools: they let Claude Code (inside Agent Desk, or in your own terminal) read and drive
// the shared task board and the other agents. Served over HTTP at /mcp ("streamable HTTP" with plain JSON
// answers), so no extra process is needed. The tools call this server's own API as the agent that asked.

export function mcpTools({ api, session }) {
  const me = async () => (session ? (await api('GET', '/api/sessions')).find(s => s.id === session) : null);
  const myTaskId = async id => id || (await me())?.taskId || (() => { throw new Error('Give a task id (this session is not working on a task)'); })();
  const q = encodeURIComponent;

  const str = description => ({ type: 'string', description });
  const MODEL = { type: 'string', enum: ['opus', 'sonnet', 'haiku'], description: 'Claude model: haiku for quick simple jobs, sonnet for everyday work, opus for the hardest. Leave out for the specialist\'s own model.' };
  const SPECIALIST = str('Name of a specialist from list_team to do it (they always run as Claude)');
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
    }, ['title'], ({ title, description, agent }) => api('POST', '/api/tasks', { title, description, agent })),
    tool('update_task', 'Change a task\'s status, title or description. Leave id out to update your own task.', {
      id: str('Task id'), status: { type: 'string', enum: ['todo', 'doing', 'review', 'done'] }, title: str('New title'), description: str('New description'),
    }, [], async ({ id, ...changes }) => api('PATCH', `/api/tasks/${q(await myTaskId(id))}`, changes)),
    tool('comment_on_task', 'Post a progress note or summary on a task. Leave id out to comment on your own task.', {
      id: str('Task id'), text: str('The comment'),
    }, ['text'], async ({ id, text }) => api('POST', `/api/tasks/${q(await myTaskId(id))}/comments`, { text })),
    tool('start_task', 'Start a worker agent on a task, optionally a specialist from the team and a model. By default it gets its own git worktree.', {
      id: str('Task id'), agent: { type: 'string', enum: ['claude', 'codex', 'gemini', 'cursor'] }, worktree: { type: 'boolean' },
      specialist: SPECIALIST, model: MODEL,
    }, ['id'], ({ id, agent, worktree, specialist, model }) => api('POST', `/api/tasks/${q(id)}/start`, { agent, worktree, specialist, model })),
    tool('start_agent', 'Start a new agent with a first message, optionally a specialist from the team and a model. Give it a self-contained prompt: it can\'t see your conversation.', {
      prompt: str('First message for the agent'), name: str('Pane title'),
      agent: { type: 'string', enum: ['claude', 'codex', 'gemini', 'cursor'] }, worktree: { type: 'boolean' },
      specialist: SPECIALIST, model: MODEL,
    }, ['prompt'], ({ prompt, name, agent, worktree, specialist, model }) =>
      api('POST', '/api/sessions', { prompt, name, agent, worktree, specialist, model, kind: 'agent' })), // Settings can turn this off
    tool('list_team', 'Who is on the team: each specialist\'s name, what they are good at, their model, and how many of them are running now.', {}, [], async () => {
      const running = (await api('GET', '/api/sessions')).filter(s => !s.exited);
      return (await api('GET', '/api/specialists')).map(({ id, name, role, model }) =>
        ({ name, goodAt: role, model: model || 'default', runningNow: running.filter(s => s.specialist?.id === id).length }));
    }),
    tool('list_agents', 'List the agents and shells with who they are, what each was asked, and their status: working, idle, needs-input or exited.', {}, [], async () =>
      (await api('GET', '/api/sessions')).map(({ id, name, agent, kind, role, status, taskId, worktree, specialist, model, asked }) =>
        ({ id, name, agent: agent || kind, specialist: specialist ? `${specialist.name}, ${specialist.role}` : null, model: model || null,
          role, status, taskId, branch: worktree?.branch ?? null, asked: asked || null }))),
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
    tool('save_artifact', 'Save a page, report, chart or other visual you made for the user as one HTML file. It shows in Agent Desk\'s Artifacts tab, where they can view it, open it in a browser and publish it. Pass the HTML, or the path of an .html file you wrote. Pass id to replace one you saved before.', {
      title: str('Short name for it'), html: str('The complete HTML document'),
      file: str('Path of an .html file to save instead of html, relative to your folder'), id: str('Id of an artifact you saved before, to replace it'),
    }, ['title'], args => api('POST', '/api/artifacts', args)),
  ];
  return TOOLS;
}

// Answers one JSON-RPC message. Returns null for notifications, which need no answer.
export async function handleMcp(msg, tools) {
  const { id, method, params = {} } = msg || {};
  if (id === undefined || id === null) return null;
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') {
    return reply({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-desk', version: '1.0.0' } });
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: tools.map(({ run, ...t }) => t) });
  if (method === 'tools/call') {
    const t = tools.find(x => x.name === params.name);
    if (!t) return error(-32602, `Unknown tool ${params.name}`);
    try {
      const out = await t.run(params.arguments || {});
      return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
    } catch (e) {
      return reply({ content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return error(-32601, `Method not found: ${method}`);
}
