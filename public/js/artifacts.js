// Artifacts view: pages, reports and visuals your agents saved with save_artifact. Pick one to view it,
// open it in your browser, or publish it to GitHub Pages.
import { state, api, h, icon, on, toast, guard, actions, modal, confirmDialog, askText, menu, baseName, ago } from './ui.js';

let listEl;
let stage;
let selected = null;
let shown = ''; // the id and version in the frame, so a refresh doesn't reload an unchanged page

export function mount(el) {
  listEl = h('div', { class: 'art-list' });
  stage = h('div', { class: 'art-stage' });
  el.append(h('div', { class: 'arts' }, listEl, stage));
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
    h('button', { class: 'icon-btn', title: 'Rename', onClick: () => rename(a) }, icon('pen', 15)),
    h('button', { class: 'icon-btn', title: 'Delete', onClick: () => remove(a) }, icon('trash', 15)),
    h('button', { class: 'btn', onClick: () => openInBrowser(a) }, icon('external', 15), 'Open in browser'),
    h('button', { class: 'btn primary', onClick: () => publish(a) }, icon('send', 15), a.published ? 'Publish again' : 'Publish'),
  ].filter(Boolean);
}

function render() {
  if (!listEl) return;
  const all = state.artifacts;
  if (!current()) selected = all[0]?.id ?? null;
  listEl.replaceChildren(...all.map(a => h('button', {
    class: `art-item${a.id === selected ? ' on' : ''}`,
    onClick: () => { selected = a.id; render(); },
    onContextmenu: e => { e.preventDefault(); more(e.currentTarget, a); },
  },
  h('div', { class: 'art-title' }, a.title),
  h('div', { class: 'art-meta' }, [a.project && baseName(a.project), a.by, ago(a.updatedAt)].filter(Boolean).join(' · ')),
  a.published && h('span', { class: 'chip', title: a.published.url }, icon('globe', 11), 'Published'))));

  const a = current();
  if (!a) {
    shown = '';
    stage.replaceChildren(h('div', { class: 'empty-state' }, h('div', { class: 'empty-card' },
      h('div', { class: 'art' }, icon('layers', 34)),
      h('h2', {}, 'Pages your agents make'),
      h('p', {}, 'Ask an agent for a page, a report or a chart, and it saves it here. View it, open it in your browser, and publish it to GitHub Pages when you want to share it.'))));
  } else if (shown !== `${a.id}:${a.updatedAt}`) {
    shown = `${a.id}:${a.updatedAt}`;
    // Sandboxed with no same-origin: the page's scripts run, but can't reach Agent Desk or its login.
    stage.replaceChildren(h('iframe', {
      class: 'art-frame', title: a.title, src: `/a/${a.id}?v=${a.updatedAt}`,
      sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads',
    }));
  }
  if (actions.currentView?.() === 'artifacts') actions.renderToolbar();
}

const rename = guard(async a => {
  const title = await askText('Rename artifact', { value: a.title });
  if (title?.trim()) await api('PATCH', `/api/artifacts/${a.id}`, { title });
});
const remove = guard(async a => {
  const note = a.published ? ' Its published page stays online: Unpublish it first to take it down.' : '';
  if (await confirmDialog('Delete artifact?', `“${a.title}” is removed from Agent Desk.${note}`, { label: 'Delete', danger: true })) {
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

const more = (anchor, a) => menu(anchor, [
  { label: 'Open in browser', icon: 'external', onClick: () => openInBrowser(a) },
  { label: 'Rename', icon: 'pen', onClick: () => rename(a) },
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
      h('p', { class: 'muted' }, 'Anyone with the link can see it. Agent Desk keeps your pages in one repo it makes for them, and never writes to any other repo.'),
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
