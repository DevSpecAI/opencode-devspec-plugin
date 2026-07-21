import type { Plugin } from '@opencode-ai/plugin'
import { pollAndDeliver, recordConnectionEventFromTool } from './remote-control.js'
import { registerBundledCommands } from './register-commands.js'

/**
 * Backstop poll cadence (ms). `session.idle` is edge-triggered — it only
 * fires on a busy→idle transition, never while a session simply SITS idle.
 * Real bug found live-testing: after the initial connect handshake, the
 * OpenCode session went idle once (one poll fired, delivered nothing new
 * yet), and then nothing further happened inside OpenCode itself — so no
 * second idle event ever fired. A message dispatched from DevSpec after
 * that point (a plain "are you there?") sat forever with nothing left to
 * pick it up; DevSpec showed "Sent · waiting for OpenCode to pick up"
 * indefinitely even though the connection was genuinely live. This interval
 * is the fix: poll on a fixed cadence regardless of session activity, in
 * addition to (not instead of) the low-latency idle-triggered poll.
 */
const POLL_INTERVAL_MS = 8000

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
 * `session.idle` event for low-latency delivery right after activity, PLUS
 * a fixed-cadence `setInterval` backstop (see POLL_INTERVAL_MS above) so a
 * message dispatched from DevSpec while the session is already sitting idle
 * still gets picked up — `session.idle` alone is edge-triggered and will
 * not fire again just because time passes. No separate poller process or
 * inbox file, unlike Claude Code's design — see remote-control.ts for why.
 *
 * The `config` hook registers this package's bundled commands/*.md files
 * into OpenCode's declarative `command` config (see register-commands.ts) —
 * confirmed via a live install that OpenCode does NOT auto-discover a
 * plugin's own `commands/` directory the way it does `instructions` file
 * paths, so shipping the markdown files alone does nothing without this.
 *
 * The `tool.execute.after` hook is the fix for a real gap found live-testing:
 * the `/devspec.remote` command has the model call `register_connection`/
 * `attach_connection` directly as MCP tool calls — a genuine connect
 * handshake with DevSpec's server — but that never touched this plugin's own
 * local state file, so `pollAndDeliver` (gated on that file existing) never
 * activated even though the connection looked live on DevSpec's side.
 * Watching every tool call for those two names keeps local state in sync
 * regardless of how the model got there (the command, or ad hoc reasoning).
 */
export const DevSpecPlugin: Plugin = async ({ client, directory }) => {
  // Cached from whichever event last carried a sessionID — used by the
  // interval backstop below, which has no event of its own to read one from.
  let lastKnownSessionId: string | null = null
  let pollInFlight = false

  const poll = async (sessionId: string | null) => {
    if (!sessionId || pollInFlight) return
    pollInFlight = true
    try {
      await pollAndDeliver(client, directory, sessionId)
    } catch {
      // Remote control is best-effort — a delivery failure must never
      // interrupt the session the user is actually working in.
    } finally {
      pollInFlight = false
    }
  }

  const backstop = setInterval(() => {
    void poll(lastKnownSessionId)
  }, POLL_INTERVAL_MS)
  // Never let this timer keep the process alive on its own — it's a
  // best-effort backstop, not a reason for the server to refuse to exit.
  backstop.unref?.()

  return {
    config: async (cfg) => {
      registerBundledCommands(cfg)
    },
    event: async ({ event }) => {
      const sessionId = (event as { properties?: { sessionID?: string } }).properties?.sessionID
      if (typeof sessionId === 'string') lastKnownSessionId = sessionId
      if (event.type === 'session.idle') {
        await poll(sessionId ?? lastKnownSessionId)
      }
    },
    'tool.execute.after': async (input, output) => {
      try {
        recordConnectionEventFromTool(directory, input.tool, input.args, output)
      } catch {
        // Best-effort — must never break the tool call it's observing.
      }
    },
  }
}

export default DevSpecPlugin
