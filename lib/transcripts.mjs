// Reads Claude Code's own saved conversations (~/.claude/projects/<folder>/<session id>.jsonl), read-only,
// so Agent Desk can show a chat's title and know whether `claude --resume` will find it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HEAD_BYTES = 1024 * 1024; // titles and the first message sit near the start of the file
const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const folderName = dir => dir.replace(/[^a-zA-Z0-9]/g, '-'); // how Claude Code names a project's folder

const found = new Map(); // session id -> transcript file
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Listing chats only looks in the folder Claude names after the chat's directory (two stats). `scan` also
// looks in every project folder, because Claude shortens very long folder names; opening a chat uses it.
// ponytail: a chat in a very long path shows its pane name, not Claude's title, until it is opened once
export function transcriptFile(sessionId, cwd, { scan = false } = {}) {
  if (!UUID.test(String(sessionId))) return null; // it becomes part of a path
  const known = found.get(sessionId);
  if (known && fs.existsSync(known)) return known;
  const real = (() => { try { return fs.realpathSync(cwd); } catch { return cwd; } })();
  const direct = [cwd, real].map(dir => path.join(projectsDir(), folderName(dir), `${sessionId}.jsonl`));
  const everywhere = () => {
    try { return fs.readdirSync(projectsDir()).map(d => path.join(projectsDir(), d, `${sessionId}.jsonl`)); } catch { return []; }
  };
  const file = direct.find(f => fs.existsSync(f)) ?? (scan ? everywhere().find(f => fs.existsSync(f)) : null) ?? null;
  if (file) found.set(sessionId, file);
  return file;
}

// What you typed, minus the wrappers Claude Code adds around commands and reminders.
const typedText = content => {
  const blocks = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text) : [];
  return blocks.find(t => t && !/^\s*(<|Caveat:)/.test(t)) ?? null;
};

const titles = new Map(); // file -> { mtime, title }
export function transcriptTitle(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const cached = titles.get(file);
  if (cached?.mtime === stat.mtimeMs) return cached.title;
  const buffer = Buffer.alloc(Math.min(stat.size, HEAD_BYTES));
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, 0);
  } catch {
    return null; // unreadable: show the chat's own name instead
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  let named = null;
  let first = null;
  for (const line of buffer.toString('utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    named = entry.customTitle || entry.aiTitle || (entry.type === 'summary' && entry.summary) || named;
    if (!first && entry.type === 'user' && !entry.isSidechain) first = typedText(entry.message?.content);
  }
  const title = (named || first || '').replace(/\s+/g, ' ').trim().slice(0, 90) || null;
  titles.set(file, { mtime: stat.mtimeMs, title });
  return title;
}
