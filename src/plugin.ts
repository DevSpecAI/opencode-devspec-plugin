import type { Plugin } from '@opencode-ai/plugin'

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
 * from docs — future hook additions here (autopilot polling, remote-control
 * message delivery) should follow this same pattern.
 */
export const DevSpecPlugin: Plugin = async ({ client }) => {
  return {
    event: async ({ event }) => {
      if (event.type === 'session.idle') {
        // Autopilot / remote-control hooks land here as their action items ship.
      }
    },
  }
}

export default DevSpecPlugin
