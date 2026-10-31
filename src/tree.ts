/**
 * Sidebar tree: folders and task files as one structure. A folder and a file with the same stem
 * (`a/b/` and `a/b.md`) are one node; a file whose only top-level task is named like the file is
 * merged with that task. Pure, built with the database, so every front end shows the same tree.
 */
import { SUBTASK } from './format.js';
import type { Edge, Task } from './db.js';

/** One node: a folder and/or a file sharing `path` (stem relative to the root, `/`-separated). */
export interface TreeNode {
  path: string;
  folder: boolean;       // folder `path/` exists
  file: string | null;   // `path.md`, if it exists
  task: string | null;   // the file's single top-level task, merged into this node
  tasks: string[];       // other top-level tasks whose home is the file, in file order
  kids: TreeNode[];      // child folders and files, natural name order
}

const byName = new Intl.Collator(undefined, { numeric: true }).compare;

/**
 * GitHub-style heading slug (`[Task] Fix login` → `task-fix-login`). Task anchors use it, and comparing slugs lets
 * a file name match a task title regardless of case, punctuation or a type prefix.
 */
export const slug = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');

/** Last segment of a `/`-separated path. */
export const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

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
    nodes.set(path, n = { path, folder: false, file: null, task: null, tasks: [], kids: [] });
    const cut = path.lastIndexOf('/');
    if (cut >= 0) { const p = node(path.slice(0, cut)); p.folder = true; p.kids.push(n); }
    return n;
  };
  for (const f of folders) node(f).folder = true;
  for (const f of files) node(f.slice(0, -3)).file = f;

  // Top-level tasks: no parent, or only reachable through a Subtask cycle (otherwise they would be listed nowhere)
  const kids = new Map<string, string[]>(), hasParent = new Set<string>(), reached = new Set<string>();
  for (const e of edges) if (e.type === SUBTASK) { kids.set(e.from, [...kids.get(e.from) ?? [], e.to]); hasParent.add(e.to); }
  const reach = (id: string) => {
    for (const stack = [id]; stack.length;) {
      const v = stack.pop()!;
      if (!reached.has(v)) { reached.add(v); stack.push(...kids.get(v) ?? []); }
    }
  };
  const top = Object.keys(tasks).filter(id => !hasParent.has(id));
  top.forEach(reach);
  for (const id in tasks) if (!reached.has(id)) { top.push(id); reach(id); }
  for (const id of top.sort((a, b) => tasks[a].home.line - tasks[b].home.line)) nodes.get(tasks[id].home.file.slice(0, -3))?.tasks.push(id);

  // Merge single, same-named tasks into their file's node; order everything by name
  for (const n of nodes.values()) {
    const t = n.tasks.length === 1 ? tasks[n.tasks[0]] : undefined;
    if (n.file && t && namesTask(n.path, t.type, t.title)) { n.task = t.id; n.tasks = []; }
    n.kids.sort((a, b) => byName(a.path, b.path));
  }
  return [...nodes.values()].filter(n => !n.path.includes('/')).sort((a, b) => byName(a.path, b.path));
}
