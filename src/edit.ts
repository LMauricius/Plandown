/**
 * Operations: turn an API request into line edits on the parsed files. Pure (no I/O), so every
 * operation is testable and any front end (HTTP GUI, VSCode) drives the same code.
 * Edits only touch the lines an operation concerns; everything else in the files stays byte-identical.
 */
import { Document, parseDocument, isMap, isScalar } from 'yaml';
import { bodyTexts, gaps, rangeText, type Node, type ParsedFile } from './markdown.js';
import { FORMAT_FILE, PARENT, SUBTASK } from './format.js';
import { taskId, type Db, type Occ, type Task } from './db.js';

export type Op =
  | { op: 'update'; id: string; type?: string; title?: string; props?: Record<string, unknown>; body?: string[] }
  | { op: 'create'; type: string; title: string; parent?: string; file?: string }
  | { op: 'delete'; id: string }
  | { op: 'link'; from: string; type: string; to: string }
  | { op: 'unlink'; from: string; type: string; to: string }
  | { op: 'start' | 'stop'; id: string };

/** Replace lines [start, end) of `file` (a missing file is created). */
export interface Edit { file: string; start: number; end: number; lines: string[] }

export interface Ctx { db: Db; occ: Map<string, Occ[]>; files: Map<string, ParsedFile> }

/** Edits plus the id of the task the caller should focus afterwards. */
export interface Plan { edits: Edit[]; id?: string }

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

/** Task files may only be plain `.md` names inside the folder (no paths, no hidden files, not the format). */
function checkFile(file: unknown): string {
  if (typeof file !== 'string' || !/^[^/\\\0]+\.md$/i.test(file) || file.startsWith('.') || file === FORMAT_FILE) throw new Error(`Invalid task file name "${String(file)}"`);
  return file;
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
  const id = taskId(type, title), edits: Edit[] = [];

  // Rename/retype: every occurrence's title line, in all files
  if (id !== t.id) {
    if (ctx.db.tasks[id]) throw new Error(`Task ${id} already exists`);
    for (const { pf, node } of ctx.occ.get(t.id)!)
      edits.push({ file: pf.file, start: node.line, end: node.line + 1, lines: [`${node.prefix}[${type}] ${title}`] });
  }
  // Props before description: with no YAML block both edits start at the same line, and the later edit is applied first
  if (op.props !== undefined) { const e = propsEdit(home(ctx, t), op.props); if (e) edits.push(e); }
  if (op.body !== undefined) edits.push(...bodyEdits(home(ctx, t), op.body));
  return { edits, id };
}

function create(ctx: Ctx, op: Extract<Op, { op: 'create' }>): Plan {
  const title = typeof op.title === 'string' ? op.title.trim() : op.title;
  checkName(ctx, op.type, title);
  const id = taskId(op.type, title);
  if (ctx.db.tasks[id]) throw new Error(`Task ${id} already exists`);
  if (op.parent !== undefined) return { edits: [addItem(home(ctx, need(ctx, op.parent)), null, op.type, title)], id };

  // Top-level task: a new level-1 heading at the end of the file
  const file = checkFile(op.file ?? ctx.db.files[0] ?? 'tasks.md'), lines = ctx.files.get(file)?.lines ?? [];
  const n = lines.length, heading = `# [${op.type}] ${title}`;
  return { edits: [{ file, start: n, end: n, lines: n && lines[n - 1].trim() ? ['', heading] : [heading] }], id };
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
  const o = [...ctx.occ.get(e.from)!, ...ctx.occ.get(e.to)!].find(o => o.pf.file === e.at.file && o.node.line === e.at.line)!;
  if (hasBody(o.pf, o.node)) throw new Error(`${e.at.file}:${e.at.line + 1} defines this task's content; delete the task or edit the file instead`);
  return { edits: [removeItem(o.pf, o.node)], id: op.from };
}

/** Timer: `started` holds the running timer, so it survives restarts and is shared by every front end. */
function timer(ctx: Ctx, op: Extract<Op, { op: 'start' | 'stop' }>, now: Date): Plan {
  const t = need(ctx, op.id), props = { ...t.props }, started = Date.parse(String(props.started ?? ''));
  if (op.op === 'start') {
    if (!isNaN(started)) throw new Error('Timer is already running');
    props.started = now.toISOString();
  } else {
    if (isNaN(started)) throw new Error('No running timer');
    const spent = typeof props.spent === 'number' && Number.isFinite(props.spent) ? props.spent : 0;
    props.spent = Math.round((spent + Math.max(0, now.getTime() - started) / 36e5) * 100) / 100;
    delete props.started;
  }
  return update(ctx, { op: 'update', id: t.id, props });
}

export function plan(ctx: Ctx, op: Op, now = new Date()): Plan {
  switch (op?.op) {
    case 'update': return update(ctx, op);
    case 'create': return create(ctx, op);
    case 'delete': return remove(ctx, op);
    case 'link': return link(ctx, op);
    case 'unlink': return unlink(ctx, op);
    case 'start': case 'stop': return timer(ctx, op, now);
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
