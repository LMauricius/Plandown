# Known issues: VSCode extension

## Crossed-out tree labels may switch font

Tree labels accept no styling, so done rows are crossed out with combining strokes (U+0336 after every character, `strike` in `vscode/src/tree.ts`). When the workbench UI font lacks U+0336, Chromium draws each letter together with its stroke in a fallback font that has both, so crossed-out labels look different from the others. No Unicode stroke avoids this for a font without one; only a webview-based tree (full CSS) or a future VSCode API for label styling would.
