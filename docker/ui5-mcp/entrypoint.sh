#!/bin/sh
set -e
PORT="${PORT:-3210}"
PACKAGE="@ui5/mcp-server"
PKG_DIR="$(npm root -g)/${PACKAGE}"

if [ ! -d "$PKG_DIR" ]; then
  echo "Package $PACKAGE not found at $PKG_DIR" >&2
  exit 1
fi

# Resolve binary path from package.json bin/main field
BIN_REL=$(node -e "
const p = require('${PKG_DIR}/package.json');
const bins = p.bin || {};
const first = Object.values(bins)[0];
process.stdout.write(first || p.main || 'dist/index.js');
")

exec mcp-proxy --server stream --port "$PORT" -- node "${PKG_DIR}/${BIN_REL}"
