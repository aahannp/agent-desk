// Git worktrees for agents, and the change review that happens before their work is merged.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { db, changed } from './store.mjs';

export const git = (cwd, ...args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || stdout || err.message).trim()));
    else resolve(stdout);
  });
});

export const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'task';

export async function repoRoot(dir) {
  return (await git(dir, 'rev-parse', '--show-toplevel').catch(() => '')).trim() || null;
}

const commonDir = async dir => path.resolve(dir, (await git(dir, 'rev-parse', '--git-common-dir')).trim());
const branchOf = async dir => (await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();

// The folder every worktree of a repo was made from: the parent of their shared .git folder.
async function mainFolder(dir) {
  const common = await commonDir(dir).catch(() => '');
  return path.basename(common) === '.git' ? path.dirname(common) : null;
}

// Keep Agent Desk's own folder (worktrees, screenshots) out of the project's git status, without touching .gitignore.
export async function excludeDeskFolder(root) {
  const common = await commonDir(root);
  const exclude = path.join(common, 'info', 'exclude');
  const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes('.agent-desk/')) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.agent-desk/\n`);
  }
}

export async function createWorktree(dir, name, taskId = null) {
  const root = await repoRoot(dir);
  if (!root) throw new Error(`${dir} is not a git repository, so the agent can't get its own worktree`);
  await excludeDeskFolder(root);
  const base = await branchOf(root);
  const id = `${slug(name)}-${Date.now().toString(36).slice(-4)}`;
  const branch = `desk/${id}`;
  const wt = path.join(root, '.agent-desk', 'worktrees', id);
  await git(root, 'worktree', 'add', '-b', branch, wt, 'HEAD');
  db.worktrees[wt] = { root, branch, base, taskId };
  changed('tasks');
  return { path: wt, branch, base, root };
}

async function listWorktrees(root) {
  const out = await git(root, 'worktree', 'list', '--porcelain');
  return out.trim().split('\n\n').map(block => {
    const wt = {};
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      wt[key] = rest.join(' ');
    }
    return { path: wt.worktree, branch: wt.branch?.replace('refs/heads/', '') ?? '(detached)', bare: 'bare' in wt };
  }).filter(w => !w.bare);
}

// Agent Desk's record of a worktree. One made some other way (an agent's own `git worktree add`) is taken to
// come from the branch the main folder is on. Null for the main folder.
async function worktreeMeta(wtPath) {
  if (db.worktrees[wtPath]) return db.worktrees[wtPath];
  const root = await mainFolder(wtPath);
  if (!root || path.resolve(root) === path.resolve(wtPath)) return null;
  const branch = await branchOf(wtPath);
  return { root, branch: branch === 'HEAD' ? '(detached)' : branch, base: await branchOf(root), taskId: null };
}

// An agent edited this file. If it's in a git repo, returns the repo's main folder, and records a worktree
// Agent Desk didn't make (added: true), so Review shows who made it and can merge it. Null outside a repo.
export async function touched(file, from) {
  if (!path.isAbsolute(file)) return null;
  const top = await repoRoot(path.dirname(file));
  const main = top && await mainFolder(top);
  if (!main) return null;
  if (db.worktrees[top] || path.resolve(top) === path.resolve(main)) return { main, added: false };
  db.worktrees[top] = { ...await worktreeMeta(top), taskId: from?.taskId ?? null, by: from?.name ?? null, from: from?.project ?? null };
  return { main, added: true };
}

// What the worktree is compared against: where it branched off its base, or HEAD for the main folder.
// Its base's upstream counts too, so a main folder that hasn't pulled doesn't show merged work as the agent's.
async function compareRef(wtPath) {
  const meta = await worktreeMeta(wtPath);
  if (!meta) return { ref: 'HEAD', base: null, meta: null };
  const upstream = (await git(wtPath, 'rev-parse', '--abbrev-ref', `${meta.base}@{upstream}`).catch(() => '')).trim();
  const ref = (await git(wtPath, 'merge-base', 'HEAD', meta.base, ...(upstream ? [upstream] : [])).catch(() => 'HEAD')).trim();
  return { ref, base: meta.base, meta };
}

async function changes(wtPath, ref) {
  const files = new Map();
  for (const line of (await git(wtPath, 'diff', '--no-renames', '--name-status', ref)).split('\n').filter(Boolean)) {
    const [status, file] = line.split('\t');
    files.set(file, { path: file, status, add: 0, del: 0 });
  }
  for (const line of (await git(wtPath, 'diff', '--no-renames', '--numstat', ref)).split('\n').filter(Boolean)) {
    const [add, del, file] = line.split('\t');
    if (files.has(file)) Object.assign(files.get(file), { add: Number(add) || 0, del: Number(del) || 0 });
  }
  for (const file of (await git(wtPath, 'ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean)) {
    const full = path.join(wtPath, file);
    const stat = fs.statSync(full, { throwIfNoEntry: false }); // a symlink to a folder (node_modules) has no lines
    const lines = stat?.isFile() && stat.size < 1_000_000 ? fs.readFileSync(full, 'utf8').split('\n').length : 0;
    files.set(file, { path: file, status: 'A', add: lines, del: 0, untracked: true });
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function review(project) {
  const root = await repoRoot(project);
  if (!root) return { git: false, items: [] };
  const items = [];
  for (const wt of await listWorktrees(root)) {
    const { ref, base, meta } = await compareRef(wt.path);
    const files = await changes(wt.path, ref).catch(() => []);
    const main = path.resolve(wt.path) === path.resolve(root);
    items.push({
      path: wt.path, branch: wt.branch, base, main, taskId: meta?.taskId ?? null, by: meta?.by ?? null, files,
      add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0),
    });
  }
  return { git: true, root, items: items.sort((a, b) => b.main - a.main) };
}

export async function fileVersions(wtPath, file) {
  const { ref } = await compareRef(wtPath);
  const original = await git(wtPath, 'show', `${ref}:${file}`).catch(() => '');
  const full = path.join(wtPath, file);
  const modified = fs.statSync(full, { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(full, 'utf8') : '';
  return { original, modified };
}

// A plain-text diff for agents to read, new files included.
export async function diffText(wtPath, limit = 40_000) {
  const { ref } = await compareRef(wtPath);
  let text = await git(wtPath, 'diff', ref);
  for (const file of (await git(wtPath, 'ls-files', '--others', '--exclude-standard')).split('\n').filter(Boolean)) {
    // `diff --no-index` exits 1 whenever the files differ, so the diff arrives as the "error".
    text += await git(wtPath, 'diff', '--no-index', '--', '/dev/null', file).catch(e => `${e.message}\n`);
  }
  return text.length > limit ? `${text.slice(0, limit)}\n… (diff cut at ${limit} characters)` : text || 'No changes.';
}

export async function commit(wtPath, message) {
  await git(wtPath, 'add', '-A');
  const status = await git(wtPath, 'status', '--porcelain');
  if (!status.trim()) return { committed: false };
  await git(wtPath, 'commit', '-m', message);
  return { committed: true };
}

export async function merge(wtPath) {
  const meta = await worktreeMeta(wtPath);
  if (!meta) throw new Error('Only worktrees can be merged, not the main folder');
  if (meta.branch === '(detached)') throw new Error("This worktree isn't on a branch (detached HEAD), so there is nothing to merge. Make one in it first: git switch -c <name>");
  if ((await git(wtPath, 'status', '--porcelain')).trim()) throw new Error('This worktree has uncommitted changes. Commit them first.');
  const current = await branchOf(meta.root);
  if (current !== meta.base) throw new Error(`The main folder is on "${current}", not "${meta.base}". Switch it back before merging.`);
  try {
    await git(meta.root, 'merge', '--no-ff', '--no-edit', meta.branch);
  } catch (e) {
    await git(meta.root, 'merge', '--abort').catch(() => {});
    throw new Error(`Merge stopped because of conflicts, nothing was changed. Resolve it in a shell with: git merge ${meta.branch}\n\n${e.message}`);
  }
  return meta;
}

export async function removeWorktree(wtPath) {
  const meta = await worktreeMeta(wtPath);
  if (!meta) throw new Error('Only worktrees can be removed here, not the main folder');
  await git(meta.root, 'worktree', 'remove', '--force', wtPath);
  await git(meta.root, 'branch', '-D', meta.branch).catch(() => {});
  delete db.worktrees[wtPath];
  changed('tasks');
  return meta;
}
