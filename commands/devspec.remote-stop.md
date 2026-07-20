---
description: Disconnect DevSpec remote control for this OpenCode session — connection offline, leave other remotes alone.
---

# DevSpec Remote Control — Stop

Detach and mark this OpenCode connection offline immediately, rather than waiting for it to time out.

## Steps

1. Call the DevSpec MCP tool `detach_connection` with this session's `connection_id`.
2. Confirm: `✓ DevSpec remote control disconnected — connection offline.`
3. This only affects THIS connection — other OpenCode/Claude Code/Cursor connections on the same project are untouched.
