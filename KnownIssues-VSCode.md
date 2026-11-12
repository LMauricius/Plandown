# Known issues: VSCode extension

## Crossed-out tree labels may switch font

Tree labels accept no styling, so done rows are crossed out with combining strokes (U+0336 after every character, `strike` in `vscode/src/tree.ts`). When the workbench UI font lacks U+0336, Chromium draws each letter together with its stroke in a fallback font that has both, so crossed-out labels look different from the others. No Unicode stroke avoids this for a font without one; only a webview-based tree (full CSS) or a future VSCode API for label styling would.

## Tree drops land only into rows

VSCode's tree drag-and-drop API reports the row under the pointer but not where on it, so the tree cannot offer the GUI's *before* and *after* drops. Once the tree is long enough to scroll, it also has no empty space left for drops to the top of a database. Group pages and the GUI cover both cases. Only a webview-based tree, or a future API for drop positions, would fix this.

## Drops into tabs need Shift

VSCode hands a drag coming from outside a webview (tree rows, Explorer files, other tabs) to the page only while Shift is held; otherwise the editor area takes it and opens the dragged file. Drags within one tab are unaffected.
