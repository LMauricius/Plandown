/**
 * Webview tabs running the library's GUI (`dist/gui`): one graph and one time tab per root (webview panels), task and
 * group pages (the `plandown.task` custom editor on virtual URIs, see `pageUri`, so they get VSCode's preview tabs and history) and the
 * `plandown.file` / `plandown.own` custom editors that show a `.md` / `.plandown.md` file's tree node, as a sidebar click
 * does (also the tab of a node or task merged with a file, see `target`). The GUI talks to the host through
 * postMessage (see `Msg`); the host answers from the root's `Plandown` instance.
 */
import * as vscode from 'vscode';
import { relative, sep } from 'node:path';
import type { Op, TreeNode } from 'plandown' with { 'resolution-mode': 'import' };
import type { Apply, Root } from './extension.js';
import { findIn, typeIcon } from './tree.js';

/**
 * Webview → host: `state` and `op` carry a request id `rid` answered with `{ rid, db }` / `{ rid, id, db, error }`
 * (the HTTP API's responses); `open` asks for another task's tab (`pin`: a pinned one, not a preview), `openNode` for a group
 * or file page; `reveal` opens a file at a line in a text editor; `copy` copies a task's or node's `linkOf`, answered with `{ rid, link }`
 * (none: no such task or node).
 * Host → webview: `changed` (the folder was reloaded; the GUI refetches state, as on its SSE event).
 */
type Msg = { t: 'state'; rid: number } | { t: 'op'; rid: number; op: Op } | { t: 'open'; id: string; pin?: boolean } | { t: 'openNode'; path: string; pin?: boolean }
  | { t: 'reveal'; file: string; line: number } | { t: 'copy'; rid: number; id?: unknown; path?: unknown };

/** What a tab shows; `task` tabs follow their task across renames, `node` tabs (a tree node's page) stay on their path. */
type View = { kind: 'task'; id: string } | { kind: 'node'; path: string } | { kind: 'graph' } | { kind: 'time' };
type Page = Extract<View, { kind: 'task' | 'node' }>;

/** `uri`: the URI of a custom editor tab (virtual for `plandown.task`, else the file); `panel.viewType` is its editor. */
interface Tab { panel: vscode.WebviewPanel; root: Root; view: View; key: string; uri?: vscode.Uri }

// ---- Utilities ----

// Node paths get a leading `/`, which neither task ids (`[Type] Title`) nor view kinds have
const keyOf = (root: Root, view: View) => `${root.uri.fsPath}\0${view.kind === 'task' ? view.id : view.kind === 'node' ? '/' + view.path : view.kind}`;
const TITLES = { graph: 'Graph', time: 'Timeline' };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Virtual URI of a page tab: `<root>/.plandown-tasks/<title>?root=…&id=…` for a task, `…/<name>?root=…&node=<path>` for a
 * tree node (no such file exists). Custom editor tabs are labeled with the URI's basename (`panel.title` is ignored), so
 * the basename is the title (`/` swapped for a lookalike); the query names the page. It stays in the root's own scheme (`file`, or the remote one) because VSCode's Go Back/Forward
 * history drops closed editors of other schemes, which would forget every replaced preview tab.
 */
const pageUri = (root: Root, page: Page) => root.uri.with({
  path: `${root.uri.path}/.plandown-tasks/${(page.kind === 'node' ? page.path.slice(page.path.lastIndexOf('/') + 1) : root.pd.db.tasks[page.id]?.title ?? page.id).replace(/\//g, '∕')}`,
  query: new URLSearchParams(page.kind === 'node' ? { root: root.uri.fsPath, node: page.path } : { root: root.uri.fsPath, id: page.id }).toString(),
});

/**
 * Where a page opens: a file node, or a task merged with one, on the file itself, in the editor its suffix gets by
 * default; every other page (folder-only nodes too: no custom editor opens a folder) on its virtual URI.
 */
function target(root: Root, page: Page): { uri: vscode.Uri; type: string } {
  const file = findIn(root.pd.db.tree, n => page.kind === 'task' ? n.task === page.id : n.path === page.path)?.file;
  return file ? { uri: vscode.Uri.joinPath(root.uri, file), type: file.endsWith('.plandown.md') ? 'plandown.own' : 'plandown.file' }
    : { uri: pageUri(root, page), type: 'plandown.task' };
}

/**
 * Link to a page for other tools: the file path relative to its workspace folder; a task inside a file (not merged with it)
 * adds `#<anchor>`, a folder-only group is its folder. Kept equal to the GUI's `diskLink`.
 * shortcut: `anchor` is unique across the database, so it is the file's own heading anchor unless two tasks of different files share a slug (or a non-task heading does)
 */
export function linkOf(root: Root, page: Page): string | undefined {
  const db = root.pd.db, rel = (p: string) => vscode.workspace.asRelativePath(vscode.Uri.joinPath(root.uri, p), false);
  if (page.kind === 'node') { const n = findIn(db.tree, x => x.path === page.path); return n && rel(n.file ?? n.path); }
  const t = db.tasks[page.id];
  return t && (findIn(db.tree, n => n.task === t.id) ? rel(t.home.file) : `${rel(t.home.file)}#${t.anchor}`);
}

/** Whether `path` names a node of `tree` (paths from a page are not trusted). */
const hasNode = (tree: TreeNode[], path: string): boolean => tree.some(n => n.path === path || (path.startsWith(n.path + '/') && hasNode(n.kids, path)));

/** Webview page with nothing but a message (files outside a root or without tasks). */
const note = (text: string) => `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><p>${esc(text)}</p>`;

/**
 * Page for one view: the GUI's stylesheet and `app.js` as webview URIs, `<body data-view data-root data-task>` (read by
 * the GUI, and saved as its state for restoring the tab) and only `#main` and `#toast` (no header). CSP: nothing but
 * the webview's own resources; inline style properties set from script are CSSOM, not blocked.
 */
function html(webview: vscode.Webview, gui: vscode.Uri, root: Root, view: View): string {
  const src = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(gui, f));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; script-src ${webview.cspSource}">
<link rel="stylesheet" href="${src('style.css')}"></head>
<body data-view="${view.kind}" data-root="${esc(root.uri.fsPath)}"${view.kind === 'task' ? ` data-task="${esc(view.id)}"` : view.kind === 'node' ? ` data-node="${esc(view.path)}"` : ''}>
<main id="main"></main><div id="toast" hidden></div>
<script type="module" src="${src('app.js')}"></script></body></html>`;
}

/** The root holding `uri` and the file's `/`-separated path in it. */
function rootOf(roots: Root[], uri: vscode.Uri): { root: Root; file: string } | undefined {
  const root = roots.find(r => uri.fsPath.startsWith(r.uri.fsPath + sep));
  return root && { root, file: relative(root.uri.fsPath, uri.fsPath).split(sep).join('/') };
}

export class Panels implements vscode.CustomReadonlyEditorProvider, vscode.WebviewPanelSerializer {
  /** Open tabs by `keyOf`, so opening a task again reveals its tab. */
  private tabs = new Map<string, Tab>();

  /** `gui`: the library's `dist/gui` folder, the webviews' only local resource root. `roots` resolves once loading is done. */
  constructor(private gui: vscode.Uri, private roots: () => Promise<Root[]>, private apply: Apply) {}

  /** The focused Plandown tab, if any. */
  active(): Tab | undefined { return [...this.tabs.values()].find(t => t.panel.active); }

  /**
   * Link of a tab (`linkOf`): of the editor `uri` (a tab's context menu), else of the focused Plandown tab. A file URI
   * links the file itself (it is the page of the task merged with it, or the file's own page).
   */
  async link(uri?: vscode.Uri): Promise<string | undefined> {
    if (!uri) { const t = this.active(); return t && (t.view.kind === 'task' || t.view.kind === 'node') ? linkOf(t.root, t.view) : undefined; }
    const q = new URLSearchParams(uri.query), id = q.get('id'), path = q.get('node');
    if (!id && !path) return uri.scheme === 'file' ? vscode.workspace.asRelativePath(uri, false) : undefined;
    const root = (await this.roots()).find(r => r.uri.fsPath === q.get('root'));
    return root && linkOf(root, id ? { kind: 'task', id } : { kind: 'node', path: path! });
  }

  /**
   * Reveals the task's tab or opens it as a preview tab (replacing the group's preview tab, as for files). `pin` opens a
   * pinned tab instead; reopening a task tab's own URI pins it if it is the active group's preview tab. `keep` keeps the
   * focus where it is (a tree click's preview, as the Explorer does).
   */
  openTask(root: Root, id: string, pin = false, keep = false): void { this.openPage(root, { kind: 'task', id }, pin, keep); }

  /** Reveals or opens a group or file page, as `openTask`. */
  openNode(root: Root, path: string, pin = false, keep = false): void { this.openPage(root, { kind: 'node', path }, pin, keep); }

  private openPage(root: Root, page: Page, pin: boolean, keep: boolean): void {
    const hit = this.tabs.get(keyOf(root, page));
    if (hit && !(pin && hit.uri)) return hit.panel.reveal(undefined, keep);
    const to = hit?.uri ? { uri: hit.uri, type: hit.panel.viewType } : target(root, page);
    vscode.commands.executeCommand('vscode.openWith', to.uri, to.type, { preview: !pin, preserveFocus: keep, viewColumn: vscode.ViewColumn.Active });
  }

  /** Reveals or opens the root's graph or time tab. */
  openView(root: Root, kind: 'graph' | 'time'): void {
    const hit = this.tabs.get(keyOf(root, { kind }));
    if (hit) return hit.panel.reveal();
    const panel = vscode.window.createWebviewPanel('plandown.view', TITLES[kind], vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.gui] });
    this.bind(panel, root, { kind });
  }

  /** Tells every tab of `root` to refetch (tabs of vanished tasks stay, the GUI says so) and updates task tabs' icons. */
  changed(root: Root): void { for (const t of this.tabs.values()) if (t.root === root) { this.icon(t); t.panel.webview.postMessage({ t: 'changed' }); } }

  /** A task tab's icon: the tree's type icon (a vanished task keeps its last one). */
  private icon({ panel, root, view }: Tab): void {
    const t = view.kind === 'task' ? root.pd.db.tasks[view.id] : undefined;
    if (t) panel.iconPath = typeIcon(t.type, root.pd.db.format.types[t.type]?.color, t.props.done === true);
  }

  /** Closes every tab of a root that is no longer loaded. */
  drop(root: Root): void { for (const t of [...this.tabs.values()]) if (t.root === root) t.panel.dispose(); }

  /**
   * Reopens a tab under its renamed task's URI (its label follows only the URI; a merged file was moved with the task),
   * in the same group and preview state. A preview tab is replaced by the new preview tab; a pinned one is closed.
   */
  private async relabel(old: vscode.Uri, root: Root, id: string): Promise<void> {
    const to = target(root, { kind: 'task', id });
    if (to.uri.toString() === old.toString()) return;
    for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) {
      if (!(t.input instanceof vscode.TabInputCustom) || t.input.uri.toString() !== old.toString()) continue;
      await vscode.commands.executeCommand('vscode.openWith', to.uri, to.type, { preview: t.isPreview, viewColumn: g.viewColumn });
      if (!t.isPreview) await vscode.window.tabGroups.close(t);
      return;
    }
  }

  /**
   * Wires a panel: html, message handler, `plandown.active` context key, and removal from `tabs` on dispose (only its
   * own entry: a file editor and a task tab may show the same task, the later one owns the key).
   */
  private bind(panel: vscode.WebviewPanel, root: Root, view: View, uri?: vscode.Uri): void {
    const tab: Tab = { panel, root, view, key: keyOf(root, view), uri };
    this.tabs.set(tab.key, tab);
    const focus = () => vscode.commands.executeCommand('setContext', 'plandown.active', [...this.tabs.values()].some(t => t.panel.active));
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.gui] };
    panel.webview.html = html(panel.webview, this.gui, root, view);
    panel.onDidChangeViewState(focus);
    panel.onDidDispose(() => { if (this.tabs.get(tab.key) === tab) this.tabs.delete(tab.key); focus(); });
    focus();
    this.icon(tab);

    panel.webview.onDidReceiveMessage(async (m: Msg) => {
      const db = () => root.pd.db, post = (r: object) => panel.webview.postMessage(r);
      if (m.t === 'state') return post({ rid: m.rid, db: db() });
      if (m.t === 'open') { if (db().tasks[m.id]) this.openTask(root, m.id, m.pin === true); return; }
      if (m.t === 'openNode') { if (hasNode(db().tree, m.path)) this.openNode(root, m.path, m.pin === true); return; }
      // Only files of the database (no paths from the page are trusted)
      if (m.t === 'reveal') {
        if (db().files.includes(m.file)) vscode.window.showTextDocument(vscode.Uri.joinPath(root.uri, m.file), { selection: new vscode.Range(m.line, 0, m.line, 0) });
        return;
      }
      if (m.t === 'copy') {
        const link = typeof m.id === 'string' ? linkOf(root, { kind: 'task', id: m.id }) : typeof m.path === 'string' ? linkOf(root, { kind: 'node', path: m.path }) : undefined;
        if (link) await vscode.env.clipboard.writeText(link);
        return post({ rid: m.rid, link });
      }
      if (m.t !== 'op') return;
      let id: string | undefined, error: string | undefined;
      try { id = await this.apply(root, m.op); } catch (e) { error = (e as Error).message; }
      // A save that renamed this tab's task rekeys the tab (a virtual one is reopened under the new URI); deleting it closes the tab
      const v = tab.view;
      let renamed = false;
      if (!error && v.kind === 'task' && 'id' in m.op && m.op.id === v.id) {
        if (m.op.op === 'delete') return panel.dispose();
        if (m.op.op === 'update' && id && id !== v.id) {
          if (this.tabs.get(tab.key) === tab) this.tabs.delete(tab.key);
          tab.view = { kind: 'task', id };
          this.tabs.set(tab.key = keyOf(root, tab.view), tab);
          renamed = true;
          this.icon(tab);   // `changed` ran before the rekey, under the old id
        }
      }
      post({ rid: m.rid, id, db: db(), error });
      // Editing pins a preview tab, as for text editors (`keepEditor` acts on the active editor)
      if (tab.uri && panel.active) await vscode.commands.executeCommand('workbench.action.keepEditor');
      if (renamed && tab.uri) this.relabel(tab.uri, root, id!);
    });
  }

  // ---- Restoring tabs after a window reload ----

  /**
   * Rebinds a graph or time tab from the GUI's saved state (`data-*` of its page); tabs of roots no longer loaded are
   * closed. Task tabs are custom editors, which VSCode restores from their URIs.
   */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { view?: string; root?: string } | undefined): Promise<void> {
    const root = (await this.roots()).find(r => r.uri.fsPath === state?.root);
    const view: View | undefined = state?.view === 'graph' || state?.view === 'time' ? { kind: state.view } : undefined;
    if (!root || !view || this.tabs.has(keyOf(root, view))) return panel.dispose();
    this.bind(panel, root, view);
  }

  // ---- Custom editor ----

  /** Plain document: the file's content lives in the database, not here. */
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument { return { uri, dispose() {} }; }

  /**
   * `plandown.task`: binds the panel as the tab of the task or tree node its URI names (only loaded roots). `plandown.file`: binds it
   * as the tab of the file's tree node (by stem, so `a.md` and `a.plandown.md` share node `a`), as a tree click opens it: the
   * merged task's tab, else the node's page (so tree clicks reveal it); `plandown.own` is the same, as the default editor of
   * `*.plandown.md`. A database file without tasks and folder (new or empty) goes to the text editor, since Plandown is its
   * default editor (focused only if this panel was: an Explorer preview click keeps the focus).
   * Otherwise a short message page.
   */
  async resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const roots = await this.roots();
    const q = new URLSearchParams(doc.uri.query);
    if (q.has('id') || q.has('node')) {
      const root = roots.find(r => r.uri.fsPath === q.get('root')), id = q.get('id'), path = q.get('node');
      if (root && (id || path)) return this.bind(panel, root, id ? { kind: 'task', id } : { kind: 'node', path: path! }, doc.uri);
      panel.webview.html = note('This page\'s Plandown database is not loaded.');
      return;
    }
    const at = rootOf(roots, doc.uri), stem = at?.file.replace(/(\.plandown)?\.md$/, ''), n = at && findIn(at.root.pd.db.tree, x => x.path === stem);
    if (n?.task) return this.bind(panel, at!.root, { kind: 'task', id: n.task }, doc.uri);
    if (n && (n.tasks.length || n.folder)) return this.bind(panel, at!.root, { kind: 'node', path: n.path }, doc.uri);
    if (at) {
      await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default', { viewColumn: panel.viewColumn, preserveFocus: !panel.active });
      return panel.dispose();
    }
    panel.webview.html = note('This file is not inside a Plandown database (a folder with plandown-format.md).');
  }
}
