/**
 * MaDo GUI: task tree and editor, link graph and time view. Plain DOM, no framework.
 * Talks to the library only through `api`, so a VSCode webview can swap the transport.
 */
import type { Db, Edge, Task } from '../db.js';
import type { Op } from '../edit.js';
import type { PropSchema } from '../format.js';

const SUBTASK = 'Subtask', PARENT = 'Parent';

// ---- Transport ----

/** HTTP transport of the standalone server. A VSCode webview replaces these three functions with postMessage calls. */
const api = {
  state: async (): Promise<Db> => (await fetch('api/state')).json(),
  async op(op: Op): Promise<{ id?: string; db: Db; error?: string }> {
    const r = await fetch('api/op', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mado': '1' }, body: JSON.stringify(op) });
    return r.json();
  },
  subscribe(cb: () => void) { new EventSource('api/events').onmessage = cb; },
};

// ---- Helpers ----

/**
 * Element builder. Children are appended before properties are set (a select's `value` needs its options).
 * Strings become text nodes: task data is never parsed as HTML.
 */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.append(...kids.filter((k): k is Node | string => k != null && k !== false));
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'list' || k.startsWith('data-')) el.setAttribute(k, String(v));
    else (el as unknown as Record<string, unknown>)[k] = v;
  }
  return el;
}

/** SVG element builder (attributes only; SVG has no reflected properties worth using). */
function s(tag: string, attrs: Record<string, string | number>, ...kids: (Node | string)[]): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
}

const $ = (id: string) => document.getElementById(id)!;
const hours = (v: number) => String(Math.round(v * 100) / 100);
const clock = (ms: number) => { const t = Math.floor(ms / 1000); return [t / 3600, (t / 60) % 60, t % 60].map(x => String(Math.floor(x)).padStart(2, '0')).join(':'); };
const trunc = (t: string, n: number) => t.length > n ? t.slice(0, n - 1) + '…' : t;
/** Color per link type: golden-angle hues over the format's link types keep colors distinct and stable. */
const hue = (t: string) => {
  const i = [SUBTASK, ...new Set(Object.values(db.format.types).flatMap(x => Object.keys(x.links)))].indexOf(t);
  return i < 0 ? 'gray' : `hsl(${(30 + i * 137.5) % 360} 65% 50%)`;
};

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

/**
 * Depth-first over Subtask links from tasks without a parent. A task seen before is listed again but not
 * expanded, which keeps shared subtasks and cycles linear; tasks only reachable through a cycle come last.
 */
function walk(visit: (t: Task, depth: number) => void) {
  const kids = new Map<string, string[]>(), hasParent = new Set<string>(), seen = new Set<string>();
  for (const e of db.edges) if (e.type === SUBTASK) { kids.set(e.from, [...kids.get(e.from) ?? [], e.to]); hasParent.add(e.to); }
  const go = (id: string, d: number) => {
    visit(db.tasks[id], d);
    if (seen.has(id)) return;
    seen.add(id);
    for (const c of kids.get(id) ?? []) go(c, d + 1);
  };
  for (const id in db.tasks) if (!hasParent.has(id)) go(id, 0);
  for (const id in db.tasks) if (!seen.has(id)) go(id, 0);
}

// ---- State ----

let db: Db;
let sel: string | null = null;
let tab: 'Tasks' | 'Graph' | 'Time' = 'Tasks';
let filter = '';
let showSubtasks = false;
let dirty = false;          // the editor form has unsaved changes; refreshes keep the form element
let formBundle: { form: HTMLFormElement; props: HTMLElement } | null = null, formFor = '';
let currentSubmit: (() => void) | null = null;   // bound to whichever form is live, so Ctrl+S works from the sidebar too
let sidebarWidth = 280, sidebarCollapsed = false;
let revealedLinkKinds = new Set<string>();        // link types the user opened an empty list for, this task only

/** Runs an operation and adopts the returned state. Only editor saves clear `dirty`; only saves and top-level creates move the selection. */
async function run(op: Op, fromEditor = false) {
  try {
    const r = await api.op(op);
    db = r.db;
    if (r.error) toast(r.error);
    else {
      if (fromEditor) dirty = false;
      if (op.op === 'delete' && op.id === sel) { sel = null; dirty = false; }
      else if (r.id && db.tasks[r.id] && !dirty && (fromEditor || (op.op === 'create' && !op.parent))) sel = r.id;
    }
  } catch (e) {
    toast((e as Error).message);
  }
  render();
}

function select(id: string) {
  if (dirty && id !== sel) return toast('Save or revert your changes first');
  if (id !== sel) revealedLinkKinds = new Set();
  sel = id;
  tab = 'Tasks';
  go();
}

// ---- Routing ----

/** Path naming the current view: `/view/<anchor>` (selected task), `/graph`, `/time`, or `/`. */
function url(): string {
  if (tab !== 'Tasks') return '/' + tab.toLowerCase();
  const t = sel ? db.tasks[sel] : undefined;
  return t ? '/view/' + encodeURIComponent(t.anchor) : '/';
}

/** The view `location` names. `sel` is absent for tab paths, which keep the current selection. */
function route(): { tab: typeof tab; sel?: string | null } {
  const p = location.pathname, m = /^\/view\/([^/]+)$/.exec(p);
  if (p === '/graph') return { tab: 'Graph' };
  if (p === '/time') return { tab: 'Time' };
  let a = '';
  try { a = m ? decodeURIComponent(m[1]) : ''; } catch { /* malformed %-escape: no task */ }
  return { tab: 'Tasks', sel: a ? Object.values(db.tasks).find(t => t.anchor === a)?.id ?? null : null };
}

/** User navigation adds a history entry; state changes from data (renames, deletes, refreshes) only replace it in `render`. */
function go() {
  if (url() !== location.pathname) history.pushState(null, '', url());
  render();
}

/** Back/forward. Unsaved edits block leaving the task, as `select` does, by restoring the URL. */
addEventListener('popstate', () => {
  const r = route();
  if (r.sel !== undefined && r.sel !== sel) {
    if (dirty) { toast('Save or revert your changes first'); history.pushState(null, '', url()); return; }
    sel = r.sel;
    revealedLinkKinds = new Set();
  }
  tab = r.tab;
  render();
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (dirty) currentSubmit?.(); }
});

// ---- Theme ----

/** Cycles auto → light → dark. Stored per browser; storage may throw (private mode), so it only ever degrades to auto. */
const THEMES = ['auto', 'light', 'dark'] as const, THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
function applyTheme(t: typeof THEMES[number]) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const b = $('theme');
  b.textContent = THEME_ICON[t];
  b.title = `Theme: ${t}`;
  b.onclick = () => {
    const next = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    try { localStorage.setItem('mado-theme', next); } catch { /* not persisted */ }
    applyTheme(next);
  };
}
let savedTheme: string | null = null;
try { savedTheme = localStorage.getItem('mado-theme'); } catch { /* auto */ }
applyTheme(THEMES.find(t => t === savedTheme) ?? 'auto');

// ---- Header ----

function header() {
  $('tabs').replaceChildren(...(['Tasks', 'Graph', 'Time'] as const).map(n => h('button', { className: n === tab ? 'on' : '', onclick: () => { tab = n; go(); } }, n)));
  $('timers').replaceChildren(...Object.values(db.tasks).filter(t => t.props.started).map(t => {
    const st = Date.parse(String(t.props.started));
    return h('button', { className: 'link', title: 'Running timer', onclick: () => select(t.id) }, `⏱ ${trunc(t.title, 30)} `, h('span', { 'data-started': st }, clock(Date.now() - st)));
  }));
  const errors = db.diagnostics.filter(d => d.severity === 'error').length, warnings = db.diagnostics.length - errors;
  const dt = $('diag-toggle');
  dt.textContent = `${errors} errors, ${warnings} warnings`;
  dt.className = `link ${errors ? 'error' : warnings ? 'warning' : ''}`;
  dt.onclick = () => { $('diags').hidden = !$('diags').hidden; };
  $('diags').replaceChildren(...db.diagnostics.map(d => h('div', { className: d.severity }, `${d.file}:${d.line + 1}: ${d.message}`)));
}

// ---- Tasks tab: sidebar ----

function sidebar(): HTMLElement {
  const tree = h('div', { id: 'tree' });
  const search = h('input', { type: 'search', placeholder: 'Filter tasks', value: filter, oninput: () => { filter = search.value; fillTree(tree); } });
  fillTree(tree);
  return h('aside', { className: 'sidebar' }, search, tree, newTaskForm());
}

function fillTree(tree: HTMLElement) {
  const rows: HTMLElement[] = [], q = filter.toLowerCase();
  if (q) { for (const t of Object.values(db.tasks)) if (`${t.id}\n${t.description}`.toLowerCase().includes(q)) rows.push(row(t, 0)); }
  else walk((t, d) => rows.push(row(t, d)));
  tree.replaceChildren(...rows);
}

function row(t: Task, depth: number): HTMLElement {
  const done = t.props.done === true, tot = db.totals[t.id];
  const cb = h('input', {
    type: 'checkbox', checked: done, title: 'Done',
    onclick: (e: Event) => e.stopPropagation(),
    onchange: () => run({ op: 'update', id: t.id, props: { ...t.props, done: cb.checked || undefined } }),
  });
  const r = h('div', { className: `row${done ? ' done' : ''}${t.id === sel ? ' sel' : ''}`, title: t.id, onclick: () => select(t.id) },
    cb, h('span', { className: 'badge' }, t.type), h('span', { className: 'title' }, t.title),
    tot.effort || tot.spent ? h('span', { className: 'muted' }, `${hours(tot.spent)}/${hours(tot.effort)} h`) : null);
  r.style.paddingLeft = `${4 + depth * 16}px`;
  return r;
}

function newTaskForm(): HTMLElement {
  const type = h('select', {}, ...Object.keys(db.format.types).map(n => h('option', {}, n)));
  const title = h('input', { type: 'text', placeholder: 'New top-level task', required: true });
  const file = h('input', { type: 'text', list: 'mado-files', value: db.files[0] ?? 'tasks.md', title: 'File to append to (a new name creates the file)' });
  return h('form', { className: 'inline', onsubmit: (e: Event) => { e.preventDefault(); run({ op: 'create', type: type.value, title: title.value, file: file.value }); } },
    type, title, file, h('datalist', { id: 'mado-files' }, ...db.files.map(f => h('option', { value: f }))), h('button', { className: 'primary' }, 'Add'));
}

// ---- Tasks tab: editor ----

/** Input for one schema property. Unchanged inputs are never written back, so values the widget cannot show are safe. */
function field(s: PropSchema, v: unknown, mark: () => void): HTMLInputElement | HTMLSelectElement {
  const str = v == null ? '' : String(v);
  if (s.enum || s.type === 'boolean') {
    const opts = s.enum ? s.enum.map(String) : ['true', 'false'];
    if (str && !opts.includes(str)) opts.push(str);
    return h('select', { value: str, title: s.description, onchange: mark }, h('option', { value: '' }, '(none)'), ...opts.map(o => h('option', { value: o }, o)));
  }
  const fits = s.type === 'number' ? typeof v === 'number' : s.type === 'date' ? typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) : true;
  const type = !fits && str ? 'text' : s.type === 'number' ? 'number' : s.type === 'date' ? 'date' : 'text';
  return h('input', { type, step: s.type === 'number' ? 'any' : undefined, value: str, title: s.description, oninput: mark });
}

function read(el: HTMLInputElement | HTMLSelectElement, s: PropSchema): unknown {
  const v = el.value.trim();
  if (!v) return undefined;
  if (s.enum) return s.enum.find(e => String(e) === v) ?? v;
  if (s.type === 'number') return Number.isFinite(Number(v)) ? Number(v) : v;
  if (s.type === 'boolean') return v === 'true' ? true : v === 'false' ? false : v;
  return v;
}

/** The editable fields: title/description form plus a separate props list for the sidebar. Saving sends only touched fields, merged onto the latest state, so concurrent file edits survive. */
function taskForm(t: Task): { form: HTMLFormElement; props: HTMLElement } {
  formFor = t.id;
  dirty = false;
  const touched = new Set<string>();
  const mark = (key: string) => () => { touched.add(key); dirty = true; save.disabled = revert.disabled = false; };
  const schema: Record<string, PropSchema> = {
    effort: { type: 'number', description: 'Estimated effort in hours' },
    spent: { type: 'number', description: 'Logged time in hours' },
    ...db.format.types[t.type]?.props,
  };

  const type = h('select', { value: t.type, onchange: mark('type') }, ...[...new Set([t.type, ...Object.keys(db.format.types)])].map(n => h('option', {}, n)));
  const title = h('input', { type: 'text', className: 'task-title', value: t.title, oninput: mark('title') });
  const done = h('input', { type: 'checkbox', checked: t.props.done === true, onchange: mark('p:done') });
  const fields = Object.entries(schema).map(([k, s]) => ({ k, s, el: field(s, t.props[k], mark('p:' + k)) }));
  const desc = h('textarea', { value: t.description, oninput: mark('description') });
  const extra = Object.keys(t.props).filter(k => !(k in schema) && k !== 'done' && k !== 'started');
  const save = h('button', { className: 'primary', disabled: true }, 'Save');
  const revert = h('button', { type: 'button', disabled: true, onclick: () => { dirty = false; render(); } }, 'Revert');

  const submit = (e: Event) => {
    e.preventDefault();
    const cur = db.tasks[t.id];
    if (!cur) return toast('This task no longer exists');
    const op: Extract<Op, { op: 'update' }> = { op: 'update', id: t.id };
    if (touched.has('type')) op.type = type.value;
    if (touched.has('title')) op.title = title.value;
    if (touched.has('description')) op.description = desc.value;
    const props = { ...cur.props };
    if (touched.has('p:done')) props.done = done.checked || undefined;
    for (const { k, s, el } of fields) if (touched.has('p:' + k)) props[k] = read(el, s);
    if ([...touched].some(k => k.startsWith('p:'))) op.props = props;
    run(op, true);
  };

  const f = h('form', { className: 'title-desc', onsubmit: submit },
    title,
    h('div', {}, h('h3', {}, 'Description'), desc),
    h('div', { className: 'actions' }, save, revert, h('span', { className: 'muted' }, 'Ctrl+S saves')));
  currentSubmit = () => f.requestSubmit();

  const props = h('div', { className: 'props-sidebar' },
    h('div', { className: 'prop' }, h('label', {}, 'Type'), type),
    h('div', { className: 'prop' }, h('label', {}, 'Done'), done),
    ...fields.map(({ k, s, el }) => h('div', { className: 'prop' }, h('label', { title: s.description ?? '' }, k === 'effort' || k === 'spent' ? `${k} (h)` : k), el)),
    ...extra.map(k => h('div', { className: 'prop' }, h('label', { className: 'muted' }, k), h('span', { className: 'muted' }, `${JSON.stringify(t.props[k])} (not in the schema; edit it in the file)`))));
  return { form: f, props };
}

/** Compact, label-less prop values short enough for the collapsed sidebar; long values are dropped rather than truncated into noise. */
function compactProps(t: Task): HTMLElement[] {
  const schema: Record<string, PropSchema> = {
    effort: { type: 'number', description: 'Estimated effort in hours' },
    spent: { type: 'number', description: 'Logged time in hours' },
    ...db.format.types[t.type]?.props,
  };
  const vals = [
    { k: 'Type', v: t.type },
    { k: 'Done', v: t.props.done === true ? '✓' : '' },
    ...Object.keys(schema).map(k => ({ k, v: t.props[k] == null ? '' : String(t.props[k]) })),
  ];
  return vals.filter(({ v }) => v && v.length <= 10).map(({ k, v }) => h('div', { className: 'prop-compact', title: `${k}: ${v}` }, v));
}

/** Parts of the editor that act immediately (timer, links, subtasks, deletion); rebuilt on every refresh. */
function live(t: Task) {
  // Time
  const started = Date.parse(String(t.props.started ?? '')), tot = db.totals[t.id];
  const timerBtn = isNaN(started)
    ? h('button', { onclick: () => run({ op: 'start', id: t.id }) }, 'Start timer')
    : h('button', { className: 'primary', onclick: () => run({ op: 'stop', id: t.id }) }, 'Stop timer ', h('span', { 'data-started': started }, clock(Date.now() - started)));
  const timeSummary = `Including subtasks: ${hours(tot.spent)} h spent of ${hours(tot.effort)} h estimated`;

  // Edges split by direction: outgoing ones are keyed by their own type (so they match a linkable kind),
  // incoming ones by their reverse name (read-only here; adding that link happens from the other task).
  const outgoing = new Map<string, { other: string; e: Edge }[]>();
  const incoming = new Map<string, { other: string; e: Edge }[]>();
  for (const e of db.edges) {
    if (e.from === t.id) outgoing.set(e.type, [...outgoing.get(e.type) ?? [], { other: e.to, e }]);
    if (e.to === t.id) { const name = e.reverse ?? `${e.type} (reverse)`; incoming.set(name, [...incoming.get(name) ?? [], { other: e.from, e }]); }
  }
  const li = ({ other, e }: { other: string; e: Edge }) => h('li', {},
    h('button', { className: 'link', onclick: () => select(other) },
      h('span', { className: 'badge' }, db.tasks[other]?.type ?? ''), ' ', db.tasks[other]?.title ?? other), ' ',
    h('button', {
      className: 'link', disabled: e.heading, onclick: () => run({ op: 'unlink', from: e.from, type: e.type, to: e.to }),
      title: e.heading ? 'Comes from heading nesting; move the heading in the file' : `Remove (declared at ${e.at.file}:${e.at.line + 1})`,
    }, '✕'));

  // One target-picker row per link kind, appended as the last list item instead of a separate form with a type combobox.
  const linkTypes = db.format.types[t.type]?.links ?? {};
  const addRow = (kind: string, focus: boolean) => {
    const allowed = kind in linkTypes ? Object.keys(linkTypes[kind]) : null;
    const listId = `mado-targets-${t.id}-${kind}`.replace(/\W+/g, '_');
    const targets = h('datalist', { id: listId }, ...Object.values(db.tasks).filter(o => o.id !== t.id && (!allowed || allowed.includes(o.type))).map(o => h('option', { value: o.id })));
    const target = h('input', { type: 'text', list: listId, placeholder: '[Type] Title of the target' });
    const form = h('form', { className: 'inline link-add', onsubmit: (e: Event) => { e.preventDefault(); run({ op: 'link', from: t.id, type: kind, to: target.value }); } },
      target, targets, h('button', {}, 'Link'));
    if (focus) setTimeout(() => target.focus(), 0);
    return h('li', {}, form);
  };

  // Subtasks always get a list (even empty); "Add subtask" is just its last row.
  const subType = h('select', { value: t.type }, ...Object.keys(db.format.types).map(n => h('option', {}, n)));
  const subTitle = h('input', { type: 'text', placeholder: 'New subtask', required: true });
  const subAddLi = h('li', {}, h('form', { className: 'inline', onsubmit: (e: Event) => { e.preventDefault(); run({ op: 'create', type: subType.value, title: subTitle.value, parent: t.id }); } },
    subType, subTitle, h('button', {}, 'Add subtask')));
  const linkBlocks = [h('div', { className: 'link-group' }, h('b', {}, SUBTASK), h('ul', {}, ...(outgoing.get(SUBTASK) ?? []).map(li), subAddLi))];

  // Other kinds: no list until there's a link or the user opened one with its "Link <kind>" button.
  // Parent is stored as a flipped Subtask edge, so its existing links live under the incoming "Parent" group, not outgoing.
  const linkRevealBtns: HTMLElement[] = [];
  for (const kind of [PARENT, ...Object.keys(linkTypes)]) {
    const entries = (kind === PARENT ? incoming.get(PARENT) : outgoing.get(kind)) ?? [];
    if (!entries.length && !revealedLinkKinds.has(kind)) {
      linkRevealBtns.push(h('button', { type: 'button', onclick: () => { revealedLinkKinds.add(kind); render(); } }, `Link ${kind}`));
    } else {
      linkBlocks.push(h('div', { className: 'link-group' }, h('b', {}, kind), h('ul', {}, ...entries.map(li), addRow(kind, !entries.length))));
    }
  }
  const incomingBlocks = [...incoming].filter(([name]) => name !== PARENT).map(([name, list]) => h('div', { className: 'link-group' }, h('b', {}, name), h('ul', {}, ...list.map(li))));

  // Delete: two clicks instead of confirm(), which webviews block
  const deleteBtn = h('button', {
    type: 'button',
    onclick: () => {
      if (deleteBtn.textContent !== 'Delete') return run({ op: 'delete', id: t.id });
      deleteBtn.textContent = 'Click again: deletes every occurrence with all nested content';
      setTimeout(() => { deleteBtn.textContent = 'Delete'; }, 4000);
    },
  }, 'Delete');

  const occurrences = t.occurrences.map(o => h('div', { className: 'muted' },
    `${o.file}:${o.line + 1}${o.file === t.home.file && o.line === t.home.line ? ' (properties and description)' : ''}`));

  return { timerBtn, timeSummary, linkBlocks, linkRevealBtns, incomingBlocks, occurrences, deleteBtn };
}

// ---- Graph tab ----

function graph(): HTMLElement {
  const toggle = h('label', {}, h('input', { type: 'checkbox', checked: showSubtasks, onchange: () => { showSubtasks = !showSubtasks; render(); } }), ' Show subtask links');
  const edges = db.edges.filter(e => showSubtasks || e.type !== SUBTASK);
  const ids = [...new Set(edges.flatMap(e => [e.from, e.to]))];
  if (!ids.length) return h('div', { className: 'view' }, toggle, h('p', { className: 'muted' }, 'No links to show.'));

  // Columns: DFS marks back edges (cycles); longest path over the remaining DAG gives each task its column
  const out = new Map<string, Edge[]>(ids.map(i => [i, []]));
  for (const e of edges) out.get(e.from)!.push(e);
  const state = new Map<string, number>(), back = new Set<Edge>(), order: string[] = [];
  const dfs = (v: string) => {
    state.set(v, 1);
    for (const e of out.get(v)!) { if (state.get(e.to) === 1) back.add(e); else if (!state.has(e.to)) dfs(e.to); }
    state.set(v, 2);
    order.push(v);
  };
  for (const v of ids) if (!state.has(v)) dfs(v);
  const layer = new Map<string, number>();
  for (const v of order.reverse()) {
    const l = layer.get(v) ?? 0;
    layer.set(v, l);
    for (const e of out.get(v)!) if (!back.has(e)) layer.set(e.to, Math.max(layer.get(e.to) ?? 0, l + 1));
  }

  // Rows: one barycenter pass orders each column by the mean row of its predecessors (fewer crossings)
  const cols: string[][] = [], row = new Map<string, number>(), preds = new Map<string, string[]>();
  for (const v of ids) (cols[layer.get(v)!] ??= []).push(v);
  for (const e of edges) if (!back.has(e)) preds.set(e.to, [...preds.get(e.to) ?? [], e.from]);
  const bary = (v: string) => { const p = preds.get(v) ?? []; return p.length ? p.reduce((a, u) => a + row.get(u)!, 0) / p.length : 0; };
  cols.forEach((col, c) => { if (c) col.sort((a, b) => bary(a) - bary(b)); col.forEach((v, i) => row.set(v, i)); });

  // Drawing
  const W = 210, H = 34, GX = 80, GY = 14, PX = 10, PY = 40;
  const x = (v: string) => PX + layer.get(v)! * (W + GX), y = (v: string) => PY + row.get(v)! * (H + GY);
  const width = 2 * PX + cols.length * (W + GX) - GX, height = PX + PY + Math.max(...cols.map(c => c.length)) * (H + GY) - GY;
  const svg = s('svg', { class: 'graph', width, height, viewBox: `0 0 ${width} ${height}` });
  for (const e of edges) {
    const x1 = x(e.from) + W, y1 = y(e.from) + H / 2, x2 = x(e.to), y2 = y(e.to) + H / 2, c = hue(e.type), dx = Math.max(40, Math.abs(x2 - x1) / 2);
    // Edges skipping columns (and back edges) arc through the gap above their rows instead of crossing boxes in between.
    // shortcut: diagonal long edges may still cross boxes of other rows; add dummy nodes per column if graphs get dense
    const long = back.has(e) || layer.get(e.to)! - layer.get(e.from)! > 1, cy = Math.min(y1, y2) - (H + GY) / 1.5;
    svg.append(s('path', { d: `M${x1},${y1} C${x1 + dx},${long ? cy : y1} ${x2 - dx},${long ? cy : y2} ${x2},${y2}`, fill: 'none', stroke: c, 'stroke-width': 1.5, 'stroke-dasharray': back.has(e) ? '5 4' : 'none' },
      s('title', {}, `${e.from}  ${e.type}  ${e.to}`)), s('path', { d: `M${x2},${y2} l-8,-4 v8 z`, fill: c }));
  }
  for (const v of ids) {
    const t = db.tasks[v];
    const g = s('g', { transform: `translate(${x(v)},${y(v)})` },
      s('rect', { width: W, height: H, rx: 6, class: t.props.done === true ? 'done' : '' }),
      s('text', { x: 8, y: H / 2 + 4 }, trunc(v, 30)), s('title', {}, v));
    g.addEventListener('click', () => select(v));
    svg.append(g);
  }

  const legend = h('div', { className: 'legend' }, toggle, ...[...new Set(edges.map(e => e.type))].map(n => {
    const sw = h('span', { className: 'swatch' });
    sw.style.background = hue(n);
    return h('span', {}, sw, n);
  }), h('span', { className: 'muted' }, 'Dashed: link closing a cycle. Click a task to edit it.'));
  return h('div', { className: 'view' }, legend, svg);
}

// ---- Time tab ----

function time(): HTMLElement {
  const n = (v: number) => h('td', { className: 'n' }, v ? hours(v) : '');
  const rows: HTMLElement[] = [], byType = new Map<string, { count: number; done: number; effort: number; spent: number }>();
  walk((t, d) => {
    const tot = db.totals[t.id], effort = Number(t.props.effort) || 0, spent = Number(t.props.spent) || 0;
    const name = h('td', {}, h('button', { className: 'link', onclick: () => select(t.id) }, t.title));
    name.style.paddingLeft = `${8 + d * 16}px`;
    rows.push(h('tr', { className: tot.effort && tot.spent > tot.effort ? 'over' : '' }, name, h('td', {}, h('span', { className: 'badge' }, t.type)),
      n(effort), n(spent), n(tot.effort), n(tot.spent),
      h('td', {}, tot.effort ? h('progress', { max: tot.effort, value: Math.min(tot.spent, tot.effort), title: `${Math.round(100 * tot.spent / tot.effort)}%` }) : '')));
  });
  for (const t of Object.values(db.tasks)) {
    const b = byType.get(t.type) ?? { count: 0, done: 0, effort: 0, spent: 0 };
    b.count++;
    b.done += t.props.done === true ? 1 : 0;
    b.effort += Number(t.props.effort) || 0;
    b.spent += Number(t.props.spent) || 0;
    byType.set(t.type, b);
  }
  const th = (t: string, num = false) => h('th', { className: num ? 'n' : '' }, t);
  return h('div', { className: 'view' },
    h('table', {}, h('thead', {}, h('tr', {}, th('Task'), th('Type'), th('Effort', true), th('Spent', true), th('Σ Effort', true), th('Σ Spent', true), th('Progress'))), h('tbody', {}, ...rows)),
    h('p', { className: 'muted' }, 'Hours. Σ columns include every subtask once. Red rows have spent more than estimated.'),
    h('table', {}, h('thead', {}, h('tr', {}, th('Type'), th('Tasks', true), th('Done', true), th('Effort', true), th('Spent', true))),
      h('tbody', {}, ...[...byType].map(([type, b]) => h('tr', {}, h('td', {}, type), n(b.count), n(b.done), n(b.effort), n(b.spent))))));
}

// ---- Main ----

/** Drag the left edge to resize; pointer capture keeps tracking even if the cursor leaves the handle. */
function makeResizable(panel: HTMLElement, handle: HTMLElement) {
  handle.onpointerdown = e => {
    e.preventDefault();
    const startX = e.clientX, startWidth = panel.getBoundingClientRect().width;
    const onMove = (ev: PointerEvent) => {
      sidebarWidth = Math.min(600, Math.max(160, startWidth - (ev.clientX - startX)));
      panel.style.width = `${sidebarWidth}px`;
    };
    const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };
}

function render() {
  if (url() !== location.pathname) history.replaceState(null, '', url());
  header();
  const main = $('main');
  if (tab === 'Graph') return main.replaceChildren(graph());
  if (tab === 'Time') return main.replaceChildren(time());
  const t = sel ? db.tasks[sel] : undefined;
  if (!t) { sel = null; dirty = false; }
  if (!t) {
    main.replaceChildren(sidebar(), h('section', { className: 'editor muted' }, 'Select a task, or add one in the sidebar.'));
    return;
  }

  const keep = dirty && formBundle && formFor === sel;
  const bundle = keep ? formBundle! : (formBundle = taskForm(t));
  const lv = live(t);

  const sidebarContent = sidebarCollapsed
    ? [...compactProps(t), lv.timerBtn, lv.deleteBtn]
    : [
        bundle.props,
        h('div', { className: 'sidebar-section' }, h('h3', {}, 'Time'), h('div', { className: 'actions' }, lv.timerBtn, h('span', { className: 'muted' }, lv.timeSummary))),
        h('div', { className: 'sidebar-section' }, h('h3', {}, 'Stored in'), ...lv.occurrences),
        h('div', { className: 'sidebar-section actions' }, lv.deleteBtn),
      ];

  const resizeHandle = h('div', { className: 'sidebar-resize' });
  const collapseBtn = h('button', {
    type: 'button', className: 'sidebar-collapse', title: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
    onclick: () => { sidebarCollapsed = !sidebarCollapsed; render(); },
  }, sidebarCollapsed ? '◀' : '▶');
  const panel = h('aside', { className: `sidebar-panel${sidebarCollapsed ? ' collapsed' : ''}` },
    resizeHandle, collapseBtn, h('div', { className: 'sidebar-scroll' }, ...sidebarContent));
  if (!sidebarCollapsed) panel.style.width = `${sidebarWidth}px`;
  makeResizable(panel, resizeHandle);

  const editorMain = h('div', { className: 'editor-main' }, bundle.form,
    h('div', { className: 'links' }, h('h3', {}, 'Links'), ...lv.linkBlocks, ...lv.linkRevealBtns, ...lv.incomingBlocks));

  main.replaceChildren(sidebar(), h('section', { className: 'editor' }, h('div', { className: 'editor-row' }, editorMain, panel)));
}

setInterval(() => document.querySelectorAll<HTMLElement>('[data-started]').forEach(el => { el.textContent = clock(Date.now() - Number(el.dataset.started)); }), 1000);
db = await api.state();
({ tab, sel = null } = route());
render();
api.subscribe(async () => { db = await api.state(); render(); });
