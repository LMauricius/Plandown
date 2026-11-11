/**
 * Operations: turn an API request into line edits on the parsed files. Pure (no I/O), so every
 * operation is testable and any front end (HTTP GUI, VSCode) drives the same code.
 * Edits only touch the lines an operation concerns; everything else in the files stays byte-identical.
 */
import { Document, parseDocument, isMap, isScalar } from 'yaml';
import { bodyTexts, FENCE, gaps, rangeText, type Node, type ParsedFile } from './markdown.js';
import { FORMAT_FILE, PARENT, SUBTASK } from './format.js';
import { taskId, type Db, type Occ, type Task } from './db.js';
import { baseName, fileStem, findNode, namesTask } from './tree.js';

export type Op =
  | { op: 'update'; id: string; type?: string; title?: string; props?: Record<string, unknown>; body?: string[] }
  | { op: 'create'; type: string; title: string; parent?: string; file?: string; near?: string }
  | { op: 'group'; name: string; near?: string }
  | { op: 'delete'; id: string }
  | { op: 'move'; id?: string; path?: string; parent?: string; near?: string; sibling?: string; after?: boolean; from?: string }
  | { op: 'link'; from: string; type: string; to: string }
  | { op: 'unlink'; from: string; type: string; to: string }
  | { op: 'start' | 'stop' | 'lap'; id: string }
  | { op: 'log'; id: string; hours: number };

/** Replace lines [start, end) of `file` (a missing file is created). */
export interface Edit { file: string; start: number; end: number; lines: string[] }

export interface Ctx { db: Db; occ: Map<string, Occ[]>; files: Map<string, ParsedFile> }

/**
 * Edits plus what the caller should focus afterwards (a task id; for `group` and a `move` of a node without a task, the node's path).
 * Folder changes wrap the edits: `mkdir` before them, then `moves` (renames), then `rmdir` (only if empty).
 * `prune`: edited files left blank are deleted instead of written (a move leaves no empty files behind).
 */
export interface Plan { edits: Edit[]; id?: string; mkdir?: string; rmdir?: string; moves?: { from: string; to: string }[]; prune?: boolean }

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

/**
 * Appends an item to the occurrence's list with `label` (null: Subtask), creating the list if needed. `item` renders the
 * item's lines for the list's marker (`  - `), so a moved block can be re-indented to it.
 */
function addItem({ pf, node }: Occ, label: string | null, item: (bullet: string) => string[]): Edit {
  const list = node.lists.find(l => l.label === label);
  if (list) return { file: pf.file, start: list.end, end: list.end, lines: item(list.bullet) };

  // New list at the end of the occurrence's own content, separated by a blank line
  let at = node.own.end;
  while (at > node.own.start && !pf.lines[at - 1].trim()) at--;
  const lines = [...(node.kind === 'heading' || at > node.own.start ? [''] : []), ...(label ? [node.indent + label + ':'] : []), ...item(node.indent + '- ')];
  if (node.kind === 'heading' && at < pf.lines.length && pf.lines[at].trim()) lines.push('');
  return { file: pf.file, start: at, end: at, lines };
}

/** Item renderer for `addItem`: a plain `[type] title` reference. */
const ref = (type: string, title: string) => (bullet: string) => [`${bullet}[${type}] ${title}`];

/** Removes a bullet occurrence, and its `<Link type>:` label when it was the list's only item. */
function removeItem(pf: ParsedFile, node: Node): Edit {
  const l = node.list;
  const start = l && l.labelLine === node.block.start - 1 && l.end === node.block.end ? l.labelLine : node.block.start;
  return { file: pf.file, start, end: node.block.end, lines: [] };
}

/** Rewrites the YAML block as a ```yaml fence (converting a legacy `---` block), preserving comments, order and formatting of untouched keys. */
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

  // Fence longer than any backtick run starting a YAML line, so a multi-line value cannot close it
  const ind = node.indent, yaml = doc.toString().trimEnd().split('\n');
  const fence = '`'.repeat(Math.max(3, ...yaml.map(l => /^\s*(`*)/.exec(l)![1].length + 1)));
  const lines = [ind + fence + 'yaml', ...yaml.map(l => l ? ind + l : l), ind + fence];
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
    // The file (and folder) merged with the task in the tree follows its new name, keeping its suffix (`.md` or `.plandown.md`)
    const n = findNode(ctx.db.tree, fileStem(t.home.file));
    if (n?.task === t.id && !namesTask(n.path, type, title)) {
      const to = dirOf(n.path) + stemOf(title), file = checkPath(to + n.file!.slice(n.path.length), true);
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
  if (op.parent !== undefined) return { edits: [addItem(home(ctx, need(ctx, op.parent)), null, ref(op.type, title))], id };

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

// ---- Move ----

/** Form a moved block takes: a bullet with list marker `bullet` (`  - `), or a heading of `level`. */
type Form = { bullet: string } | { level: number };

/** Where a moved block lands: before line `line` of `file`, in a form. */
type Slot = { file: string; line: number } & Form;

/** Heading level of a heading occurrence (its `#` count). */
const levelOf = (n: Node) => /^#*/.exec(n.prefix)![0].length;

/** Deepest heading level in a heading occurrence's block: nesting the block deeper must keep it within level 6. */
const deepest = ({ pf, node }: Occ) => Math.max(...pf.heads.filter(h => h.line >= node.block.start && h.line < node.block.end).map(h => h.level));

/** A task and all its Subtask descendants: a task moved under one of them would hang below itself. */
function subtree(ctx: Ctx, id: string): Set<string> {
  const kids = new Map<string, string[]>(), seen = new Set([id]);
  for (const e of ctx.db.edges) if (e.type === SUBTASK) kids.set(e.from, [...kids.get(e.from) ?? [], e.to]);
  for (const stack = [id]; stack.length;) for (const k of kids.get(stack.pop()!) ?? []) if (!seen.has(k)) { seen.add(k); stack.push(k); }
  return seen;
}

/** Slot next to occurrence `o` (`after`: below its block), in its form. */
const beside = ({ pf, node }: Occ, after: boolean): Slot => ({
  file: pf.file, line: after ? node.block.end : node.block.start,
  ...node.kind === 'heading' ? { level: levelOf(node) } : { bullet: node.list!.bullet },
});

/**
 * Inserts `lines` at `slot`; a heading gets blank lines against non-blank neighbours, a bullet none (a blank line ends a
 * list). Neighbours are looked up past `gone`, the ranges removed by the same plan.
 */
function insert(ctx: Ctx, slot: Slot, lines: string[], gone: Edit[]): Edit {
  const all = ctx.files.get(slot.file)?.lines ?? [], within = (i: number) => gone.find(g => g.file === slot.file && g.start <= i && i < g.end);
  if ('level' in slot) {
    let prev = slot.line - 1, next = slot.line;
    for (let g; (g = within(prev));) prev = g.start - 1;
    for (let g; (g = within(next));) next = g.end;
    if (all[prev]?.trim()) lines = ['', ...lines];
    if (all[next]?.trim()) lines = [...lines, ''];
  }
  return { file: slot.file, start: slot.line, end: slot.line, lines };
}

/** Removal of an occurrence's whole block: a heading's section, or a bullet item (with its label when it was the list's only item). */
const cutOut = ({ pf, node }: Occ): Edit => node.kind === 'heading' ? { file: pf.file, start: node.block.start, end: node.block.end, lines: [] } : removeItem(pf, node);

/**
 * Removals of one file merged where they touch (so `applyEdits` never sees them overlap). Blank lines a removal leaves on
 * both sides (or one at the file's end) shrink to one, unless an insertion lands there (`at`: insertion lines of the file).
 */
function removals(pf: ParsedFile, rms: Edit[], at: number[]): Edit[] {
  const out: Edit[] = [], L = pf.lines;
  for (const r of [...rms].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end); else out.push({ ...r });
  }
  out.forEach((r, i) => {
    if (!L[r.start - 1]?.trim() && r.end < (out[i + 1]?.start ?? L.length) && !L[r.end].trim() && !at.includes(r.end)) r.end++;
    else if (r.start > (out[i - 1]?.end ?? 0) && !L[r.start - 1].trim() && r.end === L.length && !at.includes(r.start)) r.start--;
  });
  return out;
}

/** Task merged with a tree node (the single, same-named task of its file): it moves as that node, file and folder. */
const nodeOf = (ctx: Ctx, id: string) => { const n = findNode(ctx.db.tree, fileStem(ctx.db.tasks[id].home.file)); return n?.task === id ? n : undefined; };

/** Occurrence of `sib` that makes it `parent`'s subtask (the Subtask edge's declaring list item or sub-heading), if any. */
function subOcc(ctx: Ctx, parent: string, sib: Task): Occ | undefined {
  const e = ctx.db.edges.find(e => e.type === SUBTASK && e.from === parent && e.to === sib.id);
  return e && ctx.occ.get(sib.id)!.find(s => [e.at, e.back].some(l => l?.file === s.pf.file && l.line === s.node.line));
}

/** Removes the plain list items declaring `parent`'s Subtask link to `id` (either side); items with content stay. */
function unref(ctx: Ctx, parent: string, id: string): Edit[] {
  const e = ctx.db.edges.find(e => e.type === SUBTASK && e.from === parent && e.to === id);
  if (!e || e.heading) return [];
  return [...ctx.occ.get(parent)!, ...ctx.occ.get(id)!]
    .filter(o => o.node.kind === 'bullet' && !hasBody(o.pf, o.node) && [e.at, e.back].some(l => l?.file === o.pf.file && l.line === o.node.line))
    .map(o => removeItem(o.pf, o.node));
}

/**
 * Lines of occurrence `o`'s block reshaped to `form`, title line first, trailing blank lines dropped.
 * - heading → heading: every heading of the block (`pf.heads`, so fences and YAML comments are skipped) shifts by the same delta
 * - bullet → bullet: the title gets the new marker, the body is re-indented from the old content column to the new one
 * - bullet → heading: the body is de-indented; description lines starting with `#` are escaped, else they would become headings
 * A heading never becomes a bullet (its sub-headings could not follow); callers put it at a heading slot instead.
 */
function reshape({ pf, node }: Occ, form: Form): string[] {
  let end = node.block.end;
  while (end > node.line + 1 && !pf.lines[end - 1].trim()) end--;
  const lines = pf.lines.slice(node.line, end).map(l => l.trim() ? l : '');
  if (node.kind === 'heading') {
    if (!('level' in form)) throw new Error('Internal error: a heading cannot become a bullet');
    const d = form.level - levelOf(node);
    for (const h of pf.heads) if (h.line >= node.line && h.line < end) lines[h.line - node.line] = '#'.repeat(h.level + d) + lines[h.line - node.line].slice(h.level);
    return lines;
  }
  // Every non-blank line of a bullet's block is indented at least to its content column (`indent`), see the parser's `itemEnd`
  const cut = node.indent.length, body = node.own.start - node.line, pad = 'bullet' in form ? ' '.repeat(form.bullet.length) : '';
  let fence: string | null = null;
  return lines.map((l, i) => {
    if (i === 0) return ('bullet' in form ? form.bullet : '#'.repeat(form.level) + ' ') + l.slice(cut);
    if (!l) return l;
    l = l.slice(cut);
    if ('level' in form && i >= body) {
      const f = FENCE.exec(l);
      if (fence) { if (f?.[1] === fence) fence = null; }
      else if (f) fence = f[1];
      else if (/^#{1,6}([ \t]|$)/.test(l)) l = '\\' + l;
    }
    return pad + l;
  });
}

/**
 * Moves a task's home block (properties, description, lists and nested subtasks go with it); references in other lists stay.
 * A task merged with a tree node moves as that node instead (`moveNode`).
 * Targets:
 * - `parent` (refused if it is the task or one of its descendants), with `sibling`: next to the sibling's occurrence that
 *   makes it `parent`'s subtask, in its form; without (or no such occurrence): appended. A bullet joins `parent`'s
 *   Subtask list; a heading nests as the last sub-heading of a heading `parent` if levels stay within 6
 * - `near` (a tree node, '' the root), with `sibling` (a top-level task there): next to the sibling's home; without: a
 *   level-1 heading at the end of the file `placeTask` picks
 * A heading meeting a bullet slot becomes a level-1 heading at the end of that file, and (under a parent) a reference
 * takes the slot. The rest of the subtree homed at the top level of the old file follows into the new file (see below).
 * Edits: insertions in text order, then the removals, so `applyEdits` keeps an insertion at a removal's start in front
 * of it; an insertion strictly inside a removed block (moving into itself) is refused.
 */
function moveTask(ctx: Ctx, op: Extract<Op, { op: 'move' }>): Plan {
  const x = need(ctx, op.id);
  if (nodeOf(ctx, x.id)) return moveNode(ctx, op);
  const o = home(ctx, x), heading = o.node.kind === 'heading', sub = subtree(ctx, x.id);
  const sib = op.sibling !== undefined ? need(ctx, op.sibling) : undefined, edits: Edit[] = [];
  let slot: Slot | undefined, parent: Occ | undefined, rmdir: string | undefined;
  const eof = (file: string): Slot => ({ file, line: ctx.files.get(file)?.lines.length ?? 0, level: 1 });

  // Target slot (or, for an appended bullet, the list edit itself)
  if (op.parent !== undefined) {
    const p = need(ctx, op.parent);
    if (sub.has(p.id)) throw new Error(`Cannot move ${x.id} under itself`);
    parent = home(ctx, p);
    const so = sib && subOcc(ctx, p.id, sib);
    if (so) slot = beside(so, !!op.after);
    else if (!heading) edits.push(addItem(parent, null, b => reshape(o, { bullet: b })));
    else if (parent.node.kind === 'heading' && deepest(o) - levelOf(o.node) + levelOf(parent.node) + 1 <= 6)
      slot = { file: parent.pf.file, line: parent.node.block.end, level: levelOf(parent.node) + 1 };
    else { edits.push(addItem(parent, null, ref(x.type, x.title))); slot = eof(parent.pf.file); }
  } else if (sib) slot = beside(home(ctx, sib), !!op.after);
  else {
    const at = placeTask(ctx, op.near, x.title);
    slot = eof(checkPath(at.file, true));
    rmdir = at.rmdir;
  }

  // The block itself, reshaped for the slot (a heading meeting a bullet slot leaves a reference there)
  const adds: { slot: Slot; lines: string[] }[] = [];
  if (slot) {
    if (heading && 'bullet' in slot) {
      if (parent) adds.push({ slot, lines: ref(x.type, x.title)(slot.bullet) });
      slot = eof(slot.file);
    }
    if (heading && 'level' in slot && deepest(o) - levelOf(o.node) + slot.level > 6) throw new Error(`${x.id} would need headings deeper than level 6`);
    adds.push({ slot, lines: reshape(o, slot) });
  }

  // The rest of the subtree in the old file: descendants homed at its top level are shown only under the task (their parent
  // is in the same file); left behind in another file, they would turn into top-level tasks. They follow as level-1 headings
  const pf = o.pf, dest = slot?.file ?? parent!.pf.file, rms = [cutOut(o)];
  if (dest !== pf.file) for (const node of pf.roots) {
    const t = ctx.db.tasks[taskId(node.type, node.title)];
    if (node === o.node || !sub.has(t.id) || t.home.file !== pf.file || t.home.line !== node.line) continue;
    adds.push({ slot: eof(dest), lines: reshape({ pf, node }, { level: 1 }) });
    rms.push(cutOut({ pf, node }));
  }

  // Removals: never around an insertion
  const at = [...edits.map(e => ({ file: e.file, line: e.start })), ...adds.map(a => a.slot)].filter(p => p.file === pf.file).map(p => p.line);
  if (rms.some(r => at.some(l => r.start < l && l < r.end))) throw new Error(`Cannot move ${x.id} into itself`);
  const gone = removals(pf, rms, at);
  return { edits: [...edits, ...adds.map(a => insert(ctx, a.slot, a.lines, gone)), ...gone], id: x.id, rmdir, prune: true };
}

/**
 * Moves a tree node (its file and same-stem folder, so everything below it) by renames into a target node: `near` ('' the
 * root), or `parent`'s node (the node merged with that task, else its file's node). A target that is only a file gains its
 * folder. Refused: into itself or below, or a name taken by a file or folder there.
 * A node merged with a task also moves the task's Subtask link: off its old parent (`from`, the row it was dragged from,
 * else the task merged with its parent node) onto the new one (`parent`, else the task merged with the target node), next
 * to `sibling`'s item when given. Reordering under the same parent moves only the link. Link edits come before the renames
 * (`Plandown.apply` writes edits first), so they address the files where they are now.
 */
function moveNode(ctx: Ctx, op: Extract<Op, { op: 'move' }>): Plan {
  const n = op.id !== undefined ? nodeOf(ctx, need(ctx, op.id).id) : typeof op.path === 'string' ? findNode(ctx.db.tree, op.path) : undefined;
  if (!n) throw new Error(`No group or file "${String(op.path)}"`);
  const y = op.parent !== undefined ? need(ctx, op.parent) : undefined;
  const near = y ? (nodeOf(ctx, y.id) ?? findNode(ctx.db.tree, fileStem(y.home.file))!).path : op.near ?? '';
  if (typeof near !== 'string' || (near && !findNode(ctx.db.tree, near))) throw new Error(`No group or file "${String(near)}"`);
  if (near === n.path || near.startsWith(n.path + '/')) throw new Error(`Cannot move ${n.path} into itself`);
  const to = (near && near + '/') + baseName(n.path), edits: Edit[] = [];

  // The merged task's Subtask link: new item first (it may sit right where the old one is removed)
  if (n.task) {
    const x = ctx.db.tasks[n.task], up = dirOf(n.path).slice(0, -1);
    const old = op.from !== undefined ? need(ctx, op.from).id : up ? findNode(ctx.db.tree, up)?.task ?? undefined : undefined;
    const neu = y?.id ?? (near ? findNode(ctx.db.tree, near)!.task ?? undefined : undefined);
    if (neu && subtree(ctx, x.id).has(neu)) throw new Error(`Cannot move ${x.id} under itself`);
    if (old !== neu || (neu && op.sibling !== undefined)) {
      const linked = neu !== undefined && neu !== old && ctx.db.edges.some(e => e.type === SUBTASK && e.from === neu && e.to === x.id);
      if (neu && !linked) {
        const so = op.sibling !== undefined ? subOcc(ctx, neu, need(ctx, op.sibling)) : undefined;
        if (so?.node.kind === 'bullet') {
          const at = op.after ? so.node.block.end : so.node.block.start;
          edits.push({ file: so.pf.file, start: at, end: at, lines: ref(x.type, x.title)(so.node.list!.bullet) });
        }
        else edits.push(addItem(home(ctx, ctx.db.tasks[neu]), null, ref(x.type, x.title)));
      }
      if (old) edits.push(...unref(ctx, old, x.id));
    }
  }

  // The renames, unless the node already sits in the target
  if (to === n.path) {
    if (!edits.length) throw new Error(`${n.path} is already there`);
    return { edits, id: n.task ?? to };
  }
  if (ctx.db.folders.includes(to) || ctx.db.files.some(f => fileStem(f) === to)) throw new Error(`Cannot move ${n.path}: ${to} already exists`);
  const moves = [...n.file ? [{ from: n.file, to: checkPath(to + n.file.slice(n.path.length), true) }] : [], ...n.folder ? [{ from: n.path, to: checkPath(to, false) }] : []];
  return { edits, id: n.task ?? to, moves, mkdir: near && !ctx.db.folders.includes(near) ? near : undefined };
}

function link(ctx: Ctx, op: Extract<Op, { op: 'link' }>): Plan {
  const a = need(ctx, op.from), b = need(ctx, op.to), type = op.type;
  if (a.id === b.id) throw new Error('A task cannot link to itself');
  if (typeof type !== 'string') throw new Error('Link type must be a string');
  if (type !== SUBTASK && type !== PARENT && !(b.type in (ctx.db.format.types[a.type]?.links[type] ?? {})))
    throw new Error(`Link "${type}" of [${a.type}] cannot target [${b.type}]`);
  if (ctx.db.edges.some(e => (e.from === a.id && e.to === b.id && e.type === type) || (e.from === b.id && e.to === a.id && e.reverse === type)))
    throw new Error('These tasks are already linked that way');
  return { edits: [addItem(home(ctx, a), type === SUBTASK ? null : type, ref(b.type, b.title))], id: a.id };
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
    case 'move': return op.path !== undefined ? moveNode(ctx, op) : moveTask(ctx, op);
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
