<h1><img src="media/logo.svg" alt="Plandown" height="96"></h1>

Plandown is a task manager whose database is a folder of plain Markdown files. Headings and bullets that start with `[<Task type>]` become tasks, YAML blocks hold their properties, and labeled lists link them together. A GUI edits tasks, shows the link graph and tracks effort and time, while the files stay readable and diff-friendly.

- [Database.md](Database.md) describes the file format.
- [Usage.md](Usage.md) describes the GUI.
- [vscode/README.md](vscode/README.md) describes the VSCode extension.

## Quick start

```sh
npm install
npm run build
node dist/cli.js serve examples/demo   # GUI at http://127.0.0.1:4848/
node dist/cli.js check examples/demo   # print diagnostics
npm test
```

## Using the library

Plandown is a standalone library; the GUI server is one front end for it.

```ts
import { Plandown } from 'plandown';

const plandown = await Plandown.open('path/to/folder');
console.log(plandown.db.tasks['[Task] Animation system']);

await plandown.apply({ op: 'update', id: '[Task] Animation system', props: { effort: 20 } });
await plandown.apply({ op: 'link', from: '[Task] Animation system', type: 'Blocked by', to: '[Task] Smart scene graph' });
await plandown.apply({ op: 'start', id: '[Task] Animation system' });

const stop = plandown.watch(() => console.log('folder changed'));
```

`plandown.db` is plain JSON: the format, all tasks, all links, time totals and diagnostics. Operations are `update`, `create`, `delete`, `link`, `unlink`, `start` and `stop`; each one validates its input, rewrites only the affected lines, and refuses to write if a file changed on disk since it was read.
