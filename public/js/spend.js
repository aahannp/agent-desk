// Spend view: what Claude Code cost on this Mac each day, at API list prices, and where a day's money went.
import { state, api, h, icon, actions, guard, ltr } from './ui.js';

const DAYS_SHOWN = 35;
const TYPES = [
  ['input', 'Input', 'New text sent to the model, not cached'],
  ['write', 'Cache write', 'Context saved to the cache (5 minute and 1 hour)'],
  ['read', 'Cache read', 'Re-reading context already in the cache, on every reply'],
  ['output', 'Output', 'What the model wrote, thinking included'],
];

let root;
let days = [];
let today = '';
let selected = '';
let detail = null;

export function mount(el) {
  root = h('div', { class: 'spend' });
  el.append(root);
}
export const show = () => load();
export const toolbar = () => [h('button', { class: 'btn sm', onClick: () => load() }, icon('refresh', 13), 'Refresh')];

const money = n => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const count = n => Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const parseDay = day => new Date(`${day}T12:00:00`);
const dayLabel = (day, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  day === today ? 'Today' : parseDay(day).toLocaleDateString(undefined, opts);
const shortPath = p => (p ? ltr(p.replace(state.info.home, '~')) : 'Unknown folder');
const share = (part, whole) => `${whole > 0 ? Math.max(part / whole * 100, part > 0 ? 1 : 0) : 0}%`;

const load = guard(async () => {
  ({ days, today } = await api('GET', '/api/usage/days'));
  selected ||= today;
  await pick(selected);
});

const pick = guard(async day => {
  selected = day;
  detail = await api('GET', `/api/usage?day=${day}`);
  render();
});

function totals() {
  const now = parseDay(today);
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sum = from => days.filter(d => parseDay(d.day) >= from && d.day <= today).reduce((n, d) => n + d.cost, 0);
  return { week: sum(monday), month: sum(new Date(now.getFullYear(), now.getMonth(), 1)) };
}

function history() {
  const byDay = new Map(days.map(d => [d.day, d]));
  const shown = Array.from({ length: DAYS_SHOWN }, (_, i) => {
    const d = parseDay(today);
    d.setDate(d.getDate() - (DAYS_SHOWN - 1 - i));
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { day, cost: byDay.get(day)?.cost ?? 0 };
  });
  const top = Math.max(...shown.map(d => d.cost), 0.01);
  return h('div', { class: 'spend-history', role: 'group', 'aria-label': `The last ${DAYS_SHOWN} days` },
    ...shown.map(d => h('button', {
      class: `spend-day${d.day === selected ? ' on' : ''}`, 'aria-pressed': String(d.day === selected),
      title: `${dayLabel(d.day)}: ${money(d.cost)}`, 'aria-label': `${dayLabel(d.day, { weekday: 'long', month: 'long', day: 'numeric' })}, ${money(d.cost)}`,
      onClick: () => pick(d.day),
    }, h('span', { class: 'bar', style: { height: share(d.cost, top) } }),
    h('span', { class: 'tick', 'aria-hidden': 'true' }, parseDay(d.day).getDate() === 1 || d.day === today ? dayLabel(d.day, { month: 'short', day: 'numeric' }) : ''))));
}

const stat = (label, value, sub) => h('div', { class: 'spend-stat' }, h('div', { class: 'section-label' }, label), h('div', { class: 'big' }, value), sub && h('div', { class: 'muted' }, sub));

function byType(d) {
  const rows = TYPES.map(([key, label, hint]) => {
    const parts = key === 'write' ? [d.byType.write5m, d.byType.write1h] : [d.byType[key]];
    return { label, hint, cost: parts.reduce((n, p) => n + p.cost, 0), tokens: parts.reduce((n, p) => n + p.tokens, 0) };
  });
  const top = rows.reduce((n, r) => n + r.cost, 0);
  return section('By token type', rows.map(r => meter(r.label, r.hint, r.cost, top, `${count(r.tokens)} tokens`)));
}

function meter(label, sub, cost, whole, right) {
  return h('div', { class: 'spend-meter' },
    h('div', { class: 'row' }, h('span', { class: 'name' }, label), sub && h('span', { class: 'muted sub' }, sub), h('span', { class: 'grow' }),
      h('span', { class: 'muted' }, right), h('b', {}, money(cost))),
    h('div', { class: 'track' }, h('span', { style: { width: share(cost, whole) } })));
}

function byHour(d) {
  const top = Math.max(...d.hours, 0.01);
  return section('By hour', [h('div', { class: 'spend-hours', role: 'img', 'aria-label': `Cost per hour: ${d.hours.map((c, i) => `${i}:00 ${money(c)}`).join(', ')}` },
    ...d.hours.map((c, i) => h('div', { class: 'hour', title: `${i}:00–${i + 1}:00 · ${money(c)}` },
      h('span', { class: 'bar', style: { height: share(c, top) } }), h('span', { class: 'tick' }, i % 3 === 0 ? String(i) : ''))))]);
}

const section = (title, children) => h('section', { class: 'spend-card' }, h('div', { class: 'section-label' }, title), ...children);

function sessions(d) {
  return section(`By session · ${d.sessions.length}`, [h('div', { class: 'spend-table', role: 'table' },
    h('div', { class: 'tr head', role: 'row' }, ...['Session', 'Where', 'Replies', 'Tokens', 'Cost'].map(t => h('span', { role: 'columnheader' }, t))),
    ...d.sessions.map(s => h('div', { class: 'tr', role: 'row' },
      h('span', { role: 'cell', class: 'title' },
        h('b', {}, s.title || s.id.slice(0, 8)),
        h('span', { class: 'muted' }, [s.agent, shortPath(s.cwd), s.subagents && `${s.subagents} by subagents`].filter(Boolean).join(' · '))),
      h('span', { role: 'cell' }, h('span', { class: `spend-tag${s.agent ? ' desk' : ''}` }, s.agent ? 'Relay' : 'Outside')),
      h('span', { role: 'cell', class: 'num' }, String(s.replies)),
      h('span', { role: 'cell', class: 'num' }, count(s.tokens)),
      h('span', { role: 'cell', class: 'num' }, h('b', {}, money(s.cost))))))]);
}

function render() {
  if (!detail) return;
  const d = detail;
  const { week, month } = totals();
  const readShare = d.cost > 0 ? Math.round(d.byType.read.cost / d.cost * 100) : 0;
  root.replaceChildren(h('div', { class: 'spend-inner' },
    h('div', { class: 'spend-top' },
      stat(selected === today ? 'Spent today' : dayLabel(selected, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), money(d.cost),
        `${d.replies.toLocaleString()} replies${d.saved ? ' · kept from an earlier scan' : ''}`),
      stat('This week', money(week)), stat('This month', money(month))),
    h('p', { class: 'spend-note muted' }, icon('info', 13),
      'Estimated at Anthropic\'s API list prices, for all Claude Code use on this Mac. A subscription plan is not billed per token, so this is what the same work would cost on the API.'),
    h('section', { class: 'spend-card' }, h('div', { class: 'section-label' }, `The last ${DAYS_SHOWN} days`), history()),
    d.replies ? [
      readShare >= 40 && h('p', { class: 'spend-callout' }, `${readShare}% of this day went on cache reads: re-reading context the model has already seen, on every reply. Long conversations cost more per reply.`),
      d.unpriced > 0 && h('p', { class: 'spend-callout warn' }, `${d.unpriced} replies came from a model with no price in the table, so they count as $0. Their tokens are still shown.`),
      h('div', { class: 'spend-grid' }, byType(d), byHour(d)),
      h('div', { class: 'spend-grid' },
        section('By model', d.models.map(m => meter(m.name, !m.priced && 'unpriced', m.cost, d.cost, `${m.replies} replies · ${count(m.tokens)}`))),
        section('By project folder', d.projects.map(p => meter(shortPath(p.name), null, p.cost, d.cost, `${p.replies} replies`)))),
      sessions(d),
    ] : h('div', { class: 'pane-empty' }, 'No Claude Code replies on this day.')));
}

