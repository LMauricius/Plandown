#!/bin/sh
# Builds plandown and installs the `plandown` command into the global npm prefix.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

npm install
npm run build
# Install from a packed tarball (a real copy limited to package.json "files"), not a symlink to this checkout.
npm pack --silent --pack-destination "$tmp" >/dev/null
npm install -g "$tmp"/plandown-*.tgz
