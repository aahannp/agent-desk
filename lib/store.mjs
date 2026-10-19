// Everything Relay remembers between runs: projects, tasks, worktrees and settings, in one JSON file.
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
  artifactFolders: [], // names of the Artifacts tab's folders, in order; a page's folder is its `folder` (none = Unfiled)
  messages: [], // the last 500 messages between agents, for the Graph: { at, project, fromId, fromName, toId, toName, via } (never the text)
  groups: [], // named groups on the Graph: { id, project, name, color, members: [chatId, or session id for shells] }
  workersOnSonnet: true, // see load
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
    agentDefaults: { claude: { model: 'sonnet', effort: '' }, lead: { model: 'opus', effort: 'high' } }, // workers on Sonnet; '' = your Claude Code's own
    // Compact a lead at compactAt % of its window (at most windowCap tokens), and replace it after replaceAfter compactions.
    leadUpkeep: { on: false, compactAt: 70, windowCap: 200_000, replaceAfter: 3 },
    scrollSpeed: 1, // terminal scrolling, times how far the trackpad moved
    sidebarHidden: false,
    mixFolders: false, // the Agents grid shows every project's panes, not just the current one's
  },
};

let file;
export let db = structuredClone(DEFAULTS);

export function load(dataDir) {
  file = path.join(dataDir, 'desk.json');
  if (!fs.existsSync(file)) return;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  db = { ...structuredClone(DEFAULTS), ...saved, settings: { ...DEFAULTS.settings, ...saved.settings } };
  // Workers moved to Sonnet by default (Opus re-reading context was most of the spend). Once, for the old
  // '' default saved before that; a model you pick in Settings afterwards stays.
  if (!saved.workersOnSonnet && db.settings.agentDefaults?.claude?.model === '') db.settings.agentDefaults.claude.model = 'sonnet';
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
