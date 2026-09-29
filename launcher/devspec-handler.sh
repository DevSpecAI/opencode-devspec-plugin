#!/bin/sh
# DevSpec protocol-handler launcher for Linux (devspec:// URLs).
#
# The Linux sibling of devspec-handler.cmd: the .desktop entry Execs THIS file
# so node discovery lives in one place instead of being baked into an Exec line.
#
# Why discovery is needed at all: a .desktop launch is spawned by the desktop
# session, not a login shell, so it inherits the *session* PATH. A version-manager
# node (nvm/fnm/volta/asdf) is only on an interactive shell's PATH and is invisible
# here — `Exec=node …` therefore fails on exactly the machines where `node` works
# fine in a terminal.
#
# Failures are logged rather than printed: an OS protocol launch has no visible
# stderr, so a silent exit is otherwise undiagnosable (the same reason
# open-handler.mjs logs every invocation).

set -u

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
HANDLER="$DIR/open-handler.mjs"
LOG="${HOME}/.cursor/devspec/handler.log"

log() {
  mkdir -p "$(dirname -- "$LOG")" 2>/dev/null || true
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"$LOG" 2>/dev/null || true
}

# First usable node wins. Any node that can run the handler is fine, so this
# deliberately does not try to rank versions.
find_node() {
  if [ -n "${DEVSPEC_NODE:-}" ] && [ -x "${DEVSPEC_NODE}" ]; then
    printf '%s' "${DEVSPEC_NODE}"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/tools/image/node/*/bin/node \
    "$HOME"/.asdf/installs/nodejs/*/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

URL="${1:-}"
if [ -z "$URL" ]; then
  log 'linux launcher: invoked with no URL (check the .desktop Exec line carries %u)'
  exit 2
fi

if [ ! -f "$HANDLER" ]; then
  log "linux launcher: handler missing at $HANDLER"
  exit 1
fi

NODE=$(find_node) || {
  log 'linux launcher: no usable node found — set DEVSPEC_NODE to an absolute node path'
  exit 1
}

exec "$NODE" "$HANDLER" --url "$URL"
