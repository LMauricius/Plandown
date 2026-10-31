# Known issues: `Example/` folder

Found by `node dist/cli.js check Example` (local notes, not for release).

## `Example/plandown-format.md`: reverse links not declared

| Line | Declaration | Problem |
|---|---|---|
| 14 | `[Task]` `Subtasks:` `- [Task] subtasks` | Reverse `subtasks` (lowercase) is not declared on `[Task]`. Also redundant: Subtask/Parent is built in. |
| 25 | `[Bug]` `Sub-bugs:` `- [Bug] during fixing a bug` | `[Bug]` has no `during fixing a bug:` list. Probably meant `Parent`-like semantics; built-in Subtask covers it. |
| 28 | `[Bug]` `Discovered during:` `- [Task] during a task` | `[Task]` has no `during a task:` list with `- [Bug] Discovered during`. |
| 29 | `[Bug]` `Discovered during:` `- [Bug] during fixing a bug` | `[Bug]` has no `during fixing a bug:` list. |
| 32 | `[Bug]` `Prevents fixing:` `- [Bug] during fixing a bug` | Reverse should likely be `Fixing blocked by`. |
| 36 | `[Bug]` `Fixing blocked by:` `- [Bug] Prevents fixing` | Needs `Prevents fixing:` to contain `- [Bug] Fixing blocked by` (follows from line 32). |

Fix sketch: add `Revealed:` (`- [Bug] Discovered during`) to both types, use it as reverse of `Discovered during`; change line 32 entry to `- [Bug] Fixing blocked by`; drop `Subtasks:`/`Sub-bugs:` (built in). `examples/demo/plandown-format.md` is a valid version.

## `Example/29.9.2025..md`: no tasks

No heading or bullet starts with `[<Type>]`, so it loads 0 tasks. Pandoc attributes (`{-}`, `{h}`) would become part of titles if those lines were turned into tasks.
