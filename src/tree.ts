/**
 * Sidebar tree: folders and task files as one structure. A folder and a file with the same stem
 * (`a/b/` and `a/b.md` or `a/b.plandown.md`) are one node; a file whose only top-level task is named like the file is
 * merged with that task. Pure, built with the database, so every front end shows the same tree.
 */
import { SUBTASK } from './format.js';
import type { Edge, Task } from './db.js';

/** One node: a folder and/or a file sharing `path` (stem relative to the root, `/`-separated). */
export interface TreeNode {
  path: string;
  folder: boolean;       // folder `path/` exists
  file: string | null;   // `path.md` (else `path.plandown.md`), if it exists
  task: string | null;   // the file's single top-level task, merged into this node
  tasks: string[];       // task rows under the node: the file's top-level tasks in file order; if merged, `task`'s subtasks not shown by `kids`
  kids: TreeNode[];      // child folders and files, natural name order
  done: boolean;         // every task homed in the node's file or below it is done, and there is at least one
}

const byName = new Intl.Collator(undefined, { numeric: true }).compare;

/**
 * GitHub-style heading slug (`[Task] Fix login` → `task-fix-login`). Task anchors use it, and comparing slugs lets
 * a file name match a task title regardless of case, punctuation or a type prefix.
 */
export const slug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');

/** Last segment of a `/`-separated path. */
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/**
 * Stem of a task file: its path minus `.md`, or minus `.plandown.md` (the suffix that lets editors recognize Plandown
 * files by name alone), so `a.md` and `a.plandown.md` both name node `a`.
 */
export const fileStem = (file: string) => file.replace(/(\.plandown)?\.md$/, '');

/** Whether a file or folder stem names the task: by its title (`Fix login`) or by its id (`[Task] Fix login`). */
export function namesTask(stem: string, type: string, title: string): boolean {
  const s = slug(baseName(stem));
  return s === slug(title) || s === slug(`[${type}] ${title}`);
}

/** Finds a node by path (`''` is the root, which has no node). */
export function findNode(tree: TreeNode[], path: string): TreeNode | undefined {
  for (let level = tree, i = 0, parts = path.split('/'); i < parts.length; i++) {
    const n = level.find(k => baseName(k.path) === parts[i]);
    if (!n || i === parts.length - 1) return n;
    level = n.kids;
  }
}

export function buildTree(files: string[], folders: string[], tasks: Record<string, Task>, edges: Edge[]): TreeNode[] {
  // Nodes by path; a node implies its parent folders
  const nodes = new Map<string, TreeNode>();
  const node = (path: string): TreeNode => {
    let n = nodes.get(path);
    if (n) return n;
    nodes.set(path, n = { path, folder: false, file: null, task: null, tasks: [], kids: [], done: false });
    const cut = path.lastIndexOf('/');
    if (cut >= 0) { const p = node(path.slice(0, cut)); p.folder = true; p.kids.push(n); }
    return n;
  };
  for (const f of folders) node(f).folder = true;
  for (const f of files) node(fileStem(f)).file ??= f;   // `a.md` sorts before `a.plandown.md` and wins

  // Top-level tasks of each file: no parent in the same file, or only reachable through a same-file Subtask cycle
  // (otherwise they would be listed nowhere). A parent in another file does not count: the task still shows in its own file
  const subs = new Map<string, string[]>(), kids = new Map<string, string[]>(), hasParent = new Set<string>(), reached = new Set<string>();
  for (const e of edges) if (e.type === SUBTASK) {
    subs.set(e.from, [...subs.get(e.from) ?? [], e.to]);
    if (tasks[e.from].home.file === tasks[e.to].home.file) { kids.set(e.from, [...kids.get(e.from) ?? [], e.to]); hasParent.add(e.to); }
  }
  const reach = (id: string) => {
    for (const stack = [id]; stack.length;) {
      const v = stack.pop()!;
      if (!reached.has(v)) { reached.add(v); stack.push(...kids.get(v) ?? []); }
    }
  };
  const top = Object.keys(tasks).filter(id => !hasParent.has(id));
  top.forEach(reach);
  for (const id in tasks) if (!reached.has(id)) { top.push(id); reach(id); }
  for (const id of top.sort((a, b) => tasks[a].home.line - tasks[b].home.line)) nodes.get(fileStem(tasks[id].home.file))?.tasks.push(id);

  // Merge single, same-named tasks into their file's node; order everything by name
  for (const n of nodes.values()) {
    const t = n.tasks.length === 1 ? tasks[n.tasks[0]] : undefined;
    if (n.file && t && namesTask(n.path, t.type, t.title)) { n.task = t.id; n.tasks = []; }
    n.kids.sort((a, b) => byName(a.path, b.path));
  }
  // A merged node lists its task's subtasks, except those its child nodes already show (as their task or top-level tasks)
  // Its child nodes merged with those subtasks come first, in the parent's order (Infinity - Infinity is NaN: falls to the name)
  for (const n of nodes.values()) if (n.task) {
    const order = subs.get(n.task) ?? [], at = (k: TreeNode) => { const i = k.task ? order.indexOf(k.task) : -1; return i < 0 ? Infinity : i; };
    n.kids.sort((a, b) => at(a) - at(b) || byName(a.path, b.path));
    const shown = new Set(n.kids.flatMap(k => k.task ? [k.task] : k.tasks));
    n.tasks = (subs.get(n.task) ?? []).filter(id => !shown.has(id));
  }
  // Done: task counts per home stem, summed bottom-up (every task has the built-in Done, so "no tasks" is the only exemption)
  const count = new Map<string, { all: number; done: number }>();
  for (const id in tasks) {
    const c = count.get(fileStem(tasks[id].home.file)) ?? { all: 0, done: 0 };
    c.all++; c.done += tasks[id].props.done === true ? 1 : 0;
    count.set(fileStem(tasks[id].home.file), c);
  }
  const sum = (n: TreeNode): { all: number; done: number } => {
    const c = { ...count.get(n.path) ?? { all: 0, done: 0 } };
    for (const k of n.kids) { const s = sum(k); c.all += s.all; c.done += s.done; }
    n.done = c.all > 0 && c.done === c.all;
    return c;
  };
  const roots = [...nodes.values()].filter(n => !n.path.includes('/')).sort((a, b) => byName(a.path, b.path));
  roots.forEach(sum);
  return roots;
}
