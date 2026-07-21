import type { Plugin } from '@opencode-ai/plugin'
import { logPoll, pollAndDeliver, recordConnectionEventFromTool, setBusy } from './remote-control.js'
import { registerBundledCommands } from './register-commands.js'

/**
 * Backstop poll cadence (ms). Originally added alongside `session.idle` as
 * a defensive fallback for the (assumed) case where idle wouldn't refire.
 * Confirmed live via a full event-type log for a connect handshake and
 * several turns: `session.idle` never fires — not once, ever, in this
 * OpenCode version. The events that DO fire are session.created/updated/
 * status/diff and message.updated/part.updated/part.delta. This interval
 * is therefore not a backstop at all — it is the ONLY thing driving
 * delivery and mirroring. Left running at this cadence; see remote-control.ts
 * for the `busy` flag's own fix now that its true "turn finished" signal
 * (session.idle) turned out not to exist either.
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
 * Remote control (see src/remote-control.ts) still listens for `session.idle`
 * for the low-latency path this was originally designed around, but per the
 * POLL_INTERVAL_MS note above, that event has never been observed to fire —
 * the `setInterval` backstop is what actually delivers and mirrors
 * everything today. Kept in case a future OpenCode version fires it. No
 * separate poller process or inbox file, unlike Claude Code's design — see
 * remote-control.ts for why.
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

  const poll = async (sessionId: string | null, trigger: string) => {
    if (!sessionId || pollInFlight) {
      logPoll(`poll(${trigger}) skipped: sessionId=${sessionId} pollInFlight=${pollInFlight}`)
      return
    }
    pollInFlight = true
    try {
      await pollAndDeliver(client, directory, sessionId)
    } catch (err) {
      // Remote control is best-effort — a delivery failure must never
      // interrupt the session the user is actually working in.
      logPoll(`poll(${trigger}) pollAndDeliver threw: ${err}`)
    } finally {
      pollInFlight = false
    }
  }

  const backstop = setInterval(() => {
    void poll(lastKnownSessionId, 'interval')
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
      logPoll(`event received: type=${event.type} sessionID=${sessionId}`)
      if (event.type === 'session.idle') {
        // Real gap found live-testing: heartbeat_connection was never once
        // called with `busy` — the DevSpec session UI's "OpenCode is
        // working…" indicator on the agent's icon has NO other signal, so
        // the connection always looked live but never showed as working,
        // no matter how long a turn took. session.idle is the ground truth
        // for "a turn just finished" — mark not-busy here, before poll()
        // runs and (if there's a newly dispatched message to act on)
        // reasserts busy:true itself.
        await setBusy(directory, false)
        await poll(sessionId ?? lastKnownSessionId, 'session.idle')
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
