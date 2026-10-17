// Everything Agent Desk remembers between runs: projects, tasks, worktrees and settings, in one JSON file.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Emits 'event' with { type: 'projects' | 'tasks' | 'settings' | 'sessions' | 'voice', ...details }; pages refetch on it.
export const bus = new EventEmitter();

const DEFAULTS = {
  projects: [], // { path, name, addedAt, repos? }: repos are other git repos this project's agents changed
  tasks: [],
  chats: [], // every agent conversation, kept after it stops so it can be resumed
  artifacts: [], // pages and reports agents saved; the HTML itself is in <data>/artifacts
  messages: [], // the last 500 messages between agents, for the Graph: { at, project, fromId, fromName, toId, toName, via } (never the text)
  groups: [], // named groups on the Graph: { id, project, name, color, members: [chatId, or session id for shells] }
  worktrees: {}, // worktree path -> { root, branch, base, taskId, by?, from? } (by and from: a worktree an agent made itself)
  settings: {
    theme: 'midnight',
    accent: '',
    fontSize: 13,
    defaultAgent: 'claude',
    permissionMode: 'default',
    worktreeByDefault: true,
    voiceLang: 'en-US',
    fancyCursor: true,
    lastProject: '',
    browserPanes: {}, // project path -> [{ id, url }]
    pages: null, // { account, repo } last published to on GitHub Pages
    agentsCanSpawn: true, // agents may start other agents (start_agent, start_task)
    agentsCanMessage: true, // agents may message each other (message_agent)
    agentsCanEditTeam: true, // agents may edit a specialist's profile when you ask (update_specialist)
    agentsAutonomous: true, // they message and copy each other without asking you each time
    agentDefaults: { claude: { model: '', effort: '' }, lead: { model: 'opus', effort: 'high' } }, // '' = your Claude Code's own
    scrollSpeed: 1, // terminal scrolling, times how far the trackpad moved
    sidebarHidden: false,
  },
};

let file;
export let db = structuredClone(DEFAULTS);

export function load(dataDir) {
  file = path.join(dataDir, 'desk.json');
  if (!fs.existsSync(file)) return;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  db = { ...structuredClone(DEFAULTS), ...saved, settings: { ...DEFAULTS.settings, ...saved.settings } };
}

// Save, then tell every open page what changed.
export function changed(kind) {
  if (kind !== 'sessions' && file) {
    // Write a temp file and rename it, so a crash mid-write can't wipe the data.
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(db, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  }
  bus.emit('event', { type: kind });
}
