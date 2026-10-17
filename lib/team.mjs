// The team: named specialists, each a Claude agent with one area of expertise, its own instructions and,
// if you like, a model. Every Claude agent is told who is on the team and what each one is for, so it can
// hand a piece of work to the right one (start_agent with a specialist and a model).
import { randomUUID } from 'node:crypto';
import { db, changed } from './store.mjs';

export const MODELS = ['', 'opus', 'sonnet', 'haiku']; // '' is whatever your Claude Code uses by default
const fail = (status, message) => Object.assign(new Error(message), { status });

export const BUILT_IN = [
  {
    id: 'christie', name: 'Christie', role: 'Learning coach: teaches you anything, step by step', model: '',
    instructions: `You are a patient, encouraging learning coach. Your job is to help the user learn, not to do the work for them.
- Start by finding out what they want to learn, why, and what they already know. Ask one question at a time.
- Teach in small steps. Explain one idea in plain words with a concrete example, then check it landed with a quick question or a tiny exercise before moving on.
- Adapt to their answers: when they're stuck, slow down and try a different example or analogy; when it's easy for them, skip ahead.
- Prefer doing over reading. Give small hands-on exercises, in this folder or a scratch folder, and review what they write. Give hints before answers, and don't write their code for them unless they ask.
- For a bigger topic, agree a short learning plan first and keep track of where they are in it.
- When a lesson is worth keeping, make a clear one-page summary, cheat sheet or diagram as an HTML page and save it with save_artifact, so they can reread it in the Artifacts tab.
- If they ask you to save what they learned to Task Notes, use its tools to add it to their learning bag. Only when they ask.
- Be honest about what you're unsure of, and point to the official docs for depth.`,
  },
  {
    id: 'browner', name: 'Browner', role: 'Frontend and browser expert: HTML, CSS, JavaScript, React, accessibility, speed', model: '',
    instructions: `You are a senior frontend engineer. You know HTML, CSS, JavaScript and TypeScript, React and the other big frameworks, browser APIs, accessibility (WCAG) and web performance deeply.
- Follow the project's existing components, styles and conventions before adding anything new.
- Make interfaces that work with a keyboard and a screen reader, hold up on small screens, and stay fast.
- Check your work in a browser when you can (the project's dev server, or an Agent Desk browser pane), and say what you checked.
- Explain trade-offs briefly when there's a real choice to make.`,
  },
  {
    id: 'scout', name: 'Scout', role: 'Quick code finder: answers "where is" and "how does" questions, changes nothing', model: 'haiku',
    instructions: `You find things in the code fast and cheaply. Answer questions like "where is X handled", "what calls Y" or "how does Z work" by searching and reading the code.
- Don't edit files or run anything that changes state.
- Answer briefly, with file paths and line numbers, and say plainly when you couldn't find something.`,
  },
];

export const list = () => db.specialists ?? BUILT_IN; // the built-ins until you change the team

export function find(ref) {
  const key = String(ref ?? '').trim().toLowerCase();
  return list().find(s => s.id === key || s.name.toLowerCase() === key) ?? null;
}

function clean(input, id) {
  const name = String(input.name ?? '').trim();
  const role = String(input.role ?? '').trim();
  const model = String(input.model ?? '');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .'-]{0,29}$/u.test(name)) throw fail(400, 'A name is 1 to 30 letters, numbers or spaces');
  if (list().some(s => s.id !== id && s.name.toLowerCase() === name.toLowerCase())) throw fail(409, `There's already a ${name} on the team`);
  if (!role || role.length > 120) throw fail(400, 'Say in a line what they are good at (up to 120 characters)');
  if (!MODELS.includes(model)) throw fail(400, `The model is one of: default, ${MODELS.filter(Boolean).join(', ')}`);
  return { name, role, model, instructions: String(input.instructions ?? '').trim().slice(0, 6000) };
}

export function add(input) {
  const s = { id: randomUUID().slice(0, 8), ...clean(input) };
  db.specialists = [...list(), s];
  changed('specialists');
  return s;
}

export function update(id, input) {
  const current = list().find(s => s.id === id) ?? (() => { throw fail(404, 'No such specialist'); })();
  const s = { ...current, ...clean({ ...current, ...input }, id) };
  db.specialists = list().map(x => (x.id === id ? s : x));
  changed('specialists');
  return s;
}

export function remove(id) {
  if (!list().some(s => s.id === id)) throw fail(404, 'No such specialist');
  db.specialists = list().filter(s => s.id !== id);
  changed('specialists');
}

// What every Claude agent is told about the team.
export function brief(me) {
  const lines = list().map(s => `- ${s.name}${s.id === me?.id ? ' (you)' : ''}: ${s.role}. Model: ${s.model || 'default'}.`);
  const spawn = db.settings.agentsCanSpawn !== false
    ? 'To hand someone a piece of work, use start_agent (or start_task for a board task) with their name as specialist, a clear self-contained prompt, and a model if the job suits one: haiku for quick, simple jobs, sonnet for everyday work, opus for the hardest. Use list_agents to see who is running now and what each was asked, and read_agent_output to see how they are getting on, so you don\'t repeat work someone else is doing.'
    : 'Starting other agents is turned off in Agent Desk\'s settings, so don\'t try. If someone else on the team would suit a job better, tell the user who. You can still see who is running with list_agents.';
  return `The team in Agent Desk:\n${lines.join('\n')}\n${spawn}`;
}
