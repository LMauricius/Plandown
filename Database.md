# The MaDo database

MaDo keeps all of its data in a folder of plain Markdown files. There is no hidden index and no cache: the files *are* the database. You can edit them in any text editor, keep them in version control, and MaDo picks up the changes immediately.

This document explains how MaDo reads that folder: which lines become tasks, how properties and links are written, and how the special `mado-format.md` file defines what is allowed.

## The folder

Every `.md` file inside the folder and its subfolders is read. Hidden files and folders (names starting with `.`) are skipped, and symbolic links are not followed. One file has a special role:

- **`mado-format.md`** at the top of the folder declares the task types, their properties and the link types between them. A file with that name inside a subfolder is ignored.
- **Every other `.md` file** holds tasks. Files are read in natural name order (`2.md` before `10.md`), and together they form one database. Subfolders only organize the files; a task's identity does not depend on where it is stored.

```mermaid
flowchart LR
  F[mado-format.md] -->|types, properties, link types| DB[(Task database)]
  A[roadmap.md] -->|tasks| DB
  B[2026-11.md] -->|tasks| DB
  DB --> G[GUI and API]
  G -->|surgical line edits| A
  G -->|surgical line edits| B
```

## Tasks

Every heading or bullet point whose text starts with `[<Task type>]` is a task. The rest of the line is the task's title.

```markdown
# [Task] Game-ready 3D engine
- [Bug] Shadow acne on EAA shadows
1. [Task] Numbered items work too
- [x] [Task] A checkbox in front of the type is allowed
```

Lines that do not start with a task type are ordinary Markdown and are left alone. A checkbox on its own (`- [x] Buy milk`) is not a task, and neither is a link (`- [docs](https://example.com)`) or anything inside a fenced code block.

### Identity and interwoven files

A task is identified by its type and title together: `[Task] Animation system`. Wherever that combination appears, in any file, it is the same task. This is how files interweave. A dated notes file can mention a task defined in the roadmap and add subtasks or links to it:

```markdown
# Notes for November

## [Task] Animation system
- [Task] Implementation of common methods as examples
```

Because of this, titles must be unique within a task type. Two different tasks named `[Task] Cleanup` would be merged into one.

Each place a task appears is called an *occurrence*. The first occurrence that has properties or a description is the task's **home**; that is where its properties and description are read from and where the GUI writes them back. The other occurrences only contribute links. If properties are written in more than one occurrence, MaDo uses the home's and reports a warning for the others.

### Top-level tasks

Tasks that are not nested under another task are top-level tasks. Usually these are the main (`#`) headings of each file. A task heading below a non-task heading (such as `# Notes for November` above) is top-level as well, unless a task heading encloses it.

## Properties

Right after a task's title line, a YAML block between two `---` lines holds its properties:

```markdown
## [Task] Animation system
---
Due-date: 2026-12-01
Priority: 1
effort: 16
spent: 3.5
---
Skeletal, mesh-morphing and dynamic animation in one modular system.
```

For a bullet task, indent the block to the bullet's text:

```markdown
- [Task] Stabilize the SQueLe core API
  ---
  effort: 6
  done: true
  ---
```

The block must start on the line directly below the title. A missing closing `---` is reported as an error (the search stops at the next task heading, so an unclosed block never swallows other tasks). YAML comments are allowed and are preserved when the GUI edits the block.

Which properties a task may have is declared by its type in `mado-format.md`. In addition, every type has these built-in properties:

| Property | Type | Meaning |
|---|---|---|
| `done` | boolean | The task is finished. |
| `effort` | number | Estimated effort in hours. |
| `spent` | number | Time spent in hours. |
| `started` | datetime | Start of the running timer. Managed by the timer; stopping it adds the elapsed time to `spent`. |

Undeclared properties are kept but reported as warnings; values of the wrong type are reported as errors.

## Description

The description is the text after the title (and its property block). For a heading task, it runs up to the next task heading or the next heading of the same or a higher level, so ordinary sub-headings such as `### Notes` are sub-chapters of the description. For a bullet task, it is the indented text below the bullet.

Lists that contain tasks are not part of the description text; they declare subtasks and links, as described below. The description may continue after them, and the GUI shows each list's links at the place where the list stands.

## Subtasks and links

Tasks are connected by *links*. Every link has a type, and every link type has a reverse: if task A `Blocks` task B, then B is `Blocked by` A. The pair Subtask and Parent is built in.

### Subtasks

There are two ways to make a subtask:

1. **Sub-headings.** A task heading nested under another task heading is its subtask, even with ordinary headings in between.
2. **Unlabeled lists.** A list of task bullets that has no text directly above it (a blank line, the title, or the property block is fine) contains subtasks of the task it belongs to.

```markdown
# [Task] Game-ready 3D engine

## [Task] Animation system

- [Task] High-level design of animation system
- [Task] Programming interface for the system
```

Here `Animation system` is a subtask of `Game-ready 3D engine`, and both bullets are subtasks of `Animation system`. Each subtask in turn has its parent linked as `Parent`. A list labeled `Parent:` declares parents explicitly.

Bullet tasks can have their own nested lists, so subtasks can be nested as deep as you like.

### Other link types

To use any other link type, put a line of the form `<Link type>:` directly above the list:

```markdown
## [Task] Animation system

Blocked by:
- [Task] Smart scene graph
```

The entries are ordinary task occurrences. If `[Task] Smart scene graph` is defined elsewhere, this is a reference to it; if not, this line defines it.

A blank line ends a list. Keep the items of one list together, and start a new list (with its own label, or none for subtasks) after a blank line.

The same relation only needs to be written once. Writing `Blocked by: [Task] Smart scene graph` under Animation system is equivalent to writing `Blocks: [Task] Animation system` under Smart scene graph; if both are written, MaDo counts the link once.

## The format file

`mado-format.md` uses the same Markdown structure as task files, with a different meaning:

- Each `# [<Task type>] <description>` heading **declares a task type**. The text after the type is a short description of it.
- The property block **declares the type's property schema**.
- Each labeled list **declares a link type** that tasks of this type can use. Every entry `[<Target type>] <Reverse link>` allows linking to tasks of the target type and names the link type that the target sees in the opposite direction.

```markdown
# [Task] A unit of planned work
---
Due-date: date
Priority:
  type: number
  enum: [1, 2, 3]
---

Blocks:
- [Task] Blocked by
- [Bug] Blocked by

Blocked by:
- [Task] Blocks
- [Bug] Blocks

Related:
- [Task] Related
- [Bug] Related
```

### Property schemas

Each property is declared either by its type name alone (`Due-date: date`) or as a mapping with these keys:

| Key | Meaning |
|---|---|
| `type` | One of `string`, `number`, `boolean`, `date` (`YYYY-MM-DD`) or `datetime` (ISO 8601). Required. |
| `enum` | A list of allowed values. The GUI shows them as a drop-down. |
| `description` | Help text shown as a tooltip in the GUI. |

The built-in properties (`done`, `effort`, `spent`, `started`) cannot be redeclared.

### Link types and their reverses

Every link has two names, one for each direction. The format file states both, and the two declarations must agree:

> When type **A** declares link **L** with the entry `[B] R`, then type **B** must declare link **R** with the entry `[A] L`.

The only exception is a **reflexive** entry: an entry pointing to its own type with the same link name, such as `Related:` with `- [Task] Related` under `[Task]`. A reflexive link reads the same in both directions, so no second declaration is needed.

The diagram below shows the links declared by the example above, together with the `[Bug]` type from the demo folder. Each arrow is one declaration; the label is the link type and its reverse.

```mermaid
flowchart LR
  Task -->|"Blocks / Blocked by"| Task
  Task -->|"Blocks / Blocked by"| Bug
  Bug -->|"Blocks / Blocked by"| Task
  Bug -->|"Blocks / Blocked by"| Bug
  Task -->|"Related (reflexive)"| Task
  Task <-->|"Related"| Bug
  Bug -->|"Discovered during / Revealed"| Task
```

`Subtask` and `Parent` are built in, connect any two types, and cannot be redeclared.

## Validation

MaDo never refuses to load a folder. Instead it reports diagnostics (with file and line) for anything that does not match the format:

- In `mado-format.md`: duplicate types, invalid property schemas, unlabeled lists, unknown target types, and missing or mismatched reverse declarations.
- In task files: unknown task types, link types the task's type does not declare, links to types the link type does not allow, tasks linking to themselves, invalid YAML, unclosed property blocks, undeclared properties and values that do not match their schema.

Run `mado check <folder>` to print them; it exits with a non-zero status when there are errors, so it can guard a commit hook or a CI job.

## How edits are written

When a task is changed through the GUI or the library, MaDo rewrites only the lines involved: a title line, a property block, a description, or a single list item. Everything else in the file, including your formatting and comments, stays byte for byte the same. Before writing, MaDo checks that the file has not changed on disk since it was last read; if it has, the edit is refused and the folder is reloaded, so nothing written by someone else is overwritten.

Some changes are made where they are declared:

- **Renaming** a task (or changing its type) rewrites its title in every occurrence, in every file.
- **Adding a link** appends an entry to the matching list of the task's home occurrence, creating the `<Link type>:` list if needed.
- **Removing a link** deletes the list entry that declares it. An entry that also defines the task's content (properties, description or nested lists) is not removed; links that come from heading nesting are changed by moving the heading.
- **Deleting a task** removes every occurrence, including everything nested inside it.
