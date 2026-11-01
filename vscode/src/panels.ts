/**
 * Webview tabs running the library's GUI (`dist/gui`): one tab per task, one graph and one time tab per root, and the
 * `plandown.file` custom editor that shows the first task of a `.md` file. The GUI talks to the host through
 * postMessage (see `Msg`); the host answers from the root's `Plandown` instance.
 */
import * as vscode from 'vscode';
import { relative, sep } from 'node:path';
import type { Op } from 'plandown' with { 'resolution-mode': 'import' };
import type { Apply, Root } from './extension.js';

/**
 * Webview → host: `state` and `op` carry a request id `rid` answered with `{ rid, db }` / `{ rid, id, db, error }`
 * (the HTTP API's responses); `open` asks for another task's tab; `reveal` opens a file at a line in a text editor.
 * Host → webview: `changed` (the folder was reloaded; the GUI refetches state, as on its SSE event).
 */
type Msg = { t: 'state'; rid: number } | { t: 'op'; rid: number; op: Op } | { t: 'open'; id: string } | { t: 'reveal'; file: string; line: number };

/** What a tab shows; `task` tabs follow their task across renames. */
type View = { kind: 'task'; id: string } | { kind: 'graph' } | { kind: 'time' };

interface Tab { panel: vscode.WebviewPanel; root: Root; view: View; key: string }

// ---- Utilities ----

const keyOf = (root: Root, view: View) => `${root.uri.fsPath}\0${view.kind === 'task' ? view.id : view.kind}`;
const TITLES = { graph: 'Graph', time: 'Timeline' };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

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
<body data-view="${view.kind}" data-root="${esc(root.uri.fsPath)}"${view.kind === 'task' ? ` data-task="${esc(view.id)}"` : ''}>
<main id="main"></main><div id="toast" hidden></div>
<script type="module" src="${src('app.js')}"></script></body></html>`;
}

/** The root holding `uri` and the file's `/`-separated path in it. */
function rootOf(roots: Root[], uri: vscode.Uri): { root: Root; file: string } | undefined {
  const root = roots.find(r => uri.fsPath.startsWith(r.uri.fsPath + sep));
  return root && { root, file: relative(root.uri.fsPath, uri.fsPath).split(sep).join('/') };
}

/** First task occurring in `file`: smallest line over all task occurrences in that file. */
function firstTask(root: Root, file: string): string | undefined {
  let best: { id: string; line: number } | undefined;
  for (const t of Object.values(root.pd.db.tasks))
    for (const o of t.occurrences) if (o.file === file && (!best || o.line < best.line)) best = { id: t.id, line: o.line };
  return best?.id;
}

export class Panels implements vscode.CustomReadonlyEditorProvider, vscode.WebviewPanelSerializer {
  /** Open tabs by `keyOf`, so opening a task again reveals its tab. */
  private tabs = new Map<string, Tab>();

  /** `gui`: the library's `dist/gui` folder, the webviews' only local resource root. `roots` resolves once loading is done. */
  constructor(private gui: vscode.Uri, private roots: () => Promise<Root[]>, private apply: Apply) {}

  /** The focused Plandown tab, if any. */
  active(): Tab | undefined { return [...this.tabs.values()].find(t => t.panel.active); }

  /** Reveals the task's tab or opens one. */
  openTask(root: Root, id: string): void { this.open(root, { kind: 'task', id }, root.pd.db.tasks[id]?.title ?? id); }

  /** Reveals or opens the root's graph or time tab. */
  openView(root: Root, kind: 'graph' | 'time'): void { this.open(root, { kind }, TITLES[kind]); }

  /** Tells every tab of `root` to refetch; retitles task tabs (tabs of vanished tasks stay, the GUI says so). */
  changed(root: Root): void {
    for (const t of this.tabs.values()) if (t.root === root) {
      if (t.view.kind === 'task' && root.pd.db.tasks[t.view.id]) t.panel.title = root.pd.db.tasks[t.view.id].title;
      t.panel.webview.postMessage({ t: 'changed' });
    }
  }

  /** Closes every tab of a root that is no longer loaded. */
  drop(root: Root): void { for (const t of [...this.tabs.values()]) if (t.root === root) t.panel.dispose(); }

  private open(root: Root, view: View, title: string) {
    const hit = this.tabs.get(keyOf(root, view));
    if (hit) return hit.panel.reveal();
    const panel = vscode.window.createWebviewPanel('plandown.view', title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.gui] });
    this.bind(panel, root, view);
  }

  /**
   * Wires a panel: html, message handler, `plandown.active` context key, and removal from `tabs` on dispose (only its
   * own entry: a file editor and a task tab may show the same task, the later one owns the key).
   */
  private bind(panel: vscode.WebviewPanel, root: Root, view: View): void {
    const tab: Tab = { panel, root, view, key: keyOf(root, view) };
    this.tabs.set(tab.key, tab);
    const focus = () => vscode.commands.executeCommand('setContext', 'plandown.active', [...this.tabs.values()].some(t => t.panel.active));
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.gui] };
    panel.webview.html = html(panel.webview, this.gui, root, view);
    panel.onDidChangeViewState(focus);
    panel.onDidDispose(() => { if (this.tabs.get(tab.key) === tab) this.tabs.delete(tab.key); focus(); });
    focus();

    panel.webview.onDidReceiveMessage(async (m: Msg) => {
      const db = () => root.pd.db, post = (r: object) => panel.webview.postMessage(r);
      if (m.t === 'state') return post({ rid: m.rid, db: db() });
      if (m.t === 'open') { if (db().tasks[m.id]) this.openTask(root, m.id); return; }
      // Only files of the database (no paths from the page are trusted)
      if (m.t === 'reveal') {
        if (db().files.includes(m.file)) vscode.window.showTextDocument(vscode.Uri.joinPath(root.uri, m.file), { selection: new vscode.Range(m.line, 0, m.line, 0) });
        return;
      }
      if (m.t !== 'op') return;
      let id: string | undefined, error: string | undefined;
      try { id = await this.apply(root, m.op); } catch (e) { error = (e as Error).message; }
      // A save that renamed this tab's task rekeys the tab; deleting it closes the tab
      const v = tab.view;
      if (!error && v.kind === 'task' && 'id' in m.op && m.op.id === v.id) {
        if (m.op.op === 'delete') return panel.dispose();
        if (m.op.op === 'update' && id && id !== v.id) {
          if (this.tabs.get(tab.key) === tab) this.tabs.delete(tab.key);
          tab.view = { kind: 'task', id };
          this.tabs.set(tab.key = keyOf(root, tab.view), tab);
          panel.title = db().tasks[id]?.title ?? id;
        }
      }
      post({ rid: m.rid, id, db: db(), error });
    });
  }

  // ---- Restoring tabs after a window reload ----

  /** Rebinds a tab from the GUI's saved state (`data-*` of its page); tabs of roots no longer loaded are closed. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: { view?: string; root?: string; task?: string } | undefined): Promise<void> {
    const root = (await this.roots()).find(r => r.uri.fsPath === state?.root);
    const view: View | undefined = state?.view === 'graph' || state?.view === 'time' ? { kind: state.view } : state?.view === 'task' && state.task ? { kind: 'task', id: state.task } : undefined;
    if (!root || !view || this.tabs.has(keyOf(root, view))) return panel.dispose();
    this.bind(panel, root, view);
  }

  // ---- Custom editor ----

  /** Plain document: the file's content lives in the database, not here. */
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument { return { uri, dispose() {} }; }

  /**
   * Binds the editor's panel as the task tab of the file's first task (so tree clicks reveal it). Files outside any
   * root, or without tasks, get a short message page instead.
   */
  async resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const at = rootOf(await this.roots(), doc.uri), id = at && firstTask(at.root, at.file);
    if (id) return this.bind(panel, at.root, { kind: 'task', id });
    panel.webview.html = note(at ? 'This file has no Plandown tasks.' : 'This file is not inside a Plandown database (a folder with plandown-format.md).');
  }
}
