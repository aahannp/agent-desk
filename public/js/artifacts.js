// Artifacts view: pages, reports and visuals your agents saved with save_artifact. Pick one to view it,
// open it in your browser, or publish it to GitHub Pages. Folders group them: pick one on the left, drag a page
// onto one, or use a page's right-click menu to move it. A page with no folder is Unfiled.
import { state, api, h, icon, on, toast, guard, actions, modal, confirmDialog, askText, menu, baseName, ago, DRAG } from './ui.js';

const ALL = '*'; // the view names; a folder's name starts with a letter or number, so it can't be either
const UNFILED = '-';
const KEY = 'desk.artifacts';
const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } })();
let view = saved.view || ALL;
const collapsed = new Set(saved.collapsed); // groups folded shut in the All view
const remember = () => { try { localStorage.setItem(KEY, JSON.stringify({ view, collapsed: [...collapsed] })); } catch {} };

let side;
let foldersEl;
let listEl;
let find;
let stage;
let selected = null;
let shown = ''; // the id and version in the frame, so a refresh doesn't reload an unchanged page

export function mount(el) {
  find = h('input', { class: 'input', type: 'search', placeholder: 'Search pages', spellcheck: false, 'aria-label': 'Search pages by title', onInput: render });
  foldersEl = h('div', { class: 'art-folders', role: 'list', 'aria-label': 'Folders' });
  listEl = h('div', { class: 'art-list' });
  side = h('div', { class: 'art-side' },
    h('div', { class: 'art-find' }, find, h('button', { class: 'icon-btn', title: 'New folder', 'aria-label': 'New folder', onClick: () => newFolder() }, icon('plus', 16))),
    foldersEl, listEl);
  stage = h('div', { class: 'art-stage' });
  el.append(h('div', { class: 'arts' }, side, stage));
  on('artifacts', render);
}
export const show = () => render();

const current = () => state.artifacts.find(a => a.id === selected) ?? null;
const openInBrowser = a => window.open(`${location.origin}/a/${a.id}`, '_blank'); // the Mac app hands this to your browser

export function toolbar() {
  const a = current();
  if (!a) return [];
  return [
    a.published && h('button', { class: 'btn', onClick: () => window.open(a.published.url, '_blank'), title: a.published.url }, icon('globe', 15), 'Published page'),
    a.published && h('button', { class: 'btn', onClick: () => unpublish(a) }, icon('x', 15), 'Unpublish'),
    h('button', { class: 'icon-btn', title: 'Move to a folder', 'aria-label': 'Move to a folder', 'aria-haspopup': 'menu', onClick: e => menu(e.currentTarget, moveItems(a), { align: 'right' }) }, icon('folder', 15)),
    h('button', { class: 'icon-btn', title: 'Rename', onClick: () => rename(a) }, icon('pen', 15)),
    h('button', { class: 'icon-btn', title: 'Delete', onClick: () => remove(a) }, icon('trash', 15)),
    h('button', { class: 'btn', onClick: () => openInBrowser(a) }, icon('external', 15), 'Open in browser'),
    h('button', { class: 'btn primary', onClick: () => publish(a) }, icon('send', 15), a.published ? 'Publish again' : 'Publish'),
  ].filter(Boolean);
}

const folderNames = () => state.artifactFolders.map(f => f.name);
const inView = a => view === ALL || (view === UNFILED ? !a.folder : a.folder === view);
const countOf = name => state.artifacts.filter(a => (name === UNFILED ? !a.folder : a.folder === name)).length;

function render() {
  if (!listEl) return;
  if (view !== ALL && view !== UNFILED && !folderNames().includes(view)) view = ALL; // it was deleted
  const query = find.value.trim().toLowerCase();
  const pages = state.artifacts.filter(a => (query ? a.title.toLowerCase().includes(query) : inView(a)));
  if (!pages.some(a => a.id === selected)) selected = pages[0]?.id ?? null;

  foldersEl.classList.toggle('searching', !!query); // results span every folder, so none is lit
  const focused = side.contains(document.activeElement) && document.activeElement.dataset?.key; // a redraw must not drop keyboard focus
  foldersEl.replaceChildren(
    folderRow(ALL, 'All', state.artifacts.length),
    ...folderNames().map(name => folderRow(name, name, countOf(name))),
    folderRow(UNFILED, 'Unfiled', countOf(UNFILED)));

  if (query) {
    listEl.replaceChildren(h('div', { class: 'art-note' }, `${pages.length} ${pages.length === 1 ? 'page' : 'pages'} match`), ...pages.map(item));
  } else if (view === ALL) {
    const groups = [...folderNames(), UNFILED].map(name => [name, pages.filter(a => (name === UNFILED ? !a.folder : a.folder === name))]);
    listEl.replaceChildren(...groups.filter(([, list]) => list.length).map(([name, list]) => group(name, list)));
  } else {
    listEl.replaceChildren(...(pages.length ? pages.map(item) : [h('div', { class: 'art-note' }, 'Nothing here yet. Drag a page onto this folder, or use Move to in its right-click menu.')]));
  }
  if (focused) side.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();

  const a = current();
  if (!a) {
    shown = '';
    stage.replaceChildren(h('div', { class: 'empty-state' }, h('div', { class: 'empty-card' },
      h('div', { class: 'art' }, icon('layers', 34)),
      h('h2', {}, state.artifacts.length ? 'No page here' : 'Pages your agents make'),
      h('p', {}, state.artifacts.length ? 'Pick a page from the list, or choose another folder.' : 'Ask an agent for a page, a report or a chart, and it saves it here. View it, open it in your browser, and publish it to GitHub Pages when you want to share it.'))));
  } else if (shown !== `${a.id}:${a.updatedAt}`) {
    shown = `${a.id}:${a.updatedAt}`;
    // Sandboxed with no same-origin: the page's scripts run, but can't reach Relay or its login.
    const frame = h('iframe', {
      class: 'art-frame loading', title: a.title, src: `/a/${a.id}?v=${a.updatedAt}`,
      sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads',
    });
    // Load it hidden and swap on load, so the old page stays up instead of a blank white frame; a newer pick wins.
    frame.addEventListener('load', () => {
      if (stage.lastElementChild !== frame) return;
      frame.classList.remove('loading');
      for (const el of [...stage.children]) if (el !== frame) el.remove(); // not replaceChildren(frame): that would re-insert it and reload the page
    });
    stage.append(frame);
  }
  if (actions.currentView?.() === 'artifacts') actions.renderToolbar();
}

const rename = guard(async a => {
  const title = await askText('Rename artifact', { value: a.title });
  if (title?.trim()) await api('PATCH', `/api/artifacts/${a.id}`, { title });
});
const remove = guard(async a => {
  const note = a.published ? ' Its published page stays online: Unpublish it first to take it down.' : '';
  if (await confirmDialog('Delete artifact?', `“${a.title}” is removed from Relay.${note}`, { label: 'Delete', danger: true })) {
    await api('DELETE', `/api/artifacts/${a.id}`);
  }
});
const unpublish = guard(async a => {
  const { url, account, repo } = a.published;
  const note = `${url} stops working in about a minute. GitHub keeps earlier versions in the history of ${account}/${repo}, which is public. To erase them too, delete that repo on GitHub (it holds all your published pages).`;
  if (!(await confirmDialog('Take this page down?', note, { label: 'Unpublish', danger: true }))) return;
  await api('POST', `/api/artifacts/${a.id}/unpublish`);
  toast('Unpublished. The page goes offline in about a minute.', 'ok');
});

// ---------- Folders ----------
const choose = name => { view = name; find.value = ''; remember(); render(); };
const dropTarget = (el, name) => {
  const carries = e => e.dataTransfer.types.includes(DRAG.artifact);
  el.addEventListener('dragover', e => { if (!carries(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('over'); });
  el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('over'); });
  el.addEventListener('drop', e => {
    el.classList.remove('over');
    const a = state.artifacts.find(x => x.id === e.dataTransfer.getData(DRAG.artifact));
    if (!a || name === ALL) return;
    e.preventDefault();
    move(a, name === UNFILED ? null : name);
  });
};

function folderRow(name, label, count) {
  const real = name !== ALL && name !== UNFILED;
  const row = h('div', { class: `art-folder${view === name ? ' on' : ''}${real ? '' : ' plain'}`, role: 'listitem' },
    h('button', { class: 'art-folder-main', 'data-key': `folder:${name}`, 'aria-current': view === name ? 'true' : null, onClick: () => choose(name) },
      icon(name === ALL ? 'layers' : 'folder', 15), h('span', { class: 'art-folder-name' }, label), h('span', { class: 'art-count' }, count)),
    real && h('button', { class: 'icon-btn sm art-more', title: `Options for ${name}`, 'aria-label': `Options for ${name}`, 'aria-haspopup': 'menu', onClick: e => folderMenu(e.currentTarget, name) }, icon('dots', 15)));
  if (real) row.addEventListener('contextmenu', e => { e.preventDefault(); folderMenu(row, name); });
  dropTarget(row, name);
  return row;
}

// One folder's pages in the All view, folded shut with its arrow.
function group(name, list) {
  const open = !collapsed.has(name);
  const head = h('button', {
    class: 'art-group', 'data-key': `group:${name}`, 'aria-expanded': String(open),
    onClick: () => { open ? collapsed.add(name) : collapsed.delete(name); remember(); render(); },
  }, icon(open ? 'chevron' : 'chevronRight', 13), h('span', { class: 'art-folder-name' }, name === UNFILED ? 'Unfiled' : name), h('span', { class: 'art-count' }, list.length));
  dropTarget(head, name);
  return h('div', { class: 'art-section' }, head, open && list.map(item));
}

function item(a) {
  return h('button', {
    class: `art-item${a.id === selected ? ' on' : ''}`, draggable: true,
    onClick: () => { selected = a.id; render(); },
    onContextmenu: e => { e.preventDefault(); more(e.currentTarget, a); },
    onDragstart: e => { e.dataTransfer.setData(DRAG.artifact, a.id); e.dataTransfer.effectAllowed = 'move'; },
  },
  h('div', { class: 'art-title' }, a.title),
  h('div', { class: 'art-meta' }, [find.value.trim() && (a.folder || 'Unfiled'), a.project && baseName(a.project), a.by, ago(a.updatedAt)].filter(Boolean).join(' · ')),
  a.published && h('span', { class: 'chip', title: a.published.url }, icon('globe', 11), 'Published'));
}

const move = guard(async (a, folder) => { await api('PATCH', `/api/artifacts/${a.id}`, { folder }); });
const moveToNew = guard(async a => {
  const name = await askText('New folder', { label: `Move “${a.title}” to a new folder`, placeholder: 'Folder name', ok: 'Create' });
  if (name) await move(a, name);
});
const newFolder = guard(async () => {
  const name = await askText('New folder', { label: 'Name', placeholder: 'e.g. Relay', ok: 'Create' });
  if (!name) return;
  await api('POST', '/api/artifact-folders', { name });
  choose(name);
});
const renameFolder = guard(async name => {
  const to = await askText('Rename folder', { value: name });
  if (!to || to === name) return;
  await api('PATCH', `/api/artifact-folders/${encodeURIComponent(name)}`, { name: to });
  const was = collapsed.delete(name);
  if (was) collapsed.add(to);
  if (view === name) view = to;
  remember();
  render();
});
const deleteFolder = guard(async name => {
  const n = countOf(name);
  const pages = n ? `Its ${n === 1 ? 'page moves' : `${n} pages move`} to Unfiled. No page is deleted.` : 'It has no pages.';
  if (!(await confirmDialog(`Delete the folder “${name}”?`, pages, { label: 'Delete folder', danger: true }))) return;
  await api('DELETE', `/api/artifact-folders/${encodeURIComponent(name)}`);
  collapsed.delete(name);
  if (view === name) view = ALL;
  remember();
});

const folderMenu = (anchor, name) => menu(anchor, [
  { label: 'Rename', icon: 'pen', onClick: () => renameFolder(name) },
  { label: 'Delete', icon: 'trash', onClick: () => deleteFolder(name) },
], { align: 'right' });

// "Move to" is a heading and a list, since menus here don't nest. It's the keyboard way to do what dragging does.
const moveItems = a => [
  { heading: 'Move to' },
  ...folderNames().map(name => ({ label: name, icon: 'folder', disabled: a.folder === name, sub: a.folder === name ? 'here' : '', onClick: () => move(a, name) })),
  { label: 'New folder…', icon: 'plus', onClick: () => moveToNew(a) },
  { label: 'Unfiled', icon: 'x', disabled: !a.folder, sub: a.folder ? '' : 'here', onClick: () => move(a, null) },
];
const more = (anchor, a) => menu(anchor, [
  { label: 'Open in browser', icon: 'external', onClick: () => openInBrowser(a) },
  { label: 'Rename', icon: 'pen', onClick: () => rename(a) },
  'sep', ...moveItems(a), 'sep',
  { label: 'Delete', icon: 'trash', onClick: () => remove(a) },
]);

const slugOf = title => String(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'page';

async function publish(a) {
  const last = a.published ?? state.settings.pages ?? {};
  const account = h('select', { class: 'input' }, h('option', { value: '', disabled: true, selected: true }, 'Loading your GitHub accounts…'));
  const repo = h('input', { class: 'input', value: last.repo || 'artifacts', spellcheck: false });
  const slug = h('input', { class: 'input', value: a.published?.slug || slugOf(a.title), spellcheck: false });
  const where = h('p', { class: 'publish-url mono' });
  const update = () => {
    where.textContent = account.value ? `https://${account.value.toLowerCase()}.github.io/${repo.value.trim()}/${slug.value.trim()}/` : 'Choose an account';
  };
  for (const input of [account, repo, slug]) for (const type of ['input', 'change']) input.addEventListener(type, update);
  modal({
    title: a.published ? 'Publish again' : 'Publish to GitHub Pages', width: 540,
    body: [
      h('p', { class: 'muted' }, 'Anyone with the link can see it. Relay keeps your pages in one repo it makes for them, and never writes to any other repo.'),
      h('label', { class: 'field' }, h('span', {}, 'GitHub account'), account),
      h('div', { class: 'row' },
        h('label', { class: 'field', style: { flex: 1 } }, h('span', {}, 'Repo'), repo),
        h('label', { class: 'field', style: { flex: 1 } }, h('span', {}, 'Page name'), slug)),
      h('div', { class: 'field' }, h('span', {}, 'It will be at'), where),
    ],
    actions: [{ label: 'Cancel' }, { label: 'Publish', primary: true, onClick: async () => {
      if (!account.value) { toast('Choose a GitHub account', 'error'); return false; }
      try {
        toast('Publishing…');
        const done = await api('POST', `/api/artifacts/${a.id}/publish`, { account: account.value, repo: repo.value.trim(), slug: slug.value.trim() });
        toast(a.published ? 'Published again. It updates in about a minute.' : 'Published. GitHub takes about a minute to put it live.', 'ok',
          { label: 'Open', onClick: () => window.open(done.published.url, '_blank') });
      } catch (e) {
        toast(e.message, 'error');
        return false;
      }
    } }],
  });
  update();
  try {
    const accounts = await api('GET', '/api/github/accounts');
    if (!accounts.length) throw new Error('Sign in with gh auth login first');
    account.replaceChildren(h('option', { value: '', disabled: true }, 'Choose an account'),
      ...accounts.map(x => h('option', { value: x.login }, x.login)));
    account.value = accounts.some(x => x.login === last.account) ? last.account : ''; // you pick the first time
  } catch (e) {
    account.replaceChildren(h('option', { value: '', disabled: true, selected: true }, e.message));
  }
  update();
}
