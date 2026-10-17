// Updates, as in Task Notes: the version pill by the logo checks GitHub for a newer release, shows what's
// new, and downloads the .dmg into your Downloads folder to drag into Applications.
import { api, h, icon, on, toast, modal, command, markdown } from './ui.js';

const pill = document.getElementById('verPill');
let info = null;

async function check(force = false) {
  try {
    info = await api('GET', `/api/update${force ? '?force=1' : ''}`);
  } catch (e) {
    info = { error: e.message };
  }
  pill.textContent = info.newer ? 'Update' : info.current ? `v${info.current}` : 'v?';
  pill.classList.toggle('new', Boolean(info.newer));
  pill.title = info.newer ? `${info.latest} is available` : 'Check for updates';
  return info;
}

const mb = bytes => `${Math.round(bytes / 1048576)} MB`;

export async function openUpdates() {
  const body = h('div', { class: 'update' }, h('p', { class: 'muted' }, 'Checking GitHub…'));
  modal({ title: 'Updates', width: 520, body });
  const paint = d => {
    const latest = d.latest || (d.none ? 'No releases yet' : d.error || 'Unknown');
    const status = d.error ? `Couldn't check: ${d.error}`
      : d.newer ? `${d.latest} is out.${d.asset ? '' : ' Its release has no .dmg to download yet.'}`
        : d.none ? 'Nothing has been released on GitHub yet.' : 'You have the newest version.';
    const bar = h('div', { class: 'update-bar', hidden: true }, h('i'));
    const note = h('p', { class: 'muted update-note' });
    const get = d.newer && d.asset && h('button', { class: 'btn primary', onClick: () => download(d, get, bar, note) },
      icon('arrow', 14), `Download ${d.latest}${d.asset.size ? ` · ${mb(d.asset.size)}` : ''}`);
    body.replaceChildren(...[
      h('div', { class: 'update-rows' }, h('span', {}, 'Installed'), h('b', {}, `v${d.current ?? '?'}`), h('span', {}, 'Latest'), h('b', {}, latest)),
      h('p', {}, status),
      d.notes && h('div', { class: 'update-notes md' }, markdown(d.notes)),
      bar, note,
      h('div', { class: 'row update-acts' },
        h('button', { class: 'btn', onClick: async e => { e.currentTarget.disabled = true; paint(await check(true)); } }, icon('refresh', 14), 'Check again'),
        d.page && h('button', { class: 'btn', onClick: () => window.open(d.page, '_blank') }, icon('external', 14), 'Release page'),
        h('span', { class: 'grow' }), get),
    ].filter(Boolean)); // replaceChildren would print an empty slot as "undefined"
  };
  paint(await check());
}

async function download(d, button, bar, note) {
  button.disabled = true;
  button.lastChild.textContent = 'Downloading…';
  bar.hidden = false;
  const off = on('update-progress', p => {
    bar.firstChild.style.width = `${p.total ? Math.round((p.received / p.total) * 100) : 100}%`;
    note.textContent = p.total ? `${mb(p.received)} of ${mb(p.total)}` : mb(p.received);
  });
  try {
    const { name } = await api('POST', '/api/update/download');
    bar.firstChild.style.width = '100%';
    button.lastChild.textContent = 'In your Downloads folder';
    note.replaceChildren(`${name} is in your Downloads folder. Open it, drag Agent Desk into Applications and choose Replace, then quit Agent Desk and open it again. Your board, chats and settings stay. `,
      h('button', { class: 'btn xs', onClick: () => api('POST', '/api/update/show') }, 'Show in Finder'));
  } catch (e) {
    button.disabled = false;
    button.lastChild.textContent = `Download ${d.latest}`;
    note.textContent = `The download stopped: ${e.message}`;
    toast(e.message, 'error');
  } finally {
    off?.();
  }
}

pill.addEventListener('click', openUpdates);
command('Check for updates', openUpdates, { icon: 'refresh' });
check();
setInterval(check, 6 * 3600_000); // the server keeps the answer for ten minutes, so this is cheap
