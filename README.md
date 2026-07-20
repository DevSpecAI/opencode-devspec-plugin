# opencode-devspec-plugin

DevSpec integration for [OpenCode](https://opencode.ai) — connects OpenCode to your DevSpec project over MCP, teaches it DevSpec's conventions (briefs, action items, memory), and ports the same `devspec.*` commands and remote-control support that already ship for Claude Code and Cursor.

OpenCode has no plugin marketplace yet, so setup is two manual steps: install the package, then paste two blocks into your `opencode.json`.

## 1. Install

```bash
npm install --save-dev opencode-devspec-plugin
```

## 2. Configure `opencode.json`

Add an `mcp` entry pointing at your DevSpec project's MCP endpoint, and a `plugin` entry loading this package:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "devspec": {
      "type": "remote",
      "url": "https://<your-devspec-host>/api/mcp",
      "headers": {
        "Authorization": "Bearer <your-devspec-token>"
      }
    }
  },
  "plugin": ["opencode-devspec-plugin"],
  "instructions": ["node_modules/opencode-devspec-plugin/instructions/devspec.md"]
}
```

Replace `<your-devspec-host>` and `<your-devspec-token>` with the values from your DevSpec project's connection settings.

## 3. Verify

Start OpenCode in a DevSpec-tracked repo and ask it to list your DevSpec action items — if the MCP connection is wired correctly, it will call straight through.

## What this package provides

- **MCP wiring guidance** — the config block above; DevSpec's MCP server itself needs no changes.
- **Conventions file** (`instructions/devspec.md`) — DevSpec's workflow rules (claim before coding, briefs/action items, memory usage), auto-loaded via OpenCode's `instructions` config.
- **Ported commands** (`commands/*.md`) — `devspec.work`, `devspec.brainstorm`, `devspec.commit`, `devspec.done`, `devspec.create`, `devspec.link`, `devspec.help`, `devspec.remote`, `devspec.remote-stop` — same names as the Claude Code and Cursor plugins.
- **Autopilot** — unattended queue processing via OpenCode's plugin hooks.
- **Remote control** — attach this OpenCode session to a DevSpec session for phone/web control, delivered via OpenCode's own session-message API rather than a file-based workaround.

## Status

This package is under active development — see the parent DevSpec brief for the full list of in-progress pieces.

## License

MIT
