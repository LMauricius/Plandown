/**
 * `Plandown`: the folder-backed task database. Loads every `.md` file of a folder and its subfolders, applies operations
 * as surgical file edits and watches the folder. All loads and writes run one at a time.
 */
import { access, mkdir, readdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseMarkdown, type ParsedFile } from './markdown.js';
import { FORMAT_FILE, parseFormat } from './format.js';
import { buildDb, type Db, type Occ } from './db.js';
import { applyEdits, plan, type Edit, type Op } from './edit.js';

const byName = new Intl.Collator(undefined, { numeric: true }).compare;
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** Missing file reads as null: a file may vanish between listing and reading, or be created by an edit. */
async function readOrNull(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (e) { if (code(e) === 'ENOENT') return null; throw e; }
}

/** Existence check before renames and new folders, which must never replace anything that appeared on disk. */
const exists = (path: string) => access(path).then(() => true, e => { if (code(e) === 'ENOENT') return false; throw e; });

/**
 * Task files and folders below `root`, as `/`-separated relative paths. Hidden entries are never entered (`.git` can be
 * huge and the folder reloads on every change); symlinks are not followed (no loops, nothing outside the folder).
 * Only the root's `plandown-format.md` is read: nested ones are reserved for sub-formats.
 */
async function list(root: string, rel = '', out = { files: [] as string[], folders: [] as string[] }) {
  let entries;
  try { entries = await readdir(join(root, rel), { withFileTypes: true }); }
  catch (e) { if (rel && code(e) === 'ENOENT') return out; throw e; }   // a subfolder vanished meanwhile
  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    const p = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) { out.folders.push(p); await list(root, p, out); }
    else if (d.isFile() && d.name.endsWith('.md') && (d.name !== FORMAT_FILE || !rel)) out.files.push(p);
  }
  return out;
}

export class Plandown {
  db!: Db;
  private files = new Map<string, ParsedFile>();
  private occ = new Map<string, Occ[]>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly dir: string) {}

  static async open(dir: string): Promise<Plandown> {
    const m = new Plandown(resolve(dir));
    await m.reload();
    return m;
  }

  /** Serializes loads and writes so an operation never plans against a half-loaded state. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }

  reload(): Promise<void> { return this.run(() => this.load()); }

  private async load() {
    const { files: names, folders } = await list(this.dir);
    names.sort(byName);
    const parsed = (await Promise.all(names.map(async f => {
      const text = await readOrNull(join(this.dir, f));
      return text === null ? null : parseMarkdown(f, text);
    }))).filter(p => p !== null);
    const fmt = parsed.find(p => p.file === FORMAT_FILE) ?? null, files = parsed.filter(p => p !== fmt);
    const { format, diagnostics } = parseFormat(fmt);
    const { db, occ } = buildDb(format, diagnostics, files, folders.sort(byName));
    this.files = new Map(files.map(p => [p.file, p]));
    this.db = db;
    this.occ = occ;
  }

  /** Applies an operation; returns the id of the task to focus. Throws (without writing) on invalid input or files changed on disk. */
  apply(op: Op): Promise<string | undefined> {
    return this.run(async () => {
      const { edits, id, mkdir: dir, rmdir: gone, moves = [] } = plan({ db: this.db, occ: this.occ, files: this.files }, op);
      const byFile = new Map<string, Edit[]>();
      for (const e of edits) byFile.set(e.file, [...byFile.get(e.file) ?? [], e]);

      // Line numbers are only valid for the parsed text: refuse if any target changed since the last load
      for (const file of byFile.keys())
        if (await readOrNull(join(this.dir, file)) !== (this.files.get(file)?.text ?? null)) {
          await this.load();
          throw new Error(`${file} changed on disk; reloaded, please retry`);
        }
      for (const p of [...moves.map(m => m.to), ...dir ? [dir] : []])
        if (await exists(join(this.dir, p))) {
          await this.load();
          throw new Error(`${p} already exists on disk; reloaded`);
        }
      if (dir) await mkdir(join(this.dir, dir));

      // Atomic per file: write a temp file, then rename over the original
      for (const [file, list] of byFile) {
        const pf = this.files.get(file), lines = applyEdits(pf?.lines ?? [], list), path = join(this.dir, file);
        await writeFile(path + '.plandown-tmp', lines.length ? lines.join(pf?.eol ?? '\n') + (pf?.eol ?? '\n') : '');
        await rename(path + '.plandown-tmp', path);
      }
      for (const m of moves) await rename(join(this.dir, m.from), join(this.dir, m.to));
      // A folder replaced by a same-named file is removed only if nothing (e.g. an image) is left in it
      if (gone) await rmdir(join(this.dir, gone)).catch(e => { if (code(e) !== 'ENOTEMPTY' && code(e) !== 'ENOENT') throw e; });
      await this.load();
      return id;
    });
  }

  /** Reloads on changes anywhere in the folder except hidden paths and temp files (debounced), then calls `onChange`. Returns the unsubscribe function. */
  watch(onChange: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const w = watch(this.dir, { recursive: true }, (_, name) => {
      if (name && (/(^|[\\/])\./.test(String(name)) || String(name).endsWith('.plandown-tmp'))) return;
      clearTimeout(timer);
      timer = setTimeout(() => this.reload().then(onChange, e => console.error('plandown: reload failed:', e)), 100);
    });
    return () => { clearTimeout(timer); w.close(); };
  }
}
