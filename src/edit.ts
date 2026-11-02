/**
 * Operations: turn an API request into line edits on the parsed files. Pure (no I/O), so every
 * operation is testable and any front end (HTTP GUI, VSCode) drives the same code.
 * Edits only touch the lines an operation concerns; everything else in the files stays byte-identical.
 */
import { Document, parseDocument, isMap, isScalar } from 'yaml';
import { bodyTexts, gaps, rangeText, type Node, type ParsedFile } from './markdown.js';
import { FORMAT_FILE, PARENT, SUBTASK } from './format.js';
import { taskId, type Db, type Occ, type Task } from './db.js';
import { baseName, findNode, namesTask } from './tree.js';

export type Op =
  | { op: 'update'; id: string; type?: string; title?: string; props?: Record<string, unknown>; body?: string[] }
  | { op: 'create'; type: string; title: string; parent?: string; file?: string; near?: string }
  | { op: 'group'; name: string; near?: string }
  | { op: 'delete'; id: string }
  | { op: 'link'; from: string; type: string; to: string }
  | { op: 'unlink'; from: string; type: string; to: string }
  | { op: 'start' | 'stop' | 'lap'; id: string }
  | { op: 'log'; id: string; hours: number };

/** Replace lines [start, end) of `file` (a missing file is created). */
export interface Edit { file: string; start: number; end: number; lines: string[] }

export interface Ctx { db: Db; occ: Map<string, Occ[]>; files: Map<string, ParsedFile> }

/**
 * Edits plus what the caller should focus afterwards (a task id; for `group`, the folder's path).
 * Folder changes wrap the edits: `mkdir` before them, then `moves` (renames), then `rmdir` (only if empty).
 */
export interface Plan { edits: Edit[]; id?: string; mkdir?: string; rmdir?: string; moves?: { from: string; to: string }[] }

// ---- Helpers ----

/** Looks up a task by id; ids arrive from untrusted clients. */
function need(ctx: Ctx, id: unknown): Task {
  const t = typeof id === 'string' ? ctx.db.tasks[id] : undefined;
  if (!t) throw new Error(`No task ${String(id)}`);
  return t;
}

/** Occurrence that receives property and description edits. */
function home(ctx: Ctx, t: Task): Occ {
  return ctx.occ.get(t.id)!.find(o => o.pf.file === t.home.file && o.node.line === t.home.line)!;
}

/** Validates a type/title pair before it is written into a title line. */
function checkName(ctx: Ctx, type: unknown, title: unknown): asserts type is string {
  if (typeof type !== 'string' || !ctx.db.format.types[type]) throw new Error(`Unknown task type [${String(type)}]`);
  if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw new Error('Title must be a single non-empty line');
}

/**
 * Paths arrive from untrusted clients and must stay inside the folder: `/`-separated, no empty, hidden (`.`, `..`)
 * or backslash segments. Task files end in `.md` and are never named like the format file (nested ones are ignored).
 */
function checkPath(path: unknown, file: boolean): string {
  const ok = typeof path === 'string' && path.split('/').every(s => s && !s.startsWith('.') && !/[\\\0]/.test(s))
    && (!file || (path.endsWith('.md') && baseName(path) !== FORMAT_FILE));
  if (!ok) throw new Error(`Invalid ${file ? 'task file' : 'group'} name "${String(path)}"`);
  return path as string;
}

/** File stem for a task's own file: the title minus characters file systems reject, so the stem still names the task. */
function stemOf(title: string): string {
  const stem = title.replace(/[/\\:*?"<>|\0]/g, '').replace(/^[.\s]+/, '').trim();
  if (!stem) throw new Error(`"${title}" has no characters usable in a file name`);
  return stem;
}

/** Folder part of a path, with its trailing `/` ('' at the root). */
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

/**
 * File for a new top-level task created near tree node `near` ('' is the root):
 * - a node merged with its task: a new file next to it (that file belongs to its task)
 * - a file with top-level tasks of its own, or a plain file: appended to it
 * - an empty folder: becomes a file of the same name, replacing the folder
 * - any other folder: a new file inside it
 */
function placeTask(ctx: Ctx, near: unknown, title: string): { file: string; rmdir?: string } {
  if (near === '') return { file: stemOf(title) + '.md' };
  const n = typeof near === 'string' ? findNode(ctx.db.tree, near) : undefined;
  if (!n) throw new Error(`No group or file "${String(near)}"`);
  if (n.task) return { file: dirOf(n.path) + stemOf(title) + '.md' };
  if (n.file && (n.tasks.length || !n.folder)) return { file: n.file };
  if (!n.file && !n.kids.length) return { file: n.path + '.md', rmdir: n.path };
  return { file: `${n.path}/${stemOf(title)}.md` };
}

const hasBody = (pf: ParsedFile, n: Node) => !!n.props || n.lists.length > 0 || bodyTexts(pf, n).some(Boolean);

/** Appends `[type] title` to the occurrence's list with `label` (null: Subtask), creating the list if needed. */
function addItem({ pf, node }: Occ, label: string | null, type: string, title: string): Edit {
  const text = `[${type}] ${title}`;
  const list = node.lists.find(l => l.label === label);
  if (list) return { file: pf.file, start: list.end, end: list.end, lines: [list.bullet + text] };

  // New list at the end of the occurrence's own content, separated by a blank line
  let at = node.own.end;
  while (at > node.own.start && !pf.lines[at - 1].trim()) at--;
  const lines = [...(node.kind === 'heading' || at > node.own.start ? [''] : []), ...(label ? [node.indent + label + ':'] : []), node.indent + '- ' + text];
  if (node.kind === 'heading' && at < pf.lines.length && pf.lines[at].trim()) lines.push('');
  return { file: pf.file, start: at, end: at, lines };
}

/** Removes a bullet occurrence, and its `<Link type>:` label when it was the list's only item. */
function removeItem(pf: ParsedFile, node: Node): Edit {
  const l = node.list;
  const start = l && l.labelLine === node.block.start - 1 && l.end === node.block.end ? l.labelLine : node.block.start;
  return { file: pf.file, start, end: node.block.end, lines: [] };
}

/** Rewrites the YAML block, preserving comments, order and formatting of untouched keys. */
function propsEdit({ pf, node }: Occ, props: Record<string, unknown>): Edit | null {
  if (!props || typeof props !== 'object' || Array.isArray(props)) throw new Error('Properties must be an object');
  const parsed = parseDocument(node.props?.raw ?? '');
  if (parsed.errors.length || (parsed.contents && !isMap(parsed.contents))) throw new Error(`Fix the YAML at ${pf.file}:${node.props!.start + 1} first`);
  const keep = Object.entries(props).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!keep.length) return node.props ? { file: pf.file, start: node.props.start, end: node.props.end, lines: [] } : null;

  const doc: Document = isMap(parsed.contents) ? parsed : new Document({});
  const old = (doc.toJS() ?? {}) as Record<string, unknown>;
  if (isMap(doc.contents))
    for (const p of doc.contents.items.slice()) {
      const k = String(isScalar(p.key) ? p.key.value : p.key);
      if (!keep.some(([key]) => key === k)) doc.delete(k);
    }
  for (const [k, v] of keep) if (JSON.stringify(old[k]) !== JSON.stringify(v)) doc.set(k, v);

  const ind = node.indent;
  const lines = [ind + '---', ...doc.toString().trimEnd().split('\n').map(l => l ? ind + l : l), ind + '---'];
  return node.props ? { file: pf.file, start: node.props.start, end: node.props.end, lines } : { file: pf.file, start: node.line + 1, end: node.line + 1, lines };
}

/**
 * Replaces the changed description gaps (`texts[i]` is the text before the i-th task-list block); blank lines keep
 * text and lists apart. Fewer texts than gaps leave the trailing gaps alone (lists appended since the client read
 * the task); more texts mean lists were removed meanwhile, which cannot be mapped back.
 */
function bodyEdits({ pf, node }: Occ, texts: unknown): Edit[] {
  if (!Array.isArray(texts) || !texts.every(t => typeof t === 'string')) throw new Error('Body must be a list of strings');
  const gs = gaps(node);
  if (texts.length > gs.length) throw new Error("The task's lists changed meanwhile; revert and edit again");
  return texts.flatMap((text, i) => {
    const r = gs[i], body = text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
    if (body === rangeText(pf, node, r)) return [];
    const lines = body ? body.split('\n').map(l => l.trim() ? node.indent + l : '') : [];
    const prev = i > 0, next = i < node.spans.length || (node.kind === 'heading' && r.end < pf.lines.length);
    if (prev && lines.length) lines.unshift('');
    if (next && (lines.length || prev || node.kind === 'heading')) lines.push('');
    return [{ file: pf.file, start: r.start, end: r.end, lines }];
  });
}

// ---- Operations ----

function update(ctx: Ctx, op: Extract<Op, { op: 'update' }>): Plan {
  const t = need(ctx, op.id), type = op.type ?? t.type, title = (op.title ?? t.title).trim();
  checkName(ctx, type, title);
  const id = taskId(type, title), edits: Edit[] = [], moves: { from: string; to: string }[] = [];

  // Rename/retype: every occurrence's title line, in all files
  if (id !== t.id) {
    if (ctx.db.tasks[id]) throw new Error(`Task ${id} already exists`);
    for (const { pf, node } of ctx.occ.get(t.id)!)
      edits.push({ file: pf.file, start: node.line, end: node.line + 1, lines: [`${node.prefix}[${type}] ${title}`] });
    // The file (and folder) merged with the task in the tree follows its new name
    const n = findNode(ctx.db.tree, t.home.file.slice(0, -3));
    if (n?.task === t.id && !namesTask(n.path, type, title)) {
      const to = dirOf(n.path) + stemOf(title), file = checkPath(to + '.md', true);
      if (ctx.db.files.includes(file) || ctx.db.folders.includes(to)) throw new Error(`Cannot rename ${n.path}: ${to} already exists`);
      moves.push({ from: n.file!, to: file }, ...n.folder ? [{ from: n.path, to }] : []);
    }
  }
  // Props before description: with no YAML block both edits start at the same line, and the later edit is applied first
  if (op.props !== undefined) { const e = propsEdit(home(ctx, t), op.props); if (e) edits.push(e); }
  if (op.body !== undefined) edits.push(...bodyEdits(home(ctx, t), op.body));
  return { edits, id, moves };
}

function create(ctx: Ctx, op: Extract<Op, { op: 'create' }>): Plan {
  const title = typeof op.title === 'string' ? op.title.trim() : op.title;
  checkName(ctx, op.type, title);
  const id = taskId(op.type, title);
  if (ctx.db.tasks[id]) throw new Error(`Task ${id} already exists`);
  if (op.parent !== undefined) return { edits: [addItem(home(ctx, need(ctx, op.parent)), null, op.type, title)], id };

  // Top-level task: a new level-1 heading at the end of the file
  const at = op.near !== undefined ? placeTask(ctx, op.near, title) : { file: op.file ?? ctx.db.files[0] ?? 'tasks.md' };
  const file = checkPath(at.file, true), lines = ctx.files.get(file)?.lines ?? [];
  const n = lines.length, heading = `# [${op.type}] ${title}`;
  return { edits: [{ file, start: n, end: n, lines: n && lines[n - 1].trim() ? ['', heading] : [heading] }], id, rmdir: at.rmdir };
}

/** Empty folder near tree node `near`: inside a folder, otherwise next to the node (a task-merged node counts as a task). */
function group(ctx: Ctx, op: Extract<Op, { op: 'group' }>): Plan {
  const name = typeof op.name === 'string' ? op.name.trim() : '';
  if (!name || name.includes('/')) throw new Error('Group name must be a single non-empty name');
  const n = op.near ? findNode(ctx.db.tree, String(op.near)) : undefined;
  if (op.near && !n) throw new Error(`No group or file "${String(op.near)}"`);
  const dir = checkPath((n ? (n.folder && !n.task ? n.path + '/' : dirOf(n.path)) : '') + name, false);
  if (ctx.db.folders.includes(dir)) throw new Error(`Group ${dir} already exists`);
  return { edits: [], id: dir, mkdir: dir };
}

function remove(ctx: Ctx, op: Extract<Op, { op: 'delete' }>): Plan {
  const t = need(ctx, op.id);
  const edits = ctx.occ.get(t.id)!.map(({ pf, node }) => node.kind === 'bullet' ? removeItem(pf, node) : { file: pf.file, start: node.block.start, end: node.block.end, lines: [] });
  // An occurrence nested inside another occurrence of the same task is already removed with it
  return { edits: edits.filter(e => !edits.some(o => o !== e && o.file === e.file && o.start <= e.start && e.end <= o.end && (o.start < e.start || e.end < o.end))) };
}

function link(ctx: Ctx, op: Extract<Op, { op: 'link' }>): Plan {
  const a = need(ctx, op.from), b = need(ctx, op.to), type = op.type;
  if (a.id === b.id) throw new Error('A task cannot link to itself');
  if (typeof type !== 'string') throw new Error('Link type must be a string');
  if (type !== SUBTASK && type !== PARENT && !(b.type in (ctx.db.format.types[a.type]?.links[type] ?? {})))
    throw new Error(`Link "${type}" of [${a.type}] cannot target [${b.type}]`);
  if (ctx.db.edges.some(e => (e.from === a.id && e.to === b.id && e.type === type) || (e.from === b.id && e.to === a.id && e.reverse === type)))
    throw new Error('These tasks are already linked that way');
  return { edits: [addItem(home(ctx, a), type === SUBTASK ? null : type, b.type, b.title)], id: a.id };
}

function unlink(ctx: Ctx, op: Extract<Op, { op: 'unlink' }>): Plan {
  const e = ctx.db.edges.find(e => (e.from === op.from && e.type === op.type && e.to === op.to) || (e.to === op.from && e.reverse === op.type && e.from === op.to));
  if (!e) throw new Error('No such link');
  if (e.heading) throw new Error('This link comes from heading nesting; move the heading in the file instead');
  // `op.from`'s own declaration: `at` when it is the edge's `from`, else `back`; without one, the other side's (`at`)
  const at = e.from !== op.from && e.back || e.at;
  const o = [...ctx.occ.get(e.from)!, ...ctx.occ.get(e.to)!].find(o => o.pf.file === at.file && o.node.line === at.line)!;
  if (hasBody(o.pf, o.node)) throw new Error(`${at.file}:${at.line + 1} defines this task's content; delete the task or edit the file instead`);
  return { edits: [removeItem(o.pf, o.node)], id: op.from };
}

/**
 * Timer: `started` holds the running timer, so it survives restarts and is shared by every front end. `stop` adds the
 * elapsed time to `spent`; `lap` adds it too but restarts the timer at `now`; `log` adds `hours` with or without a timer.
 */
function timer(ctx: Ctx, op: Extract<Op, { op: 'start' | 'stop' | 'lap' | 'log' }>, now: Date): Plan {
  const t = need(ctx, op.id), props = { ...t.props }, started = Date.parse(String(props.started ?? ''));
  if (op.op === 'start') {
    if (!isNaN(started)) throw new Error('Timer is already running');
    props.started = now.toISOString();
  } else {
    if (op.op !== 'log' && isNaN(started)) throw new Error('No running timer');
    // `hours` arrives from untrusted clients; a negative one corrects earlier entries
    if (op.op === 'log' && !(typeof op.hours === 'number' && Number.isFinite(op.hours))) throw new Error('Hours must be a number');
    const spent = typeof props.spent === 'number' && Number.isFinite(props.spent) ? props.spent : 0;
    const add = op.op === 'log' ? op.hours : Math.max(0, now.getTime() - started) / 36e5;
    const total = Math.round((spent + add) * 100) / 100;
    if (total < 0) throw new Error('Spent time cannot become negative');
    props.spent = total;
    if (op.op === 'stop') delete props.started;
    else if (op.op === 'lap') props.started = now.toISOString();
  }
  return update(ctx, { op: 'update', id: t.id, props });
}

export function plan(ctx: Ctx, op: Op, now = new Date()): Plan {
  switch (op?.op) {
    case 'update': return update(ctx, op);
    case 'create': return create(ctx, op);
    case 'group': return group(ctx, op);
    case 'delete': return remove(ctx, op);
    case 'link': return link(ctx, op);
    case 'unlink': return unlink(ctx, op);
    case 'start': case 'stop': case 'lap': case 'log': return timer(ctx, op, now);
    default: throw new Error(`Unknown operation ${JSON.stringify((op as { op?: unknown })?.op)}`);
  }
}

/** Applies one file's edits bottom-up so earlier line numbers stay valid; equal starts apply the later edit first. */
export function applyEdits(lines: string[], edits: Edit[]): string[] {
  const out = [...lines], sorted = edits.map((e, i) => ({ e, i })).sort((x, y) => x.e.start - y.e.start || x.i - y.i);
  for (let k = 1; k < sorted.length; k++)
    if (sorted[k - 1].e.end > sorted[k].e.start) throw new Error('Internal error: overlapping edits');
  for (const { e } of sorted.reverse()) out.splice(e.start, e.end - e.start, ...e.lines);
  return out;
}
