/**
 * Plandown GUI: task tree and editor, link graph and time view. Plain DOM, no framework.
 * Talks to the library only through `api`, so a VSCode webview can swap the transport.
 */
import type { Db, Edge, Task } from '../db.js';
import type { Op } from '../edit.js';
import type { PropSchema } from '../format.js';
import type { TreeNode } from '../tree.js';
import { mdEditor } from './mdedit.js';
import { appear, show, still } from './motion.js';

const SUBTASK = 'Subtask', PARENT = 'Parent';

// ---- Transport ----

/** HTTP transport of the standalone server. A VSCode webview replaces these three functions with postMessage calls. */
const api = {
  state: async (): Promise<Db> => (await fetch('api/state')).json(),
  async op(op: Op): Promise<{ id?: string; db: Db; error?: string }> {
    const r = await fetch('api/op', { method: 'POST', headers: { 'content-type': 'application/json', 'x-plandown': '1' }, body: JSON.stringify(op) });
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

/** Stroke icons on a 16px grid, drawn in `currentColor`: inline paths keep the GUI free of dependencies and requests. */
const ICONS = {
  list: 'M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  graph: 'M1.5 2.5h4v3h-4zM10.5 6.5h4v3h-4zM1.5 10.5h4v3h-4zM5.5 4h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1M7.5 8h3',
  clock: 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM8 5v3l2 1.5',
  alert: 'M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5h.01',
  plus: 'M8 3v10M3 8h10',
  folderPlus: 'M1.5 3.5h4.5l1.5 2h7v7h-13zM8 7.5v4M6 9.5h4',
  check: 'M3 8.5l3 3 7-7',
  undo: 'M5.5 3.5l-3 3 3 3M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7',
  play: 'M5 3l8 5-8 5z',
  stop: 'M4 4h8v8H4z',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1',
  x: 'M4 4l8 8M12 4l-8 8',
  trash: 'M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v4.5M9.5 6.5v4.5',
  left: 'M10 3L5 8l5 5',
  right: 'M6 3l5 5-5 5',
};
const icon = (n: keyof typeof ICONS) => s('svg', { class: 'ico', viewBox: '0 0 16 16', 'aria-hidden': 'true' }, s('path', { d: ICONS[n] }));

/** Layout changes (navigation, sidebar collapse, op results) morph from the old layout through a view transition, where supported. */
const transition = (f: () => void) => { if (document.startViewTransition && !still()) document.startViewTransition(f); else f(); };

const $ = (id: string) => document.getElementById(id)!;
const hours = (v: number) => String(Math.round(v * 100) / 100);
const clock = (ms: number) => { const t = Math.floor(ms / 1000); return [t / 3600, (t / 60) % 60, t % 60].map(x => String(Math.floor(x)).padStart(2, '0')).join(':'); };
const trunc = (t: string, n: number) => t.length > n ? t.slice(0, n - 1) + '…' : t;
/** Color per link type: golden-angle hues over the format's link types keep colors distinct and stable. */
const hue = (t: string) => {
  const i = [SUBTASK, ...new Set(Object.values(db.format.types).flatMap(x => Object.keys(x.links)))].indexOf(t);
  return i < 0 ? 'gray' : `hsl(${(30 + i * 137.5) % 360} 65% 50%)`;
};

/** Gives `el` its task type's color as `--c` (read by buttons and bubbles); colors the browser rejects are ignored. */
function typed<T extends HTMLElement>(el: T, type: string): T {
  const c = db.format.types[type]?.color;
  if (c && CSS.supports('color', c)) el.style.setProperty('--c', c);
  return el;
}
const badge = (type: string) => typed(h('span', { className: 'badge' }, type), type);

let toastTimer:ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  show(t, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(t, false), 5000);
}

/**
 * Depth-first over Subtask links from `roots`, or else from tasks without a parent. A task seen before is listed again
 * but not expanded, which keeps shared subtasks and cycles linear; without `roots`, tasks only reachable through a cycle come last.
 */
function walk(visit: (t: Task, depth: number) => void, roots?: string[], depth = 0) {
  const kids = new Map<string, string[]>(), hasParent = new Set<string>(), seen = new Set<string>();
  for (const e of db.edges) if (e.type === SUBTASK) { kids.set(e.from, [...kids.get(e.from) ?? [], e.to]); hasParent.add(e.to); }
  const go = (id: string, d: number) => {
    visit(db.tasks[id], d);
    if (seen.has(id)) return;
    seen.add(id);
    for (const c of kids.get(id) ?? []) go(c, d + 1);
  };
  if (roots) return roots.forEach(id => go(id, depth));
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
let formBundle: Form | null = null, formFor = '';
let currentSubmit: (() => void) | null = null;   // bound to whichever form is live, so Ctrl+S works from the sidebar too
/** Side panes: the navigation tree (left) and the task's properties (right). */
interface Pane { width: number; collapsed: boolean }
const panes: Record<'nav' | 'props', Pane> = { nav: { width: 340, collapsed: false }, props: { width: 280, collapsed: false } };
// Collapsed panes survive reloads within the browser session (saved by `render`)
try { for (const k of (sessionStorage.getItem('plandown-collapsed') ?? '').split(',')) if (Object.hasOwn(panes, k)) panes[k as keyof typeof panes].collapsed = true; } catch { /* not persisted */ }
let revealedLinkKinds = new Set<string>();        // link types the user opened an empty list for, this task only
// Tree selection, apart from navigation (`sel`): the picked row and the tree node new groups and tasks go near ('' : root)
let pick: { key: string; near: string } | null = null;
let pickSel = true;                                               // the first tree build picks the row of `sel` (the page's URL)
let adding: { type: string | null; text: string } | null = null;   // open "create" row; type null: a group
let focusAdd = false;                                             // focus the create row once it is built

/**
 * Runs an operation, adopts the returned state and tells whether it succeeded. Only editor saves clear `dirty`;
 * only saves and top-level creates move the selection; a new group becomes the picked tree node.
 */
async function run(op: Op, fromEditor = false): Promise<boolean> {
  let ok = false;
  try {
    const r = await api.op(op);
    db = r.db;
    if (r.error) toast(r.error);
    else {
      ok = true;
      if (fromEditor) dirty = false;
      if (op.op === 'delete' && op.id === sel) { sel = null; dirty = false; }
      else if (op.op === 'group' && r.id) pick = { key: r.id + '\0', near: r.id };
      else if (r.id && db.tasks[r.id] && !dirty && (fromEditor || (op.op === 'create' && !op.parent))) sel = r.id;
    }
  } catch (e) {
    toast((e as Error).message);
  }
  transition(render);
  return ok;
}

/** Click handler running `f` for plain clicks only; modified clicks (new tab or window) stay with the browser, as middle clicks do. */
const inApp = (f: () => void) => (e: MouseEvent) => { if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; e.preventDefault(); f(); };

/** Link to a task's view: a real `href` gives it the browser's link controls; plain clicks `select` in-app (or run `props.onclick`). */
const taskLink = (id: string, props: Record<string, unknown>, ...kids: (Node | string | null)[]) =>
  h('a', { href: db.tasks[id] && viewUrl(db.tasks[id]), onclick: inApp(() => select(id)), ...props }, ...kids);

/** Navigates to a task; returns false (without rendering) when unsaved edits block it. */
function select(id: string): boolean {
  if (dirty && id !== sel) { toast('Save or revert your changes first'); return false; }
  if (id !== sel) revealedLinkKinds = new Set();
  sel = id;
  tab = 'Tasks';
  go();
  return true;
}

// ---- Routing ----

const viewUrl = (t: Task) => '/view/' + encodeURIComponent(t.anchor);

/** Path naming the current view: `/view/<anchor>` (selected task), `/graph`, `/time`, or `/`. */
function url(): string {
  if (tab !== 'Tasks') return '/' + tab.toLowerCase();
  const t = sel ? db.tasks[sel] : undefined;
  return t ? viewUrl(t) : '/';
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
  transition(render);
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
  transition(render);
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
    try { localStorage.setItem('plandown-theme', next); } catch { /* not persisted */ }
    applyTheme(next);
  };
}
let savedTheme: string | null = null;
try { savedTheme = localStorage.getItem('plandown-theme'); } catch { /* auto */ }
applyTheme(THEMES.find(t => t === savedTheme) ?? 'auto');

// ---- Header ----

function header() {
  const tabIcon = { Tasks: 'list', Graph: 'graph', Time: 'clock' } as const;
  $('tabs').replaceChildren(...(['Tasks', 'Graph', 'Time'] as const).map(n => h('button', { className: n === tab ? 'on' : '', onclick: () => { tab = n; go(); } }, icon(tabIcon[n]), n)));
  $('timers').replaceChildren(...Object.values(db.tasks).filter(t => t.props.started).map(t => {
    const st = Date.parse(String(t.props.started));
    return taskLink(t.id, { className: 'link', title: 'Running timer' }, icon('clock'), `${trunc(t.title, 30)} `, h('span', { 'data-started': st }, clock(Date.now() - st)));
  }));
  const errors = db.diagnostics.filter(d => d.severity === 'error').length, warnings = db.diagnostics.length - errors;
  const dt = $('diag-toggle');
  dt.replaceChildren(icon('alert'), `${errors} errors, ${warnings} warnings`);
  dt.className = `link ${errors ? 'error' : warnings ? 'warning' : ''}`;
  dt.onclick = () => show($('diags'));
  $('diags').replaceChildren(...db.diagnostics.map(d => h('div', { className: d.severity }, `${d.file}:${d.line + 1}: ${d.message}`)));
}

// ---- Tasks tab: sidebar ----

function sidebar(): HTMLElement {
  const handle = h('div', { className: 'sidebar-resize' }), head = paneHead(panes.nav, 'Navigation', 'right');
  makeResizable(panes.nav, handle, '.sidebar', 1);
  if (panes.nav.collapsed) return h('aside', { className: 'sidebar collapsed' }, handle, head, createSection());
  // Clicking empty tree space drops the tree selection (new items then go to the root); navigation stays
  const tree = h('div', { id: 'tree', onclick: (e: Event) => { if (e.target === tree) { pick = null; fillTree(tree); } } });
  const search = h('input', { type: 'search', placeholder: 'Filter tasks', value: filter, oninput: () => { filter = search.value; fillTree(tree); } });
  fillTree(tree);
  const aside = h('aside', { className: 'sidebar' }, handle, head, search, tree, createSection());
  aside.style.width = `${panes.nav.width}px`;
  return aside;
}

/** Filtered: a flat list of matches. Otherwise each node: its row (or its merged task), top-level tasks with subtasks, child nodes, and the create row if it targets the node. */
function fillTree(tree = $('tree')) {
  const rows: HTMLElement[] = [], q = filter.toLowerCase();
  if (q) {
    for (const t of Object.values(db.tasks)) if (`${t.id}\n${t.body.filter(x => typeof x === 'string').join('\n')}`.toLowerCase().includes(q)) rows.push(row(t, 0, t.home.file.slice(0, -3)));
    return tree.replaceChildren(...rows);
  }
  let slot: [number, number] | null = null;   // row index and depth of the create row
  const node = (n: TreeNode, d: number) => {
    if (n.task) walk((t, td) => rows.push(row(t, td, n.path, td === d ? n : undefined)), [n.task], d);
    else { rows.push(nodeRow(n, d)); walk((t, td) => rows.push(row(t, td, n.path)), n.tasks, d + 1); }
    n.kids.forEach(k => node(k, d + 1));
    if (pick?.near === n.path) slot = [rows.length, n.task ? d : d + 1];   // a merged node gets a sibling
  };
  db.tree.forEach(n => node(n, 0));
  // A picked row that vanished (deleted, renamed, merged) no longer names a target
  if (pick && !rows.some(r => r.dataset.key === pick!.key)) { pick = null; slot = null; }
  // A page opened on a task picks the task's first row (once, so dropping the pick later sticks)
  if (pickSel) {
    pickSel = false;
    const r = sel && rows.find(r => r.dataset.key!.endsWith('\0' + sel));
    if (r) { pick = { key: r.dataset.key!, near: r.dataset.key!.split('\0')[0] }; r.classList.add('sel'); }
  }
  if (adding) { const [i, d] = slot ?? [rows.length, 0]; rows.splice(i, 0, addRow(d)); }
  tree.replaceChildren(...rows);
}

const nodeIcon = (n: TreeNode) => h('span', { className: 'icon' }, n.folder ? '📁' : '📄');

/** Task row under tree node `near`; `merged` is the node the task is merged with (shown with its icon). */
function row(t: Task, depth: number, near: string, merged?: TreeNode): HTMLElement {
  const done = t.props.done === true, tot = db.totals[t.id], key = `${near}\0${t.id}`;
  const cb = h('input', {
    type: 'checkbox', checked: done, title: 'Done',
    onclick: (e: Event) => e.stopPropagation(),
    onchange: () => run({ op: 'update', id: t.id, props: { ...t.props, done: cb.checked || undefined } }),
  });
  const r = taskLink(t.id, {
    className: `row${done ? ' done' : ''}${pick?.key === key ? ' sel' : ''}${t.id === sel ? ' cur' : ''}`, title: merged?.file ? `${t.id}\n${merged.file}` : t.id, 'data-key': key,
    onclick: inApp(() => { pick = { key, near }; if (!select(t.id)) fillTree(); }),
  }, cb, merged ? nodeIcon(merged) : null, badge(t.type), h('span', { className: 'title' }, t.title),
    tot.effort || tot.spent ? h('span', { className: 'muted' }, `${hours(tot.spent)}/${hours(tot.effort)} h`) : null);
  r.style.paddingLeft = `${4 + depth * 16}px`;
  return r;
}

/** Folder and/or file row; picking it only sets where new items go. */
function nodeRow(n: TreeNode, depth: number): HTMLElement {
  const key = n.path + '\0';
  const r = h('div', { className: `row node${pick?.key === key ? ' sel' : ''}`, title: n.file ?? n.path + '/', 'data-key': key, onclick: () => { pick = { key, near: n.path }; fillTree(); } },
    nodeIcon(n), h('span', { className: 'title' }, n.path.slice(n.path.lastIndexOf('/') + 1)));
  r.style.paddingLeft = `${4 + depth * 16}px`;
  return r;
}

/** Inline name input for the open create action; Enter creates near the picked node, Escape cancels. Survives tree refreshes. */
function addRow(depth: number): HTMLElement {
  const a = adding!, near = pick?.near ?? '';
  const input = h('input', {
    type: 'text', className: 'add-input', value: a.text, placeholder: a.type ? 'Title' : 'Group name',
    oninput: () => { a.text = input.value; },
    onkeydown: async (e: KeyboardEvent) => {
      if (e.key === 'Escape') { adding = null; fillTree(); }
      if (e.key !== 'Enter' || !input.value.trim()) return;
      adding = null;
      // On failure (toasted) the row comes back with the typed text
      if (!await run(a.type ? { op: 'create', type: a.type, title: input.value, near } : { op: 'group', name: input.value, near })) { adding = a; focusAdd = true; fillTree(); }
    },
  });
  // The previous row is still in the document here: keep focus across refreshes
  const opened = focusAdd;
  if (focusAdd || document.activeElement?.classList.contains('add-input')) { focusAdd = false; setTimeout(() => input.focus()); }
  const r = h('div', { className: 'row add-row' }, a.type ? badge(a.type) :h('span', { className: 'icon' }, '📁'), input);
  r.style.paddingLeft = `${4 + depth * 16}px`;
  if (opened) appear(r);
  return r;
}

/**
 * "Create a new..." buttons: a group, separated from one button per task type. Each opens the create row near the picked node.
 * Also shown in the collapsed sidebar, where a click expands it.
 */
function createSection(): HTMLElement {
  const b = (label: string, type: string | null) => typed(h('button', {
    type: 'button', title: `New ${type ?? 'group'}`,
    onclick: () => {
      adding = { type, text: adding?.text ?? '' };
      focusAdd = true;
      // The create row lives in the unfiltered, expanded tree
      if (panes.nav.collapsed) { filter = ''; panes.nav.collapsed = false; transition(render); }
      else if (filter) { filter = ''; transition(render); } else fillTree();
    },
  }, icon(type ? 'plus' : 'folderPlus'), label), type ?? '');
  return h('div', { className: 'create' }, h('h3', {}, 'Create a new...'),
    h('div', { className: 'actions' }, b('Group', null), h('span', { className: 'sep' }), ...Object.keys(db.format.types).map(t => b(t, t))));
}

// ---- Tasks tab: editor ----

/**
 * Input for one schema property and a getter of its raw text; plain strings get a line-mode Markdown editor.
 * Unchanged inputs are never written back, so values the widget cannot show are safe.
 */
function field(s: PropSchema, v: unknown, mark: () => void): { el: HTMLElement; value: () => string } {
  const str = v == null ? '' : String(v);
  if (s.enum || s.type === 'boolean') {
    const opts = s.enum ? s.enum.map(String) : ['true', 'false'];
    if (str && !opts.includes(str)) opts.push(str);
    const sel = h('select', { value: str, title: s.description, onchange: mark }, h('option', { value: '' }, '(none)'), ...opts.map(o => h('option', { value: o }, o)));
    return { el: sel, value: () => sel.value };
  }
  if (s.type === 'string') {
    const ed = mdEditor({ mode: 'line', parts: [str], label: s.description, placeholder: 'Empty', onInput: mark });
    return { el: ed.el, value: () => ed.texts()[0] };
  }
  const fits = s.type === 'number' ? typeof v === 'number' : s.type === 'date' ? typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) : true;
  const type = !fits && str ? 'text' : s.type === 'number' ? 'number' : s.type === 'date' ? 'date' : 'text';
  const input = h('input', { type, step: s.type === 'number' ? 'any' : undefined, value: str, title: s.description, oninput: mark });
  if (type !== 'number') return { el: input, value: () => input.value };
  // Own spin buttons: native ones cannot be styled. Manual math, since stepUp() throws on step="any"
  const spin = (d: number, label: string) => h('button', { type: 'button', tabIndex: -1, onclick: () => { input.value = String((Number(input.value) || 0) + d); mark(); } }, label);
  return { el: h('span', { className: 'spin' }, input, spin(1, '▲'), spin(-1, '▼')), value: () => input.value };
}

function read(raw: string, s: PropSchema): unknown {
  const v = raw.trim();
  if (!v) return undefined;
  if (s.enum) return s.enum.find(e => String(e) === v) ?? v;
  if (s.type === 'number') return Number.isFinite(Number(v)) ? Number(v) : v;
  if (s.type === 'boolean') return v === 'true' ? true : v === 'false' ? false : v;
  return v;
}

/** Description slot holding the link groups of one task-list block, at its place in the text. */
interface Slot { el: HTMLElement; kinds: string[] }
interface Form { form: HTMLElement; props: HTMLElement; slots: Slot[] }

/**
 * The editable fields: title row (with page-wide Save/Revert), description, and a separate props list for the sidebar.
 * Saving sends only touched fields, merged onto the latest state, so concurrent file edits survive.
 */
function taskForm(t: Task): Form {
  formFor = t.id;
  dirty = false;
  const touched = new Set<string>();
  const mark = (key: string) => () => {
    touched.add(key);
    dirty = true;
    show(save, true); show(revert, true);
  };
  const schema: Record<string, PropSchema> = {
    effort: { type: 'number', description: 'Estimated effort in hours' },
    spent: { type: 'number', description: 'Logged time in hours' },
    ...db.format.types[t.type]?.props,
  };

  const type = h('select', { value: t.type, onchange: mark('type') }, ...[...new Set([t.type, ...Object.keys(db.format.types)])].map(n => h('option', {}, n)));
  const title = mdEditor({ mode: 'line', parts: [t.title], multiline: false, label: 'Title', className: 'task-title', onInput: mark('title') });
  const done = h('input', { type: 'checkbox', checked: t.props.done === true, onchange: mark('p:done') });
  const fields = Object.entries(schema).map(([k, s]) => ({ k, s, el: field(s, t.props[k], mark('p:' + k)) }));
  // Description: link lists stay where they are in the file; `live` refills their slots on every render
  const slots = t.body.filter(x => typeof x !== 'string').map(x => ({ el: h('div'), kinds: x.links }));
  let n = 0;
  const desc = mdEditor({ mode: 'block', parts: t.body.map(x => typeof x === 'string' ? x : slots[n++].el), label: 'Description', placeholder: 'Description', onInput: mark('body') });
  const extra = Object.keys(t.props).filter(k => !(k in schema) && k !== 'done' && k !== 'started');
  const save = h('button', { className: 'good', hidden: true, title: 'Ctrl+S', onclick: () => submit() }, icon('check'), 'Save');
  const revert = h('button', { className: 'neutral', hidden: true, onclick: () => { dirty = false; transition(render); } }, icon('undo'), 'Revert');

  const submit = () => {
    const cur = db.tasks[t.id];
    if (!cur) return toast('This task no longer exists');
    const op: Extract<Op, { op: 'update' }> = { op: 'update', id: t.id };
    if (touched.has('type')) op.type = type.value;
    if (touched.has('title')) op.title = title.texts()[0];
    if (touched.has('body')) op.body = desc.texts();
    const props = { ...cur.props };
    if (touched.has('p:done')) props.done = done.checked || undefined;
    for (const { k, s, el } of fields) if (touched.has('p:' + k)) props[k] = read(el.value(), s);
    if ([...touched].some(k => k.startsWith('p:'))) op.props = props;
    run(op, true);
  };

  const f = h('div', { className: 'title-desc' },
    h('div', { className: 'title-row' }, title.el, save, revert),
    desc.el);
  currentSubmit = submit;

  const props = h('div', { className: 'props-sidebar' },
    h('div', { className: 'prop' }, h('label', {}, 'Type'), type),
    h('div', { className: 'prop' }, h('label', {}, 'Done'), done),
    ...fields.map(({ k, s, el }) => h('div', { className: 'prop' }, h('label', { title: s.description ?? '' }, k === 'effort' || k === 'spent' ? `${k} (h)` : k), el.el)),
    ...extra.map(k => h('div', { className: 'prop' }, h('label', { className: 'muted' }, k), h('span', { className: 'muted' }, `${JSON.stringify(t.props[k])} (not in the schema; edit it in the file)`))));
  return { form: f, props, slots };
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
  return vals.filter(({ v }) => v && v.length <= 6).map(({ k, v }) => h('div', { className: 'prop-compact', title: `${k}: ${v}` }, v));
}

/** Parts of the editor that act immediately (timer, links, subtasks, deletion); rebuilt on every refresh, refilling the form's link slots. */
function live(t: Task, slots: Slot[]) {
  // Time
  const started = Date.parse(String(t.props.started ?? '')), tot = db.totals[t.id];
  const timerBtn = isNaN(started)
    ? h('button', { title: 'Start timer', onclick: () => run({ op: 'start', id: t.id }) }, icon('play'), 'Start timer')
    : h('button', { className: 'warn', title: 'Stop timer', onclick: () => run({ op: 'stop', id: t.id }) }, icon('stop'), 'Stop timer ', h('span', { 'data-started': started }, clock(Date.now() - started)));
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
    taskLink(other, { className: 'link' },
      badge(db.tasks[other]?.type ?? ''), ' ', db.tasks[other]?.title ?? other), ' ',
    h('button', {
      className: 'bad', disabled: e.heading, onclick: () => run({ op: 'unlink', from: e.from, type: e.type, to: e.to }),
      title: e.heading ? 'Comes from heading nesting; move the heading in the file' : `Remove (declared at ${e.at.file}:${e.at.line + 1})`,
    }, icon('x')));

  // One target-picker row per link kind, appended as the last list item instead of a separate form with a type combobox.
  const linkTypes = db.format.types[t.type]?.links ?? {};
  const addRow = (kind: string, focus: boolean) => {
    const allowed = kind in linkTypes ? Object.keys(linkTypes[kind]) : null;
    const listId = `plandown-targets-${t.id}-${kind}`.replace(/\W+/g, '_');
    const ids = new Set(Object.values(db.tasks).filter(o => o.id !== t.id && (!allowed || allowed.includes(o.type))).map(o => o.id));
    const targets = h('datalist', { id: listId }, ...[...ids].map(id => h('option', { value: id })));
    // The Link button appears only once the input names a valid target
    const btn = h('button', { hidden: true }, icon('link'), 'Link');
    const target = h('input', { type: 'text', list: listId, placeholder: 'search to link', oninput: () => show(btn, ids.has(target.value)) });
    const form = h('form', { className: 'inline link-add', onsubmit: (e: Event) => { e.preventDefault(); if (ids.has(target.value)) run({ op: 'link', from: t.id, type: kind, to: target.value }); } },
      target, targets, btn);
    if (focus) setTimeout(() => target.focus(), 0);
    return h('li', {}, form);
  };

  // Subtasks always get a list (even empty); its last row is a title input that reveals one "Make it a <type>" button per type.
  // Enter submits through the first type button (implicit submission).
  const subTypes = h('div', { className: 'sub-types', hidden: true }, h('span', { className: 'muted' }, 'Make it a'),
    ...Object.keys(db.format.types).map(n => typed(h('button', { value: n }, n), n)));
  const subTitle = h('input', { type: 'text', placeholder: 'New subtask', required: true, oninput: () => show(subTypes, !!subTitle.value.trim()) });
  const subAddLi = h('li', {}, h('form', { className: 'sub-add', onsubmit: (e: SubmitEvent) => { e.preventDefault(); run({ op: 'create', type: (e.submitter as HTMLButtonElement | null)?.value ?? t.type, title: subTitle.value, parent: t.id }); } },
    subTitle, subTypes));
  // One group per link kind. Parent is stored as a flipped Subtask edge, so its links are the incoming "Parent" ones.
  const entries = (kind: string) => (kind === PARENT ? incoming.get(PARENT) : outgoing.get(kind)) ?? [];
  const group = (kind: string, focus = false) => h('div', { className: 'link-group' }, h('b', {}, kind),
    h('ul', {}, ...entries(kind).map(li), kind === SUBTASK ? subAddLi : addRow(kind, focus)));

  // Description slots: the first task-list block of a kind shows its group, later blocks of that kind point to it
  const placed = new Set<string>();
  for (const s of slots) {
    const fresh = [...new Set(s.kinds)].filter(k => !placed.has(k));
    fresh.forEach(k => placed.add(k));
    s.el.replaceChildren(...fresh.length ? fresh.map(k => group(k)) : [h('div', { className: 'muted' }, `More ${s.kinds.join(', ')} links, listed above`)]);
  }

  // Kinds without a block go below the description: Subtask always; others once linked or opened with their reveal button
  const linkBlocks: HTMLElement[] = [], linkRevealBtns: HTMLElement[] = [];
  for (const kind of [SUBTASK, PARENT, ...Object.keys(linkTypes)]) {
    if (placed.has(kind)) continue;
    const has = kind === SUBTASK || entries(kind).length > 0;
    if (has || revealedLinkKinds.has(kind)) linkBlocks.push(group(kind, !has));
    else linkRevealBtns.push(h('button', { type: 'button', onclick: () => { revealedLinkKinds.add(kind); transition(render); } }, icon('link'), kind));
  }
  const incomingBlocks = [...incoming].filter(([name]) => name !== PARENT).map(([name, list]) => h('div', { className: 'link-group' }, h('b', {}, name), h('ul', {}, ...list.map(li))));

  // Delete: two clicks instead of confirm(), which webviews block. The collapsed sidebar hides labels, so the title warns too
  const deleteLbl = h('span', {}, 'Delete');
  const deleteBtn = h('button', {
    type: 'button', className: 'bad', title: 'Delete',
    onclick: () => {
      if (deleteBtn.classList.contains('armed')) return run({ op: 'delete', id: t.id });
      deleteBtn.classList.add('armed');
      deleteLbl.textContent = deleteBtn.title = 'Click again: deletes every occurrence with all nested content';
      appear(deleteBtn);
      setTimeout(() => { deleteBtn.classList.remove('armed'); deleteLbl.textContent = deleteBtn.title = 'Delete'; appear(deleteBtn); }, 4000);
    },
  }, icon('trash'), deleteLbl);

  const occurrences = t.occurrences.map(o => h('div', { className: 'muted' },
    `${o.file}:${o.line + 1}${o.file === t.home.file && o.line === t.home.line ? ' (properties and description)' : ''}`));

  return { timerBtn, timeSummary, linkBlocks, linkRevealBtns, incomingBlocks, occurrences, deleteBtn };
}

// ---- Graph tab ----

function graph(): HTMLElement {
  const toggle = h('label', {}, h('input', { type: 'checkbox', checked: showSubtasks, onchange: () => { showSubtasks = !showSubtasks; transition(render); } }), ' Show subtask links');
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
    const a = s('a', { href: viewUrl(t), transform: `translate(${x(v)},${y(v)})` },
      s('rect', { width: W, height: H, rx: 6, class: t.props.done === true ? 'done' : '' }),
      s('text', { x: 8, y: H / 2 + 4 }, trunc(v, 30)), s('title', {}, v));
    a.addEventListener('click', inApp(() => select(v)));
    svg.append(a);
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
    const name = h('td', {}, taskLink(t.id, { className: 'link' }, t.title));
    name.style.paddingLeft = `${8 + d * 16}px`;
    rows.push(h('tr', { className: tot.effort && tot.spent > tot.effort ? 'over' : '' }, name, h('td', {}, badge(t.type)),
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

/**
 * Title row of a pane with its Hide/expand button: "Hide" with an arrow when expanded; collapsed, the title goes and
 * only the arrow towards `expand` stays, at the same place (CSS keeps the toggle on the pane's outer edge).
 */
function paneHead(pane: Pane, title: string, expand: 'left' | 'right'): HTMLElement {
  const toggle = h('button', {
    type: 'button', className: 'neutral pane-toggle', title: pane.collapsed ? `Expand ${title.toLowerCase()}` : `Hide ${title.toLowerCase()}`,
    onclick: () => { pane.collapsed = !pane.collapsed; transition(render); },
  }, icon(pane.collapsed ? expand : expand === 'left' ? 'right' : 'left'), pane.collapsed ? null : 'Hide');
  return h('div', { className: 'pane-head' }, pane.collapsed ? null : h('h3', {}, title), toggle);
}

/**
 * Drag the pane's inner edge (`dir` 1: right edge, -1: left edge) to resize. A collapsed pane expands once dragged out
 * to the minimum width; that re-renders it, so the pane is looked up by `sel` on every move. Document listeners keep
 * tracking even if the cursor leaves the handle.
 */
function makeResizable(pane: Pane, handle: HTMLElement, sel: string, dir: 1 | -1) {
  handle.onpointerdown = e => {
    e.preventDefault();
    const startX = e.clientX, startWidth = handle.parentElement!.getBoundingClientRect().width;
    const onMove = (ev: PointerEvent) => {
      const w = startWidth + dir * (ev.clientX - startX);
      if (pane.collapsed && w < 160) return;
      pane.width = Math.min(600, Math.max(160, w));
      if (pane.collapsed) { pane.collapsed = false; render(); }
      document.querySelector<HTMLElement>(sel)!.style.width = `${pane.width}px`;
    };
    const onUp = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', onUp); };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };
}

function render() {
  if (url() !== location.pathname) history.replaceState(null, '', url());
  // Every collapse change ends in a render
  try { sessionStorage.setItem('plandown-collapsed', Object.entries(panes).filter(([, p]) => p.collapsed).map(([k]) => k).join(',')); } catch { /* not persisted */ }
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
  const lv = live(t, bundle.slots);

  const sidebarContent = panes.props.collapsed
    ? [...compactProps(t), lv.timerBtn, lv.deleteBtn]
    : [
        bundle.props,
        h('div', { className: 'sidebar-section' }, h('h3', {}, 'Time'), h('div', { className: 'actions' }, lv.timerBtn, h('span', { className: 'muted' }, lv.timeSummary))),
        h('div', { className: 'sidebar-section' }, h('h3', {}, 'Stored in'), ...lv.occurrences),
        h('div', { className: 'sidebar-section actions' }, lv.deleteBtn),
      ];

  const resizeHandle = h('div', { className: 'sidebar-resize' });
  const panel = h('aside', { className: `sidebar-panel${panes.props.collapsed ? ' collapsed' : ''}` },
    resizeHandle, paneHead(panes.props, 'Properties', 'left'), h('div', { className: 'sidebar-scroll' }, ...sidebarContent));
  if (!panes.props.collapsed) panel.style.width = `${panes.props.width}px`;
  makeResizable(panes.props, resizeHandle, '.sidebar-panel', -1);

  const editorMain = h('div', { className: 'editor-main' }, bundle.form,
    h('div', { className: 'links' }, h('h3', {}, 'Links'), ...lv.linkBlocks, ...lv.linkRevealBtns, ...lv.incomingBlocks));

  main.replaceChildren(sidebar(), h('section', { className: 'editor' }, h('div', { className: 'editor-row' }, editorMain, panel)));
}

setInterval(() => document.querySelectorAll<HTMLElement>('[data-started]').forEach(el => { el.textContent = clock(Date.now() - Number(el.dataset.started)); }), 1000);
db = await api.state();
({ tab, sel = null } = route());
render();
api.subscribe(async () => { db = await api.state(); render(); });
