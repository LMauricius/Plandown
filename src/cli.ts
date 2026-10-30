#!/usr/bin/env node
/** `mado serve [dir] [port]` opens the GUI server; `mado check [dir]` prints diagnostics (exit 1 on errors). */
import { Mado } from './store.js';
import { serve } from './server.js';

const [cmd, dir = '.', port] = process.argv.slice(2);

if (cmd === 'serve') {
  const s = await serve(await Mado.open(dir), port ? Number(port) : undefined);
  console.log(`MaDo is serving ${dir} at ${s.url}`);
} else if (cmd === 'check') {
  const { db } = await Mado.open(dir);
  for (const d of db.diagnostics) console.log(`${d.file}:${d.line + 1}: ${d.severity}: ${d.message}`);
  console.log(`${Object.keys(db.tasks).length} tasks, ${db.edges.length} links, ${db.diagnostics.length} diagnostics`);
  process.exitCode = db.diagnostics.some(d => d.severity === 'error') ? 1 : 0;
} else {
  console.log('Usage: mado serve [dir] [port]\n       mado check [dir]');
  process.exitCode = cmd ? 1 : 0;
}
