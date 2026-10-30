/**
 * `Mado`: the folder-backed task database. Loads every `.md` file of a folder, applies operations
 * as surgical file edits and watches the folder. All loads and writes run one at a time.
 */
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseMarkdown, type ParsedFile } from './markdown.js';
import { FORMAT_FILE, parseFormat } from './format.js';
import { buildDb, type Db, type Occ } from './db.js';
import { applyEdits, plan, type Edit, type Op } from './edit.js';

const byName = new Intl.Collator(undefined, { numeric: true }).compare;

/** Missing file reads as null: a file may vanish between listing and reading, or be created by an edit. */
async function readOrNull(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}

export class Mado {
  db!: Db;
  private files = new Map<string, ParsedFile>();
  private occ = new Map<string, Occ[]>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(readonly dir: string) {}

  static async open(dir: string): Promise<Mado> {
    const m = new Mado(resolve(dir));
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
    const names = (await readdir(this.dir, { withFileTypes: true }))
      .filter(d => d.isFile() && d.name.endsWith('.md') && !d.name.startsWith('.')).map(d => d.name).sort(byName);
    const parsed = (await Promise.all(names.map(async f => {
      const text = await readOrNull(join(this.dir, f));
      return text === null ? null : parseMarkdown(f, text);
    }))).filter(p => p !== null);
    const fmt = parsed.find(p => p.file === FORMAT_FILE) ?? null, files = parsed.filter(p => p !== fmt);
    const { format, diagnostics } = parseFormat(fmt);
    const { db, occ } = buildDb(format, diagnostics, files);
    this.files = new Map(files.map(p => [p.file, p]));
    this.db = db;
    this.occ = occ;
  }

  /** Applies an operation; returns the id of the task to focus. Throws (without writing) on invalid input or files changed on disk. */
  apply(op: Op): Promise<string | undefined> {
    return this.run(async () => {
      const { edits, id } = plan({ db: this.db, occ: this.occ, files: this.files }, op);
      const byFile = new Map<string, Edit[]>();
      for (const e of edits) byFile.set(e.file, [...byFile.get(e.file) ?? [], e]);

      // Line numbers are only valid for the parsed text: refuse if any target changed since the last load
      for (const file of byFile.keys())
        if (await readOrNull(join(this.dir, file)) !== (this.files.get(file)?.text ?? null)) {
          await this.load();
          throw new Error(`${file} changed on disk; reloaded, please retry`);
        }

      // Atomic per file: write a temp file, then rename over the original
      for (const [file, list] of byFile) {
        const pf = this.files.get(file), lines = applyEdits(pf?.lines ?? [], list), path = join(this.dir, file);
        await writeFile(path + '.mado-tmp', lines.length ? lines.join(pf?.eol ?? '\n') + (pf?.eol ?? '\n') : '');
        await rename(path + '.mado-tmp', path);
      }
      await this.load();
      return id;
    });
  }

  /** Reloads on `.md` changes in the folder (debounced) and calls `onChange`. Returns the unsubscribe function. */
  watch(onChange: () => void): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const w = watch(this.dir, (_, name) => {
      if (name && !String(name).endsWith('.md')) return;
      clearTimeout(timer);
      timer = setTimeout(() => this.reload().then(onChange, e => console.error('mado: reload failed:', e)), 100);
    });
    return () => { clearTimeout(timer); w.close(); };
  }
}
