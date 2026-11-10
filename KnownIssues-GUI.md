# Known issues: GUI

## Outline traversal rebuilds the Subtask map per node

`walk` in `src/gui/app.ts` rebuilds its parent-to-children map from `db.edges` on every call. `outline` calls it once per tree node (through `taskEntries`), so building the sidebar or a group page costs O(nodes × edges) instead of O(nodes + edges). It is fast enough for small databases but grows quadratically with large ones. Fix: build the map once per render and pass it to `walk`.

## Soft-break continuation lines keep their leading whitespace

In a soft-break group (`.grp` in `src/gui/mdedit.ts`), each continuation line is painted with its source indentation, and the `::after` space of the previous line is added on top. Hard-wrapped list items such as `- text\n  more` therefore show visible gaps (`rejects   every`) where CommonMark renders a single space. Fix: paint a continuation line's leading whitespace as a marker (like the `↵` one) instead of text.

## Weight 600 renders regular with fonts lacking a semibold face

Fontconfig synthesizes bold only for requested weights of 700 and up, so on Linux a fallback font without a 600 face (common when `system-ui` maps to the desktop font, as in VSCode webviews) draws weight 600 as regular. `.k-strong` now uses 700; headings, `.task-title`, table headers and other 600 rules are still affected.
