// Everything Agent Desk remembers between runs: projects, tasks, worktrees and settings, in one JSON file.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Emits 'event' with { type: 'projects' | 'tasks' | 'settings' | 'sessions' | 'voice', ...details }; pages refetch on it.
export const bus = new EventEmitter();

const DEFAULTS = {
  projects: [],
  tasks: [],
  chats: [], // every agent conversation, kept after it stops so it can be resumed
  worktrees: {}, // worktree path -> { root, branch, base, taskId }
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
