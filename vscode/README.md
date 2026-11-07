<h1><img src="logo.png" alt="Plandown" height="96"><br>for VSCode</h1>

This extension brings the Plandown task manager into VSCode. It runs the same library and the same task editor as the standalone GUI described in [Usage.md](../Usage.md), so tasks behave exactly alike in both; only the surroundings change.

## Setup

Build the library first, then the extension:

```sh
npm install && npm run build                  # in the repository root
cd vscode && npm install && npm run build
code --extensionDevelopmentPath="$PWD" ../examples/demo
```

The extension is not published on the Marketplace yet, so it runs as a development extension.

## Finding databases

Every folder holding a `plandown-format.md` is a database. The extension searches each workspace folder down to the depth set by **`plandown.searchDepth`** (3 by default; 0 checks the workspace folder only). Hidden folders, `node_modules` and anything excluded by `files.exclude` are skipped. A database inside another database is ignored, because its folder already belongs to the outer one.

Changing the setting or the workspace folders triggers a new search. A `plandown-format.md` created later is picked up by **Plandown: Rescan Workspace** (the refresh button of the tree).

## The Plandown panel

The checklist icon in the activity bar opens the task tree. It holds what the GUI's navigation sidebar holds: folders, files, top-level tasks and their subtasks, merged the same way. With several databases, each one is a top-level entry.

- Click a task to open it in a preview tab. Double-click it, or choose **Open in New Tab** from its context menu, to open a regular tab.
- Click a folder or a file to open its page in the same way: the outline of everything inside it, as described in [Usage.md](../Usage.md#group-pages). Inside a page, clicking a nested folder or file opens its own page.
- Clicking a row also expands it.
- Tick the checkbox to mark a task done; subtasks keep their own state.
- Drag a task, file or folder onto another row to move it there, as described in [Usage.md](../Usage.md#moving-tasks-files-and-folders). The tree only drops *into* rows; to place a task before or after another one, use the GUI.
- Each row shows the task type and, when set, `spent/effort` hours including subtasks.
- **New Task** and **New Group** (in the panel title, or on a row) create next to the selected row, or at the top of the database when nothing is selected.
- **Filter Tasks** lists every task whose title or description contains the text. **Clear Filter** restores the tree.

## Task tabs

Each task opens in a tab of its own, showing the GUI's editor without its header and navigation sidebar. Opening the same task again brings its tab forward. Clicking a task in the tree, or a link to another task (in the link lists, the graph or the timeline), opens it as a preview tab, just like single-clicking a file in the Explorer: the next task opened replaces it. Double-click the tab title, or save a change in the task, to keep the tab open. Middle-click a link to open the task in a regular tab right away. A tab follows its task when you rename it and closes when you delete it.

**Alt+Left** and **Alt+Right** (**Cmd+[** and **Cmd+]** on macOS) go back and forward through the tabs you visited, preview tabs included, while a Plandown tab is focused. They run VSCode's own **Go Back** and **Go Forward**, so the history is shared with text editors.

The **Stored in** entries open the Markdown file at that line in a text editor.

Tabs are restored when the window reloads.

## Plandown files

Files that belong to a database count as their own file type, **Plandown**: they get the Plandown icon in the Explorer and open in Plandown by default, which shows the same page as clicking the file in the **Tasks** view: its task when the file is merged with one, otherwise the list of its tasks. A file without tasks (for example a new, empty one) opens in the text editor instead. To edit any file as text, use **Reopen Editor With... → Text Editor**.

Two kinds of files are recognized:

- **By name, everywhere:** files ending in `.plandown.md`, and every `plandown-format.md`.
- **By location:** every `.md` file inside a database found in the workspace. VSCode can only match files by name patterns, so the extension writes one pattern per database to the workspace settings (`files.associations` and `workbench.editorAssociations`). It keeps these entries up to date as databases appear and disappear, and leaves other entries alone.

`plandown-format.md` always opens in the text editor. Because Plandown files have their own file type, the features of the `markdown` type (the built-in Markdown preview, the outline and other Markdown extensions) do not apply to them; syntax highlighting still does.

Any other Markdown file can be opened with Plandown too: right-click it and choose **Open With... → Plandown (any Markdown file)**.

## Running timers

Every running timer of every database appears in the status bar with its task title and elapsed time. Click it to open the task.

## Commands

| Command | Does |
|---|---|
| Plandown: New Task | Asks for a type and a title, creates the task and opens it |
| Plandown: New Group | Asks for a name and creates a group (a folder) |
| Plandown: Show Graph | Opens the link graph of the database |
| Plandown: Show Timeline | Opens the time table of the database |
| Plandown: Filter Tasks / Clear Filter | Filters the task tree |
| Plandown: Open in Browser | Opens the database in the standalone GUI, in the default browser |
| Plandown: Rescan Workspace | Searches the workspace for databases again |

**Show Graph**, **Show Timeline** and **New Task** also appear as buttons to the right of the tabs whenever a Plandown tab is focused. When a command needs a database, it uses the selected tree row, then the focused Plandown tab, and asks only when there are several candidates.

## Diagnostics

Errors and warnings of every database (unknown types, disallowed links, bad YAML and so on) are listed in the **Problems** view and underline the affected lines.

## Notes

- Plandown reads files from disk. Edits in a text editor are seen once they are saved; if a Plandown save hits a file changed on disk, it is refused and can simply be repeated.
- Task tabs keep their state while hidden, so unsaved edits survive switching tabs. Each open tab costs some memory.
- Pages follow the VSCode color theme.
