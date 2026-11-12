/**
 * Link resolution: which task or tree node a dropped or pasted link names. Pure and dependency-free (types only), so the
 * GUI loads it in the browser and the VSCode extension through the library.
 */
import type { Db } from '../db.js';
import type { TreeNode } from '../tree.js';

/** What a link names: a task, or a tree node without a merged task (a node merged with its task names the task). */
export type Target = { id: string } | { path: string };

/** `/`-separated path without a trailing `/`: Windows paths and `/`-ended folder links compare like the database's paths. */
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** Node of `list` at `path` (the library's `findNode`, which a page cannot import). */
function nodeAt(list: TreeNode[], path: string): TreeNode | undefined {
  for (const n of list) {
    if (n.path === path) return n;
    if (path.startsWith(n.path + '/')) return nodeAt(n.kids, path);
  }
}

const ofNode = (n: TreeNode | undefined): Target | undefined => n && (n.task ? { id: n.task } : { path: n.path });

/** `%`-decoding that yields null for malformed escapes. */
const decode = (s: string) => { try { return decodeURIComponent(s); } catch { return null; } };

/**
 * Task or node `link` names, if any. `bases`: absolute folders, the database folder first, then folders that links may be
 * relative to (the workspace folder); absolute paths must lie in the database folder. Recognized forms, in this order:
 * - a VSCode page tab's virtual URI (`?id=` / `?node=`; a `root=` naming another database resolves to nothing)
 * - a page link `…/view/<anchor>` or `…/group/<path>` of any origin (server, webview), or relative (`view/<anchor>`)
 * - a file path, plain or as a `file:` / `vscode://file/` URI (a `:line[:col]` suffix ignored), optionally with `#<anchor>`:
 *   relative to the database folder or to another base, or absolute. With an anchor, the task of that anchor occurring
 *   in the file; else (and for a non-task anchor) the file's or folder's node.
 */
export function resolveLink(db: Db, link: string, bases: string[] = []): Target | undefined {
  const s = link.trim();
  if (!s) return;
  let u: URL | undefined;
  // A Windows drive path would parse as a URL of scheme `c:`
  if (!/^[a-z]:[\\/]/i.test(s)) try { u = new URL(s); } catch { /* relative */ }

  // VSCode page tab
  if (u) {
    const q = u.searchParams, id = q.get('id'), node = q.get('node'), root = q.get('root');
    if (id !== null || node !== null) {
      if (root !== null && bases.length && norm(root) !== norm(bases[0])) return;
      return id !== null ? db.tasks[id] && { id } : ofNode(nodeAt(db.tree, node!));
    }
  }

  // Page link; a miss falls through, since a file path may look alike (`view/x.md`)
  const route = (u ? u.pathname : s.replace(/[?#].*/, '')).replace(/^\//, '');
  const v = /^view\/([^/]+)$/.exec(route), g = /^group\/(.+)$/.exec(route);
  const a = v && decode(v[1]), t = a ? Object.values(db.tasks).find(t => t.anchor === a) : undefined;
  if (t) return { id: t.id };
  const gp = g && decode(g[1]), gn = gp ? ofNode(nodeAt(db.tree, gp)) : undefined;
  if (gn) return gn;

  // File path and anchor
  let p: string | null, hash: string;
  if (u?.protocol === 'file:' || (u?.protocol === 'vscode:' && u.hostname === 'file')) {
    p = decode(u.pathname);
    hash = u.hash;
    if (p && u.protocol === 'vscode:') p = p.replace(/:\d+(:\d+)?$/, '');
    if (p && /^\/[a-z]:\//i.test(p)) p = p.slice(1);   // `file:///C:/…`
  } else if (u) return;
  else { const i = s.indexOf('#'); p = i < 0 ? s : s.slice(0, i); hash = i < 0 ? '' : s.slice(i); }
  const anchor = decode(hash.slice(1));
  if (!p) return;
  p = norm(p).replace(/^(\.\/)+/, '');
  const abs = p.startsWith('/') || /^[a-z]:\//i.test(p), root = bases.length ? norm(bases[0]) + '/' : '';

  // Candidate database-relative paths: as given (relative), then through each base, kept if inside the database folder
  const full = abs ? [p] : bases.map(b => `${norm(b)}/${p}`);
  const cands = [...abs ? [] : [p], ...root ? full.filter(f => f.startsWith(root)).map(f => f.slice(root.length)) : []];
  for (const c of cands) {
    const n = nodeAt(db.tree, c.replace(/(\.plandown)?\.md$/, ''));
    if (!n || (n.file !== c && n.path !== c)) continue;
    const t = anchor ? Object.values(db.tasks).find(t => t.anchor === anchor && t.occurrences.some(o => o.file === c)) : undefined;
    return t ? { id: t.id } : ofNode(n);
  }
}
