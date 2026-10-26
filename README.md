# DevSpec for OpenCode

**Build on your team’s best thinking.**

[DevSpec](https://devspec.ai) is where your team, your knowledge and your agents build software together, made for AI-native development from the ground up.

This plugin connects [OpenCode](https://opencode.ai) to your DevSpec project over MCP, loads DevSpec's project instructions (tasks, shared memory, and documents), and provides the `/devspec.remote` and `/devspec.remote-stop` commands for remote control from your phone or browser.

---

## 1. Install

```bash
npm install --save-dev opencode-devspec-plugin
```

## 2. Configure `~/.config/opencode/opencode.jsonc`

Add a `devspec` entry under `mcp`, load `opencode-devspec-plugin` under `plugin`, and point `instructions` at the bundled instructions file in your user-home OpenCode config (`~/.config/opencode/opencode.jsonc` on macOS/Linux, `%USERPROFILE%\.config\opencode\opencode.jsonc` on Windows):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "devspec": {
      "type": "remote",
      "url": "https://api.devspec.ai/api/mcp?model_tools=register_connection,attach_connection,detach_connection",
      "headers": {
        "Authorization": "Bearer dvs_…"
      }
    }
  },
  "plugin": ["opencode-devspec-plugin"],
  "instructions": ["node_modules/opencode-devspec-plugin/instructions/devspec.md"]
}
```

Create your token on DevSpec's [Agents settings page](https://app.devspec.ai/settings/agents): choose **Create your token**, pick **Read & write**, and paste your `dvs_…` token after `Bearer `.

**One token, everywhere.** Your token is account-wide — reuse the same token across every tool and every machine. You can reveal and copy it again any time on the [Agents settings page](https://app.devspec.ai/settings/agents). Which DevSpec project a run uses is resolved automatically from the repository's git remote (`git remote get-url origin`).

While OpenCode loads, the plugin attaches `x-devspec-plugin: opencode/<version>` in memory so DevSpec recognises the installed plugin version automatically.

## 3. Verify

Start OpenCode in a DevSpec-tracked repository and ask it to list your DevSpec tasks.

---

## Commands & usage

| Command | What it does |
|---|---|
| `/devspec.remote` | Connect this OpenCode session to DevSpec's Agents page (`--session <id>` to attach to a room) |
| `/devspec.remote-stop` | Disconnect this session from remote control |

For everything else, ask in plain language:

```text
Work on DevSpec task 4f2a
Work these DevSpec tasks in order: 4f2a, 9c1b, 2e7d
Create a DevSpec task for the login redirect bug
Search DevSpec memories for authentication decisions
```

---

## Development

```bash
npm test
```

## License

MIT
