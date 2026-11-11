---
name: plandown-format
description: Read and interpret a Plandown `plandown-format.md` file (task types, property schemas, link types and their reverses) and derive what it allows in task files. Use before writing or editing tasks in a Plandown folder (any folder whose root holds `plandown-format.md`), when asked which types, properties or links are valid, or when changing the format file itself.
---

# Understanding `plandown-format.md`

A Plandown folder is a task database made of plain Markdown files. The file `plandown-format.md` at the **root** of the folder is its schema. A file with that name in a subfolder is ignored and treated as nothing special.

Always read the format file before writing tasks. Nothing outside it is allowed, apart from the built-ins listed below.

## Structure

The format file uses the same Markdown shape as task files, with a different meaning.

```markdown
# [Task] A unit of planned work
    $meta:
      color: '#2f6fbf'
    Due-date: date
    Priority:
      type: number
      enum: [1, 2, 3]
      description: 1 is the most urgent

Blocks:
- [Task] Blocked by
- [Bug] Blocked by

Related:
- [Task] Related
```

| Element | Meaning |
|---|---|
| `# [<Type>] <text>` heading | Declares task type `<Type>`. The text after it is only a description. |
| Property block (indented by four spaces, right below the heading) | The type's property schema. |
| `<Link>:` line directly above a list | Declares link type `<Link>` for tasks of this type. |
| List entry `- [<Target>] <Reverse>` | Tasks of this type may link via `<Link>` to tasks of type `<Target>`; the target sees the link as `<Reverse>`. |

Names are case sensitive and compared exactly (`Blocked by` is not `Blocked By`).

## Property schemas

Each property is either `Name: <type>` or a mapping:

| Key | Meaning |
|---|---|
| `type` | Required. One of `string`, `number`, `boolean`, `date` (`YYYY-MM-DD`), `datetime` (ISO 8601). |
| `enum` | List of allowed values. |
| `description` | Help text (tooltip in the GUI). |

Every type also has these **built-in** properties, which must not be redeclared:

| Property | Type | Meaning |
|---|---|---|
| `done` | boolean | The task is finished. |
| `effort` | number | Estimated effort in hours. |
| `spent` | number | Hours spent. |
| `started` | datetime | Start of the running timer. Managed by the GUI; do not write it by hand. |

The reserved key `$meta` holds type settings, not a property. Its only key is `color` (any CSS color string; quote hex values so YAML does not read them as comments).

## Link types

The link pair `Subtask` / `Parent` is built in, connects any two types, and must not be declared.

Every other link has two names, one per direction. The entry `[B] R` under `L:` of type **A** names both. Type **B** may omit the reverse (a *one-directional* link: only A-side tasks can write it; B-side tasks just see it as incoming `R`). If B declares it, the two must agree:

> If type **A** declares `L:` with entry `[B] R`, and type **B** declares `R:` with an entry for `[A]`, that entry must be `[A] L`.

A **reflexive** entry (same type and same name: `Related:` → `- [Task] Related` under `[Task]`) is always two-directional.

A link written in a task file is valid only when:

1. the source task's type declares that link name, and
2. that link's list contains the target task's type.

So `[Bug] X` → `Blocked by` → `[Task] Y` requires `Blocked by:` with `- [Task] ...` under `# [Bug]`.

## Deriving the allowed vocabulary

Before editing tasks, build this table from the format file (mentally or in your notes):

- **Types:** every `# [<Type>]` heading.
- **Properties per type:** declared ones plus `done`, `effort`, `spent`, `started`; their types and enums.
- **Links per type:** for each declared `<Link>:`, the target types allowed. Plus `Subtask` and `Parent` to anything.

If a needed type, property or link is missing, **do not invent it in a task file**. Tell the user, and offer to add it to the format file (only if they agree).

## Changing the format file

When adding or editing declarations:

- One `# [<Type>]` heading per type; never declare a type twice.
- Every list needs a `<Link>:` label line directly above it (no blank line between). Unlabeled lists are errors here.
- For every non-reflexive entry you add, decide whether the target type should create the link too; if so, add the matching reverse declaration in the same change. When removing an entry, remove its reverse too.
- Do not list the same target type twice under one link.
- Renaming a type, property or link in the format file does **not** rename uses in task files. Update the task files as well, or warn the user.

## Validation

Problems never block loading; they become diagnostics. Format file errors include: duplicate types, invalid property schemas, redeclared built-ins, unlabeled lists, unknown target types, and contradicting reverse declarations.

If the `plandown` CLI is available, run `plandown check <folder>` after any change. It prints `file:line` diagnostics and exits non-zero on errors. Without it, re-check the reverse rule by hand for every entry you touched.
