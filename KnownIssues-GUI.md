# Known issues: GUI

## Outline traversal rebuilds the Subtask map per node

`walk` in `src/gui/app.ts` rebuilds its parent-to-children map from `db.edges` on every call. `outline` calls it once per tree node (through `taskEntries`), so building the sidebar or a group page costs O(nodes × edges) instead of O(nodes + edges). It is fast enough for small databases but grows quadratically with large ones. Fix: build the map once per render and pass it to `walk`.
