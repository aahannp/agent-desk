// Artifacts: the pages, reports and visuals your agents make, kept as single HTML files so you can view
// them here, open them in your browser, and publish them to GitHub Pages. Agents can save artifacts;
// only you can publish one (there's no MCP tool for it), because publishing puts it on the internet.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { db, changed } from './store.mjs';

const MAX = 10 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{22}$/; // 128 random bits: an artifact's address is also its key, see /a/:id
const fail = (status, message) => Object.assign(new Error(message), { status });

let dir = '';
export function setDir(dataDir) {
  dir = path.join(dataDir, 'artifacts');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
const fileOf = id => path.join(dir, `${id}.html`);
export const find = id => (ID.test(String(id)) && db.artifacts.find(a => a.id === id)) || null;
export const read = a => fs.readFileSync(fileOf(a.id));

// Save a new artifact, or a new version of one when `id` names an existing artifact.
export function save({ id, title, html, project, by }) {
  if (typeof html !== 'string' || !html.trim()) throw fail(400, 'An artifact needs some HTML');
  if (Buffer.byteLength(html) > MAX) throw fail(413, 'Artifacts can be up to 10 MB');
  const now = Date.now();
  let a = id ? find(id) : null;
  if (id && !a) throw fail(404, 'No such artifact');
  if (!a) {
    a = { id: randomBytes(16).toString('base64url'), title: '', project, by, createdAt: now, published: null };
    db.artifacts.unshift(a);
  }
  a.title = String(title || a.title || 'Untitled').trim().slice(0, 120);
  a.updatedAt = now;
  fs.writeFileSync(`${fileOf(a.id)}.tmp`, html, { mode: 0o600 });
  fs.renameSync(`${fileOf(a.id)}.tmp`, fileOf(a.id));
  changed('artifacts');
  return a;
}

export function remove(a) {
  fs.rmSync(fileOf(a.id), { force: true });
  db.artifacts = db.artifacts.filter(x => x.id !== a.id);
  changed('artifacts');
}

// ---------- GitHub Pages ----------
// Uses the accounts you're signed in to with the GitHub CLI (gh), so there's nothing to set up here.
const API = () => process.env.AGENT_DESK_GITHUB_API || 'https://api.github.com';
const gh = args => new Promise((resolve, reject) => execFile('gh', args, { timeout: 15_000 }, (e, out, err) =>
  e ? reject(fail(e.code === 'ENOENT' ? 400 : 502, e.code === 'ENOENT' ? 'Install the GitHub CLI (gh) and run gh auth login first' : String(err || e.message).trim())) : resolve(out)));

export async function accounts() {
  const { hosts } = JSON.parse(await gh(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts']));
  return (hosts['github.com'] ?? []).filter(a => a.state === 'success').map(a => ({ login: a.login, active: a.active }));
}

async function github(token, method, url, body) {
  const res = await fetch(API() + url, {
    method, signal: AbortSignal.timeout(20_000), body: body && JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'agent-desk' },
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch {}
  return { status: res.status, body: json };
}
const must = (r, what) => {
  if (r.status >= 300) throw fail(502, `GitHub refused to ${what}: ${r.body.message || r.status}`);
  return r.body;
};

const MARKER = '.agent-desk';
export const slugOf = title => String(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';

// Puts the artifact at https://<account>.github.io/<repo>/<slug>/. The repo is made for this the first
// time, and Agent Desk only ever writes to repos it made, so a typo can't touch one of your projects.
export async function publish(a, { account, repo, slug }) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw fail(400, 'Repo names use letters, numbers, dots, dashes and underscores');
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(slug)) throw fail(400, 'The page name uses lowercase letters, numbers and dashes');
  if (!(await accounts()).some(x => x.login === account)) throw fail(400, `${account} isn't signed in to the GitHub CLI`);
  const token = (await gh(['auth', 'token', '--hostname', 'github.com', '--user', account])).trim();
  const at = `/repos/${account}/${repo}`;
  const put = async (file, content, message, branch) => {
    const current = await github(token, 'GET', `${at}/contents/${file}?ref=${encodeURIComponent(branch)}`);
    must(await github(token, 'PUT', `${at}/contents/${file}`, {
      message, branch, content: Buffer.from(content).toString('base64'), sha: current.status === 200 ? current.body.sha : undefined,
    }), `save ${file}`);
  };

  let found = await github(token, 'GET', at);
  if (found.status === 404) {
    const made = must(await github(token, 'POST', '/user/repos', {
      name: repo, description: 'Pages published from Agent Desk', auto_init: true, has_issues: false, has_wiki: false, has_projects: false,
    }), `create ${account}/${repo}`);
    await put(MARKER, 'Pages published from Agent Desk. It only writes to repos with this file.\n', 'Made by Agent Desk', made.default_branch);
    await put('.nojekyll', '', 'Serve files as they are', made.default_branch);
    found = { status: 200, body: made };
  }
  const info = must(found, `read ${account}/${repo}`);
  const branch = info.default_branch;
  if ((await github(token, 'GET', `${at}/contents/${MARKER}?ref=${encodeURIComponent(branch)}`)).status !== 200) {
    throw fail(409, `${account}/${repo} already exists and Agent Desk didn't make it, so it won't publish there. Pick another repo name.`);
  }
  await put(`${slug}/index.html`, read(a), `Publish “${a.title}”`, branch);

  let pages = await github(token, 'GET', `${at}/pages`);
  if (pages.status === 404) pages = { body: must(await github(token, 'POST', `${at}/pages`, { source: { branch, path: '/' } }), 'turn on GitHub Pages') };
  const site = (pages.body.html_url || `https://${account.toLowerCase()}.github.io/${repo}/`).replace(/\/?$/, '/');
  a.published = { account, repo, slug, url: `${site}${slug}/`, at: Date.now() };
  db.settings.pages = { account, repo }; // the publish box starts here next time
  changed('settings');
  changed('artifacts');
  return a;
}
