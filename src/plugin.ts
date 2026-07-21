import type { Plugin } from '@opencode-ai/plugin'
import { pollAndDeliver } from './remote-control.js'
import { registerBundledCommands } from './register-commands.js'

/**
 * DevSpec OpenCode plugin entry point.
 *
 * Registered via the `plugin` array in a user's `opencode.json` (see README).
 * The DevSpec MCP connection itself is configured separately, via the `mcp`
 * block in the same `opencode.json` — this plugin does not register MCP
 * servers programmatically, it only adds hooks/behavior on top of the
 * connection OpenCode already has.
 *
 * Note on the `event` hook below: OpenCode does NOT expose a standalone
 * `session.idle` hook function. Session-lifecycle notifications (idle,
 * created, updated, deleted, compacted, ...) are delivered as `Event` union
 * variants through the single generic `event` hook — narrow on
 * `event.type` (e.g. `'session.idle'`) rather than looking for a
 * differently-named hook key. Verified against the installed
 * `@opencode-ai/plugin`/`@opencode-ai/sdk` type definitions, not assumed
 * from docs.
 *
 * Remote control (see src/remote-control.ts) piggybacks on this same
 * `session.idle` event — whenever the session goes quiet, check DevSpec for
 * a dispatched owner command and inject it straight into the session via
 * `client.session.promptAsync`. No separate poller process or inbox file,
 * unlike Claude Code's design — see remote-control.ts for why.
 *
 * The `config` hook registers this package's bundled commands/*.md files
 * into OpenCode's declarative `command` config (see register-commands.ts) —
 * confirmed via a live install that OpenCode does NOT auto-discover a
 * plugin's own `commands/` directory the way it does `instructions` file
 * paths, so shipping the markdown files alone does nothing without this.
 */
export const DevSpecPlugin: Plugin = async ({ client, directory }) => {
  return {
    config: async (cfg) => {
      registerBundledCommands(cfg)
    },
    event: async ({ event }) => {
      if (event.type === 'session.idle') {
        await pollAndDeliver(client, directory, event.properties.sessionID).catch(() => {
          // Remote control is best-effort — a delivery failure must never
          // interrupt the session the user is actually working in.
        })
      }
    },
  }
}

export default DevSpecPlugin
