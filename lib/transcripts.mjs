// Reads Claude Code's own saved conversations (~/.claude/projects/<folder>/<session id>.jsonl), read-only,
// so Agent Desk can show a chat's title and know whether `claude --resume` will find it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HEAD_BYTES = 1024 * 1024; // titles and the first message sit near the start of the file
const projectsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const folderName = dir => dir.replace(/[^a-zA-Z0-9]/g, '-'); // how Claude Code names a project's folder

const found = new Map(); // session id -> transcript file
const missing = new Map(); // session id -> when we last looked and didn't find it

// `fresh` skips the remembered misses: opening a chat must know right now whether Claude has saved it.
export function transcriptFile(sessionId, cwd, { fresh = false } = {}) {
  if (!sessionId) return null;
  const known = found.get(sessionId);
  if (known && fs.existsSync(known)) return known;
  if (!fresh && Date.now() - (missing.get(sessionId) ?? 0) < 10_000) return null;
  const real = (() => { try { return fs.realpathSync(cwd); } catch { return cwd; } })();
  const direct = [cwd, real].map(dir => path.join(projectsDir(), folderName(dir), `${sessionId}.jsonl`));
  // Claude shortens very long folder names, so fall back to looking in every project folder.
  // ponytail: one stat per project folder, with misses remembered for 10s
  const candidates = () => {
    try { return fs.readdirSync(projectsDir()).map(d => path.join(projectsDir(), d, `${sessionId}.jsonl`)); } catch { return []; }
  };
  const file = direct.find(f => fs.existsSync(f)) ?? candidates().find(f => fs.existsSync(f)) ?? null;
  if (file) found.set(sessionId, file);
  else missing.set(sessionId, Date.now());
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
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(Math.min(stat.size, HEAD_BYTES));
  fs.readSync(fd, buffer, 0, buffer.length, 0);
  fs.closeSync(fd);
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
