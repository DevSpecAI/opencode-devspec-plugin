#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'DevSpec Launcher needs Node.js 20 or newer. Copy commands remain available.' >&2
  exit 1
fi
exec node "$DIR/launcher.mjs" install
