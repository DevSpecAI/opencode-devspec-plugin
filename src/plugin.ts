import type { Plugin } from '@opencode-ai/plugin'
import {
  flushMirrorNow,
  handleSessionError,
  logPoll,
  pollAndDeliver,
  recordConnectionEventFromTool,
  recordManualPostSessionMessage,
  scheduleMirrorNow,
  setBusy,
} from './remote-control.js'
import { registerBundledCommands } from './register-commands.js'

/**
 * Gap after a poll that asked us to wait (an error backoff, or "not connected yet").
 * This is NOT a poll cadence any more — item c9457ab8 replaced the interval with a
 * long-poll, so the SERVER holds each request open and the hold itself is the wait.
 * `pollAndDeliver` returns `delayMs: 0` in the normal case and we go straight back in.
 *
 * The old value here was 8000ms — the shortest cadence of any DevSpec plugin, and the
 * reason OpenCode alone spent 2 of its token's 60 req/min budget every 8 seconds per
 * connection. Lowering it further (the original plan) would have consumed the entire
 * per-token budget from a single connection; long-polling spends ~2 req/min AND
 * delivers instantly. Kept only as the floor for the not-yet-connected case.
 */
const IDLE_RECHECK_MS = 5000

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
 * DELIVERY vs MIRRORING (changed in 0.3.0, items c9457ab8 + 807eadcb):
 *   - DELIVERY is the long-poll pump below. It no longer depends on any OpenCode
 *     event at all, which matters because `session.idle` was historically observed
 *     never to fire in this host — the old `setInterval` was doing all the work while
 *     being documented as a mere "backstop".
 *   - MIRRORING is driven by OpenCode's own `message.updated` (plus `session.idle`
 *     when it does fire). It used to ride the 8s poll tick; with a ~25s hold that
 *     would have traded delivery latency for reply latency, so the two concerns are
 *     now separate. Later runs DID see `session.idle` fire, so both paths are kept —
 *     `setBusy` and `mirrorNow` are both idempotent.
 *
 * Still no separate poller process or inbox file, unlike Claude Code's design — see
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
  // Real bug found live-testing (severe — a live runaway ping-pong loop,
  // not just a delivery gap): this used to update from the generic `event`
  // hook's sessionID on EVERY event type, unconditionally. OpenCode's
  // server re-syncs/touches previously-persisted sessions for a project
  // directory on its own (background session.updated/status/diff activity
  // for OLD sessions the plugin was never actually driving) — so this
  // cache kept getting silently hijacked away from the CURRENT connect's
  // session to some unrelated, dormant one and back again. Two sessions
  // then took turns being "last known," and since mirrorLatestReply's
  // dedup is keyed off content it had already posted for EACH session
  // independently, the two rotated forever, reposting each other's static
  // last message over and over with no new content ever involved.
  //
  // Fixed by only ever setting this from `tool.execute.after`'s own
  // `sessionID` field (confirmed present on the hook's input type) at the
  // exact moment register_connection/attach_connection succeeds — the one
  // signal that unambiguously identifies the session driving THIS connect,
  // immune to background noise from sessions we have nothing to do with.
  let lastKnownSessionId: string | null = null

  // ---- The long-poll pump (item c9457ab8) -------------------------------------------
  // One self-scheduling loop instead of a setInterval: issue a held request, act the
  // instant it returns, immediately issue the next. `stopped` + the AbortController are
  // what let `dispose` (below) cut a 25s hold short so a held request can never outlive
  // the host process — the reason the old interval had to be `unref`'d.
  let stopped = false
  const abort = new AbortController()
  let pumpRunning = false

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (ms <= 0) return resolve()
      const t = setTimeout(resolve, ms)
      // Never let our own backoff timer hold the process open.
      t.unref?.()
    })

  const pump = async () => {
    if (pumpRunning) return
    pumpRunning = true
    logPoll('pump: started (long-poll mode)')
    try {
      while (!stopped) {
        const sessionId = lastKnownSessionId
        if (!sessionId) {
          // No OpenCode session pinned yet (no `/devspec.remote` run in this process).
          // Costs zero network calls — the gate is purely local.
          await sleep(IDLE_RECHECK_MS)
          continue
        }
        try {
          const outcome = await pollAndDeliver(client, directory, sessionId, {
            signal: abort.signal,
          })
          if (outcome.stop) {
            logPoll(`pump: stopping — ${outcome.reason ?? 'connection ended'}`)
            stopped = true
            break
          }
          await sleep(outcome.delayMs)
        } catch (err) {
          // Remote control is best-effort: a delivery failure must never interrupt the
          // session the user is actually working in, and must never kill the pump.
          logPoll(`pump: pollAndDeliver threw: ${err}`)
          await sleep(IDLE_RECHECK_MS)
        }
      }
    } finally {
      pumpRunning = false
      logPoll('pump: exited')
    }
  }

  // Start immediately: with no session pinned yet the loop idles on a purely local
  // check (no MCP calls at all), so starting early costs nothing and means the first
  // poll goes out the moment `/devspec.remote` completes its handshake.
  void pump()

  return {
    /**
     * Verified present on the Hooks type: `dispose?: () => Promise<void>`. Aborting the
     * in-flight hold here is what keeps a 25s held request from delaying host shutdown.
     */
    dispose: async () => {
      stopped = true
      abort.abort()
      logPoll('dispose: pump stopped and in-flight hold aborted')
    },
    config: async (cfg) => {
      registerBundledCommands(cfg)
    },
    event: async ({ event }) => {
      // Deliberately NOT updating lastKnownSessionId here anymore — see the
      // comment on its declaration above. Only used now for the (still
      // never observed, but kept for forward-compat) session.idle path.
      const props = (event as { properties?: Record<string, unknown> }).properties
      const sessionId = typeof props?.sessionID === 'string' ? props.sessionID : undefined
      let propsSummary = ''
      try {
        propsSummary = props ? JSON.stringify(props) : ''
        if (propsSummary.length > 500) propsSummary = `${propsSummary.slice(0, 500)}…`
      } catch {
        propsSummary = String(props)
      }
      logPoll(`event received: type=${event.type} sessionID=${sessionId} props=${propsSummary}`)
      if (event.type === 'session.idle') {
        // Turn finished: clear busy and mirror the reply immediately. Delivery is the
        // pump's job now, so this no longer needs to poll. Flush any pending settle
        // timer from message.updated so we do not double-fire after the idle path.
        await setBusy(directory, false)
        const target = sessionId ?? lastKnownSessionId
        if (target) flushMirrorNow(client, directory, target)
      } else if (event.type === 'message.updated') {
        // MIRRORING is event-driven now, not a side-effect of the poll tick (see
        // scheduleMirrorNow). Debounce so a model that still calls
        // post_session_message (against skill docs) can record its content hash
        // before we mirror — otherwise text lands first and we double-post.
        const target = sessionId ?? lastKnownSessionId
        if (target) scheduleMirrorNow(client, directory, target)
      } else if (event.type === 'session.error') {
        // Confirmed live: MiniMax connect failures emit session.error. Clear
        // busy and surface the payload into DevSpec — previously only the
        // type line landed in poll.log and the UI stayed "working…".
        await handleSessionError(directory, event)
      }
    },
    'tool.execute.after': async (input, output) => {
      try {
        recordConnectionEventFromTool(directory, input.tool, input.args, output)
        recordManualPostSessionMessage(directory, input.tool, input.args)
        if (
          (input.tool === 'devspec_register_connection' ||
            input.tool.endsWith('register_connection') ||
            input.tool === 'devspec_attach_connection' ||
            input.tool.endsWith('attach_connection')) &&
          typeof input.sessionID === 'string'
        ) {
          logPoll(`pinning lastKnownSessionId=${input.sessionID} from tool=${input.tool}`)
          lastKnownSessionId = input.sessionID
          // Re-arm if the pump ever exited (e.g. a previous connection was ended from
          // the Agents page): a fresh connect must start polling again. The pumpRunning
          // guard makes this a no-op while it is already looping.
          if (stopped) {
            stopped = false
            logPoll('pump: re-arming after a fresh connect handshake')
          }
          void pump()
        }
      } catch {
        // Best-effort — must never break the tool call it's observing.
      }
    },
  }
}

export default DevSpecPlugin
