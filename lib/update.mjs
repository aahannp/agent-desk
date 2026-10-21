// Updates, the same way Task Notes does them: ask GitHub for the newest release of this app, and if it's
// newer, download its .dmg into your Downloads folder for you to drag into Applications.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { bus } from './store.mjs';

const REPO = 'aahannp/relay';
const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(import.meta.dirname), 'package.json'), 'utf8')).version;
const API = () => process.env.AGENT_DESK_GITHUB_API || 'https://api.github.com';
const fail = (status, message) => Object.assign(new Error(message), { status });

export const current = () => VERSION;

// "v1.10.0" is newer than "1.9.2". Anything after a "-" (a pre-release tag) is ignored.
export function isNewer(tag, than) {
  const nums = v => String(v).replace(/^v/i, '').split('-')[0].split('.').map(n => Number.parseInt(n, 10) || 0);
  const [a, b] = [nums(tag), nums(than)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

// Cached for ten minutes: GitHub rate-limits callers without a login, and the answer rarely changes.
let cache = { at: 0, value: null };
export async function check(force = false) {
  if (!force && cache.value && Date.now() - cache.at < 10 * 60_000) return { current: VERSION, ...cache.value };
  let res;
  try {
    res = await fetch(`${API()}/repos/${REPO}/releases/latest`, {
      signal: AbortSignal.timeout(10_000), headers: { accept: 'application/vnd.github+json', 'user-agent': `agent-desk/${VERSION}` },
    });
  } catch (e) {
    return { current: VERSION, error: `Couldn't reach GitHub (${e.cause?.code || e.message})` };
  }
  const j = await res.json().catch(() => ({}));
  if (res.status === 404) return save({ latest: null, newer: false, none: true });
  if (!res.ok) return viaReleasePage(j.message || `GitHub answered ${res.status}`);
  const dmg = (j.assets || []).find(a => /\.dmg$/i.test(a.name || ''));
  return save({
    latest: j.tag_name, newer: isNewer(j.tag_name, VERSION), notes: String(j.body || '').slice(0, 4000), page: j.html_url,
    publishedAt: j.published_at, asset: dmg ? { name: dmg.name, url: dmg.browser_download_url, size: dmg.size } : null,
  });
}
// Without a login GitHub allows 60 API calls an hour per address, and an office network shares one address.
// The release page's redirect isn't counted, so fall back to it: the tag and the .dmg, but no notes.
async function viaReleasePage(why) {
  const web = process.env.AGENT_DESK_GITHUB_API || 'https://github.com';
  try {
    const res = await fetch(`${web}/${REPO}/releases/latest`, {
      redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': `agent-desk/${VERSION}` },
    });
    const tag = res.headers.get('location')?.match(/\/releases\/tag\/([^/?#]+)$/)?.[1];
    if (!tag) return { current: VERSION, error: why };
    const name = `Relay-${decodeURIComponent(tag).replace(/^v/i, '')}-arm64.dmg`;
    return save({
      latest: decodeURIComponent(tag), newer: isNewer(decodeURIComponent(tag), VERSION), notes: '', page: `${web}/${REPO}/releases/tag/${tag}`,
      asset: { name, url: `${web}/${REPO}/releases/download/${tag}/${name}`, size: 0 },
    });
  } catch {
    return { current: VERSION, error: why };
  }
}
const save = value => ((cache = { at: Date.now(), value }), { current: VERSION, ...value });

// Only ever follows links to GitHub, where releases and their files live.
const fromGitHub = url => /^https:\/\/([a-z0-9-]+\.)*(github\.com|githubusercontent\.com)\//i.test(url)
  || Boolean(process.env.AGENT_DESK_GITHUB_API && url.startsWith(`${process.env.AGENT_DESK_GITHUB_API}/`));

let downloading = null;
let saved = null; // the last download, the only file "show in Finder" will reveal
export function download(downloads = path.join(os.homedir(), 'Downloads')) {
  downloading ??= (async () => {
    const info = await check();
    if (!info.newer || !info.asset) throw fail(409, 'There is no newer version to download');
    const name = path.basename(info.asset.name);
    const dest = path.join(downloads, name);
    let url = info.asset.url;
    for (let hops = 0; ; hops++) {
      if (hops > 5 || !fromGitHub(url)) throw fail(502, 'The download pointed somewhere other than GitHub, so it was stopped');
      const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': `agent-desk/${VERSION}` } });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url).href; continue; }
      if (!res.ok) throw fail(502, `GitHub answered ${res.status}`);
      const total = Number(res.headers.get('content-length')) || info.asset.size || 0;
      const part = `${dest}.part`;
      const out = fs.createWriteStream(part);
      let received = 0;
      let last = 0;
      const progress = done => bus.emit('event', { type: 'update-progress', received, total, done });
      try {
        for await (const chunk of res.body) {
          received += chunk.length;
          if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
          if (Date.now() - last > 150) { last = Date.now(); progress(false); }
        }
        await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
      } catch (e) {
        out.destroy();
        fs.rmSync(part, { force: true });
        throw e;
      }
      fs.renameSync(part, dest);
      saved = dest;
      progress(true);
      return { path: dest, name };
    }
  })().finally(() => { downloading = null; });
  return downloading;
}

// Shows the downloaded file in Finder.
export function reveal() {
  if (!saved) throw fail(404, 'Nothing has been downloaded yet');
  return new Promise(resolve => execFile('open', ['-R', saved], () => resolve({})));
}
