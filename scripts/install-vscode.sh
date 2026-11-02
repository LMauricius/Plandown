#!/bin/sh
# Builds the VSCode extension, packs it into a .vsix and installs it into VSCode.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Build the library, then the extension against a fresh copy of it (--install-links copies instead of linking).
npm install
npm run build
(cd vscode && npm install --install-links && npm run build)

# Stage the extension outside the repo; packing in vscode/ would pull in its src/ and dev files.
mkdir "$tmp/ext"
cp -r vscode/package.json vscode/README.md vscode/icon.png vscode/logo.png vscode/dist "$tmp/ext"
npm pack --silent --pack-destination "$tmp" >/dev/null
(cd "$tmp/ext" && npm install --omit=dev --no-package-lock "$tmp"/plandown-*.tgz \
  && npx --yes @vscode/vsce@3 package --skip-license -o "$tmp/plandown.vsix")

code --install-extension "$tmp/plandown.vsix" --force
