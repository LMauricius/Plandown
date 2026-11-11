---
name: plandown-tasks
description: Write and edit tasks in Plandown Markdown files (`[Type] Title` headings and bullets, YAML property blocks, subtask lists, labeled link lists) so they stay valid against `plandown-format.md`. Use whenever creating, editing, moving, linking or deleting tasks in any `.md` file of a folder whose root holds `plandown-format.md`.
---

# Writing Plandown task files

A Plandown folder is a task database: every `.md` file under it (except hidden ones and the root `plandown-format.md`) holds tasks, and all files together form one database. The files are the only source of truth; there is no index to update.

**First, read `plandown-format.md`** (see the `plandown-format` skill). Use only the task types, properties and link types it declares, plus the built-ins (`done`, `effort`, `spent`, `started`; `Subtask` / `Parent`).

## Tasks and identity

A heading or bullet whose text starts with `[<Type>]` is a task; the rest of the line is its title.

```markdown
# [Task] Pantry 1.0
- [Bug] Imported recipes lose their photos
1. [Task] Numbered items work too
- [x] [Task] A checkbox before the type is allowed
```

- **Identity is `[Type] Title`.** The same pair anywhere in the folder is the same task. Titles must be unique per type; two different tasks with the same type and title get merged. Before creating a task, search the folder for the exact `[Type] Title` to avoid accidental merges or duplicates.
- Spelling matters exactly (case, spaces, punctuation). A typo creates a new, separate task.
- A checkbox is decoration only. Completion is the `done` property.
- Not tasks: `- [x] Buy milk`, `- [docs](https://...)`, anything in fenced code.

## Home occurrence

Each place a task appears is an *occurrence*. The first one (in natural file order, then line order) that has properties or a description is its **home**. Properties and description live **only there**. Other occurrences are bare references that may add links.

- To change a task's properties or description, find and edit its home.
- Never add a property block to a second occurrence (it is ignored and warned about).
- To mention an existing task elsewhere, write just its `[Type] Title` line.

## Properties

A fenced `yaml` block directly under the title line (no blank line between):

````markdown
## [Task] Offline mode
```yaml
Due-date: 2026-12-01
Priority: 1
effort: 16
```
Description text starts here.
````

For a bullet task, indent the block to the bullet's text column:

````markdown
- [Task] Choose an auth provider
  ```yaml
  effort: 6
  done: true
  ```
````

Rules:

- Always close the fence. Write new blocks as ```` ```yaml ````; `~~~` and `yml` are accepted too.
- Blocks delimited by `---` lines are the old style: convert them to a `yaml` fence when you edit them.
- Use only properties declared for the task's type (plus built-ins), with values of the declared type: `date` as `YYYY-MM-DD`, `datetime` as ISO 8601, `number` unquoted, `boolean` as `true`/`false`, `enum` values exactly as listed.
- Do not write or edit `started` by hand (the timer manages it).
- Omit the block entirely when there are no properties.
- Keep existing YAML comments and key order.

## Description

Free text after the title (and property block).

- Heading task: runs until the next task heading or the next heading of the same or higher level. Ordinary sub-headings (`### Notes`) stay part of the description.
- Bullet task: the indented text below the bullet.
- Lists of task bullets inside it are not description; they are subtasks or links.

## Subtasks

Two ways, both equivalent:

1. **Sub-heading:** a task heading nested under a task heading (ordinary headings in between are fine).
2. **Unlabeled list:** a list of task bullets with no text line directly above it (blank line, title or property block above is fine).

```markdown
# [Task] Pantry 1.0

## [Task] Offline mode

- [Task] Design the sync protocol
- [Task] Local recipe cache
  - [Task] Nested subtasks work too
```

A list labeled `Parent:` declares parents explicitly. Never write `Subtask:` as a label; use an unlabeled list.

**Add subtasks by editing the parent**, not by writing a `Parent:` list in the child. When a child lives in its own file, append an unlabeled list of bare `[Type] Title` references to the parent (e.g. under a `## Tasks` sub-heading), in work order. This keeps the hierarchy readable from the parent. Use `Parent:` only when the user asks for it.

## Links

Put a `<Link type>:` line **directly above** the list (no blank line):

```markdown
## [Task] Offline mode

Blocked by:
- [Task] Account system
- [Bug] Imported recipes lose their photos
```

- The link name must be declared by the **source** task's type, and must allow the **target**'s type. Check the format file each time.
- An entry is a normal occurrence: if the target exists elsewhere this references it; if not, this line **defines** it. Verify exact titles so you reference rather than create.
- Write each relation once. `Blocked by: [Task] B` under A equals `Blocks: [Task] A` under B; do not write both.
- A task must not link to itself.
- A blank line ends a list. Keep one list's items contiguous; start a new labeled list after a blank line.
- A labeled list outside any task is warned about; keep lists under their task.

## Editing safely

Make surgical edits; leave all unrelated lines byte for byte unchanged.

| Action | How |
|---|---|
| Rename / retype | Change the `[Type] Title` line in **every** occurrence across all files. Check that the new identity does not already exist. If the type changes, check its properties and links are valid for the new type. |
| Edit properties / description | Edit the home occurrence only. |
| Add link | Append to the matching labeled list in the home occurrence; create the `<Link>:` list if missing. |
| Remove link | Delete the list entry declaring it (it may be on either side, under either name). Do not delete an entry that carries the task's properties, description or nested lists; move that content first. |
| Change parent | Move the heading/bullet, or edit the `Parent:` / subtask list entry. |
| Delete task | Remove every occurrence, including what is nested inside each. Ask before deleting nested tasks. |
| Mark done | Set `done: true` in the home's property block (create the block if missing). |

## Checklist before finishing

1. Every type, property, value and link is allowed by `plandown-format.md`.
2. No accidental new tasks from misspelled titles; no accidental merges from reused titles.
3. Properties exist only at the home occurrence; every block is closed.
4. Every link list has its label directly above and no blank lines inside.
5. If the `plandown` CLI is available, run `plandown check <folder>`; fix every error it reports for lines you touched (`file:line` diagnostics, non-zero exit on errors).
