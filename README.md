# opencode-devspec-plugin

DevSpec integration for [OpenCode](https://opencode.ai) — connects OpenCode to your DevSpec project over MCP, teaches it DevSpec's conventions (briefs, action items, memory), and ports the same `devspec.*` commands and remote-control support that already ship for Claude Code and Cursor.

OpenCode has no plugin marketplace yet, so setup is two manual steps: install the package, then paste two blocks into your `opencode.json`.

## 1. Install

```bash
npm install --save-dev opencode-devspec-plugin
```

## 2. Configure `opencode.json`

Add an `mcp` entry pointing at DevSpec's MCP endpoint, and a `plugin` entry loading this package:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "devspec": {
      "type": "remote",
      "url": "https://devspec.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer dvs_…"
      }
    }
  },
  "plugin": ["opencode-devspec-plugin"],
  "instructions": ["node_modules/opencode-devspec-plugin/instructions/devspec.md"]
}
```

Create your token in DevSpec under **You → Connections** → **Connect a tool** (pick **Read & write**); it starts with `dvs_`. Paste it after `Bearer ` in place of `dvs_…`.

**One token, everywhere.** The token is account-wide — use the *same* one in every tool and on every machine; don't mint one per machine. The project for a run is resolved from the repo's git remote, so a single token works across all your projects. It's retrievable, too: reveal and copy it again any time at **You → Connections** (no show-once).

The URL above (`https://devspec.ai/api/mcp`) is DevSpec's production MCP host. On a self-hosted DevSpec instance, use that instance's host instead.

> **Node.js 18+** is only needed for remote control and working a batch of items (isolated work branches, session mirroring) — plain MCP tool access works without it.

## 3. Verify

Start OpenCode in a DevSpec-tracked repo and ask it to list your DevSpec action items — if the MCP connection is wired correctly, it will call straight through.

## What this package provides

- **MCP wiring guidance** — the config block above; DevSpec's MCP server itself needs no changes.
- **Conventions file** (`instructions/devspec.md`) — DevSpec's workflow rules (briefs/action items, memory usage, pointer to the served implementation contract), auto-loaded via OpenCode's `instructions` config.
- **Commit provenance** — `tool.execute` assistance for honestly readable `git commit -m` forms (including worktree `cd <path> &&` and `git -C`). Edits and unknown tools are never claim-gated. See [docs/commit-provenance.md](docs/commit-provenance.md).
- **Two commands** (`commands/*.md`) — `devspec.remote` and `devspec.remote-stop`, same names as the Claude Code and Cursor plugins. They exist because connecting runs a real setup script; everything else is a sentence you say to the agent, which works in any host with the DevSpec MCP server.
- **Batches** — tell the agent *"Work these DevSpec items in order: 4f2a, 9c1b, 2e7d"* and it reserves them so nobody else takes one mid-run, then claims and works them in order. DevSpec's web app has a copy button that writes that line.
- **Shared session plans** — substantial multi-phase work can use the on-demand `manage_plan` path selected by the served implementation contract; routine turns carry no plan boilerplate. Attached remote sessions receive a strict current active-plan snapshot with room-wide read awareness.
- **Remote control** — attach this OpenCode session to a DevSpec session for phone/web control, delivered via OpenCode's own session-message API rather than a file-based workaround.

## Developing this plugin (coding agents)

Working on remote-control / presence / poll code in this repo? From the plugin root run:

```bash
npm test
```

That builds then runs the full unit suite (including presence-pump). Canonical detail — when to run it, what it covers, and the optional live smell-test — lives in [docs/remote-control/remote-control-opencode.md](docs/remote-control/remote-control-opencode.md#running-tests-after-a-remote-control-change).

## Status

This package is under active development — see the parent DevSpec brief for the full list of in-progress pieces.

## License

MIT
