/**
 * Navigation tree in the activity bar, built from the library's `db.tree` (the same structure the GUI sidebar shows):
 * folders and files merged by stem, files merged with their single same-named task, top-level tasks and their subtasks.
 * Children are produced lazily, as VSCode asks for them.
 */
import * as vscode from 'vscode';
import { basename } from 'node:path';
import type { TreeNode } from 'plandown' with { 'resolution-mode': 'import' };
import type { Apply, Root } from './extension.js';

const SUBTASK = 'Subtask';
const hours = (v: number) => String(Math.round(v * 100) / 100);
const TYPE_SCHEME = 'plandown-type';
/** style.css theme fallbacks: an image icon can't read theme variables, so light and dark themes get one SVG each. */
const THEMES = {
  light: { surface: '#ffffff', fg: '#1d2430', accent: '#0b7f7a', gloss: '#ffffffb3' },
  dark: { surface: '#1c2128', fg: '#e4e8ee', accent: '#4cc2b8', gloss: '#ffffff1a' },
};
const FONT = `'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif`;

/**
 * Icon of a task row: the GUI's `.badge` bubble (same colors, border, gloss, shade, font family) as a 16x16 square,
 * holding the type's uppercase first letter (larger and bolder than the badge's text, to read at icon size), or a
 * checkmark when done. Shared by tree rows and task tabs. The left side stays round, the right corners 4px.
 * Colors use `color-mix` like style.css, so any CSS color the renderer accepts works.
 */
export function typeIcon(type: string, color: string | undefined, done: boolean): { light: vscode.Uri; dark: vscode.Uri } {
  const c = color && /^[^<>"&]+$/.test(color) ? color : undefined;   // nothing may break out of the style attribute
  const letter = ([...type][0] ?? '').toUpperCase().replace(/[&<>]/g, x => `&#${x.charCodeAt(0)};`);
  const svg = (th: typeof THEMES.light) => {
    // Each property twice, the type's color last: a color the renderer rejects drops only that declaration, leaving the accent (as the GUI's CSS.supports check)
    const mix = (prop: string, pct: number, other: string) => [th.accent, c].filter(Boolean).map(x => `${prop}:color-mix(in srgb,${x} ${pct}%,${other})`).join(';');
    const mark = done
      ? `<path d="M4.5 8.5L7.5 11.5L13 5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="${mix('stroke', 72, th.fg)}"/>`
      : `<text x="9" y="8" text-anchor="middle" dominant-baseline="central" style="font:600 13px ${FONT};${mix('fill', 72, th.fg)}">${letter}</text>`;
    // Body: fill is the background, the 1px stroke (centered on the inset path) the border over it. Clip: the padding box, where inset shadows paint.
    // The content sits 1px right of center: the badge's padding is 7px on the round side, 5px on the other.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">`
      + `<defs><clipPath id="p"><path d="M8 1H12A3 3 0 0 1 15 4V12A3 3 0 0 1 12 15H8A7 7 0 0 1 8 1Z"/></clipPath><filter id="b"><feGaussianBlur stdDeviation=".5"/></filter></defs>`
      + `<path d="M8 .5H12.5A3.5 3.5 0 0 1 15.5 4V12A3.5 3.5 0 0 1 12.5 15.5H8A7.5 7.5 0 0 1 8 .5Z" stroke-width="1" style="${mix('fill', 16, th.surface)};${mix('stroke', 28, 'transparent')}"/>`
      + `<g clip-path="url(#p)"><rect y="1" width="16" height="1" fill="${th.gloss}"/><rect y="14" width="16" height="1.5" filter="url(#b)" style="${mix('fill', 22, 'transparent')}"/></g>`
      + mark + `</svg>`;
  };
  const uri = (th: typeof THEMES.light) => vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg(th))}`);
  return { light: uri(THEMES.light), dark: uri(THEMES.dark) };
}

/**
 * Type marker of task rows: a 1-2 character file decoration badge on the right, which stays visible while the label is
 * shortened. Uncolored: a decoration's color would tint the label too. The row's `resourceUri` carries the type, so
 * this provider is stateless.
 */
export const typeDecorations: vscode.FileDecorationProvider = {
  provideFileDecoration(uri) {
    if (uri.scheme !== TYPE_SCHEME) return;
    // VSCode rejects badges over 2 UTF-16 units: two characters, or one if either is astral (emoji)
    const type = uri.path.slice(1), cps = [...type], badge = cps.slice(0, 2).join('');
    return new vscode.FileDecoration(badge.length <= 2 ? badge : cps[0], type);
  },
};

/**
 * Tree element. `node`: a folder and/or file row (or a task merged into it). `task`: a task row under node path `near`
 * (new tasks and groups created from it go there, as from the GUI's picked row). `up` holds the ancestors' ids and
 * `leaf` stops expansion: a task met again below itself (a Subtask cycle) is listed but not expanded, like the GUI's
 * `walk`, and filter matches are a flat list. With more than one root, roots are the top level. `parent` serves `getParent`
 * (for `reveal`; none at the top level).
 */
export type Item =
  | { kind: 'root'; root: Root }
  | { kind: 'node'; root: Root; node: TreeNode; parent?: Item }
  | { kind: 'task'; root: Root; id: string; near: string; up: string[]; leaf: boolean; parent?: Item };

export class TaskTree implements vscode.TreeDataProvider<Item> {
  /** Filter text; non-empty shows a flat list of tasks whose id or description contains it (case-insensitive), as the GUI does. */
  filter = '';
  private change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;

  constructor(private roots: () => Root[], private apply: Apply) {}

  /** Rebuilds the whole tree (after any reload; it is cheap). */
  refresh(): void { this.change.fire(); }

  getParent(item: Item): Item | undefined { return item.kind === 'root' ? undefined : item.parent; }

  getChildren(item?: Item): Item[] {
    const parent = item;
    const task = (root: Root, id: string, near: string, up: string[]): Item => ({ kind: 'task', root, id, near, up, leaf: up.includes(id), parent });
    const subtasks = (root: Root, id: string, near: string, up: string[]) =>
      root.pd.db.edges.filter(e => e.type === SUBTASK && e.from === id).map(e => task(root, e.to, near, up));
    const nodes = (root: Root, list: TreeNode[]) => list.map((node): Item => ({ kind: 'node', root, node, parent }));

    if (!item) {
      const roots = this.roots(), q = this.filter.toLowerCase();
      if (q) return roots.flatMap(root => Object.values(root.pd.db.tasks)
        .filter(t => `${t.id}\n${t.body.filter(x => typeof x === 'string').join('\n')}`.toLowerCase().includes(q))
        .map((t): Item => ({ kind: 'task', root, id: t.id, near: t.home.file.replace(/(\.plandown)?\.md$/, ''), up: [], leaf: true })));
      return roots.length === 1 ? nodes(roots[0], roots[0].pd.db.tree) : roots.map(root => ({ kind: 'root', root }));
    }
    const { root } = item;
    if (item.kind === 'root') return nodes(root, root.pd.db.tree);
    if (item.kind === 'task') return item.leaf ? [] : subtasks(root, item.id, item.near, [...item.up, item.id]);
    const n = item.node;
    return [...n.task ? subtasks(root, n.task, n.path, [n.task]) : n.tasks.map(id => task(root, id, n.path, [])), ...nodes(root, n.kids)];
  }

  /**
   * Root: folder name. Node: folder/file icon and base name, click opens its page. Task (and merged node): title, type and
   * `spent/effort h` as description, Done checkbox, click opens its tab. Clicks also expand the row (the item rides along).
   * Task rows (and merged nodes) carry their type marker (see `typeDecorations`) and type icon (replacing a merged node's folder/file icon). Done
   * titles are crossed out with combining strokes (tree labels have no text styling). Ids follow the path from the root, so expansion survives refreshes.
   */
  getTreeItem(item: Item): vscode.TreeItem {
    const { root } = item, db = root.pd.db, none = vscode.TreeItemCollapsibleState.None, closed = vscode.TreeItemCollapsibleState.Collapsed;
    if (item.kind === 'root') {
      const ti = new vscode.TreeItem(basename(root.uri.fsPath), vscode.TreeItemCollapsibleState.Expanded);
      return Object.assign(ti, { id: root.uri.fsPath, iconPath: new vscode.ThemeIcon('database'), tooltip: root.uri.fsPath, contextValue: 'root' });
    }
    const id = item.kind === 'node' ? item.node.task : item.id;
    const hasSubtasks = !!id && db.edges.some(e => e.type === SUBTASK && e.from === id);
    let ti: vscode.TreeItem;
    if (item.kind === 'node') {
      const n = item.node;
      ti = new vscode.TreeItem(basename(n.path), n.kids.length || (n.task ? hasSubtasks : n.tasks.length) ? closed : none);
      Object.assign(ti, { id: `${root.uri.fsPath}\0${n.path}`, contextValue: n.task ? 'nodeTask' : 'node', iconPath: new vscode.ThemeIcon(n.folder ? 'folder' : 'file'), tooltip: n.file ?? n.path + '/' });
      if (!n.task) ti.command = { command: 'plandown.openNode', title: 'Open', arguments: [root, n.path, item] };
    } else {
      ti = new vscode.TreeItem('', !item.leaf && hasSubtasks ? closed : none);
      Object.assign(ti, { id: `${root.uri.fsPath}\0${item.near}\0${[...item.up, id].join('\0')}`, contextValue: 'task' });
    }
    const t = id ? db.tasks[id] : undefined;
    if (!t) return ti;
    const tot = db.totals[t.id];
    const done = t.props.done === true;
    ti.label = done ? t.title.replace(/./gu, '$&\u0336') : t.title;
    if (done) ti.accessibilityInformation = { label: `${t.title}, done` };   // screen readers would spell the strokes
    ti.description = tot.effort || tot.spent ? `${t.type} · ${hours(tot.spent)}/${hours(tot.effort)} h` : t.type;
    ti.tooltip = `${t.id}\n${t.home.file}`;
    ti.checkboxState = done ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    ti.command = { command: 'plandown.open', title: 'Open', arguments: [root, t.id, item] };
    ti.iconPath = typeIcon(t.type, db.format.types[t.type]?.color, done);
    ti.resourceUri = vscode.Uri.from({ scheme: TYPE_SCHEME, path: '/' + t.type });
    return ti;
  }

  /** Done checkboxes: one update per changed task, as the GUI's row checkbox. */
  async checked(e: vscode.TreeCheckboxChangeEvent<Item>): Promise<void> {
    for (const [item, state] of e.items) {
      const id = item.kind === 'node' ? item.node.task : item.kind === 'task' ? item.id : null, t = id ? item.root.pd.db.tasks[id] : undefined;
      if (t) await this.apply(item.root, { op: 'update', id: t.id, props: { ...t.props, done: state === vscode.TreeItemCheckboxState.Checked || undefined } })
        .catch(err => vscode.window.showErrorMessage((err as Error).message));
    }
  }
}
