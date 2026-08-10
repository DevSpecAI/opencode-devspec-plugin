import type { Plugin } from '@opencode-ai/plugin'
import {
  clearPermissionAsked,
  flushMirrorNow,
  handleSessionError,
  listOpenCodeBondSessions,
  logPoll,
  markPermissionAsked,
  pollAndDeliver,
  recordConnectionEventFromTool,
  recordManualPostSessionMessage,
  recordRemoteControlSkillCommand,
  runWithBoundSessionAsync,
  scheduleMirrorNow,
  scheduleWorkTrailPost,
  setBusy,
  shouldAutoAllowRemoteControlPermission,
  stateKeyForOpenCodeBond,
} from './remote-control.js'
import { registerBundledCommands } from './register-commands.js'
import {
  applyServeAuthToPluginClient,
  ensureServeAuthEnv,
} from './serve-auth.js'

// Interactive TUI starts open a localhost HTTP door. Mint (or reuse) a process-local
// OPENCODE_SERVER_PASSWORD as early as this module loads — same rule as rocket
// cold-launch — so the door is never unsecured and the warning stays gone.
// Never upload this secret to DevSpec; MCP still uses the DevSpec token only.
const interactiveServeAuth = ensureServeAuthEnv(process.env)

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

/** OpenCode emits these live; `@opencode-ai/plugin` Event unions may lag. */
function isPermissionAskedEvent(type: string): boolean {
  return type === 'permission.asked' || type === 'permission.ask'
}

function isPermissionResolvedEvent(type: string): boolean {
  return (
    type === 'permission.replied' ||
    type === 'permission.resolved' ||
    type === 'permission.denied' ||
    type === 'permission.answered' ||
    type === 'permission.reply'
  )
}

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
 * MULTI-BOND (item 7a9b7b0f): one OpenCode process may host several chat sessions,
 * each `/devspec.remote`-bonded to a different DevSpec room. The pump iterates
 * every active OpenCode session in `listOpenCodeBondSessions()` — a second attach
 * ADDS a bond; it must never overwrite a single pin (that idle_timeouted Ivory
 * Panda when Racing Dolphin joined, 2026-08-07). Ending one bond removes only
 * that entry; the pump keeps running for the others.
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
  // Defensive: older OpenCode builds omit Authorization on the plugin client
  // when a serve password is set. No-op on builds that already inject it.
  applyServeAuthToPluginClient(client, interactiveServeAuth)

  // Fallback when an event lacks sessionID (rare). Prefer the event's own
  // sessionID for mirror/idle so multi-bond mirrors stay on the right room.
  // Bonds themselves live in remote-control's openCodeBonds map — never a
  // single lastKnown overwrite (7a9b7b0f).
  let fallbackSessionId: string | null = null

  // ---- The long-poll pump (item c9457ab8 + multi-bond 7a9b7b0f) ---------------------
  // One self-scheduling loop: for each active bond, issue a held request (scoped
  // to that bond's state key), then loop. `stopped` + AbortController let dispose
  // cut an in-flight hold short so it never outlives the host process.
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
    logPoll('pump: started (long-poll multi-bond mode)')
    try {
      while (!stopped) {
        const sessions = listOpenCodeBondSessions()
        if (sessions.length === 0) {
          // No `/devspec.remote` bond yet. Costs zero network calls.
          await sleep(IDLE_RECHECK_MS)
          continue
        }
        let minDelay = Number.POSITIVE_INFINITY
        for (const sessionId of sessions) {
          if (stopped) break
          const stateKey = stateKeyForOpenCodeBond(sessionId)
          if (stateKey === undefined) continue
          try {
            const outcome = await runWithBoundSessionAsync(stateKey, () =>
              pollAndDeliver(client, directory, sessionId, {
                signal: abort.signal,
              }),
            )
            if (outcome.stop) {
              // One bond ended — keep polling the others (forgetOpenCodeBond already
              // ran inside pollAndDeliver). Do NOT set stopped / exit the pump.
              logPoll(
                `pump: bond ended for opencodeSession=${sessionId} — ${outcome.reason ?? 'connection ended'} ` +
                  `(remaining=${listOpenCodeBondSessions().length})`,
              )
              continue
            }
            if (outcome.delayMs < minDelay) minDelay = outcome.delayMs
          } catch (err) {
            // Remote control is best-effort: a delivery failure must never interrupt the
            // session the user is actually working in, and must never kill the pump.
            logPoll(`pump: pollAndDeliver threw for ${sessionId}: ${err}`)
            if (IDLE_RECHECK_MS < minDelay) minDelay = IDLE_RECHECK_MS
          }
        }
        if (!Number.isFinite(minDelay)) minDelay = IDLE_RECHECK_MS
        await sleep(minDelay)
      }
    } finally {
      pumpRunning = false
      logPoll('pump: exited')
    }
  }

  // Start immediately: with no bond yet the loop idles on a purely local
  // check (no MCP calls at all), so starting early costs nothing and means the first
  // poll goes out the moment `/devspec.remote` completes its handshake.
  void pump()

  return {
    /**
     * Unattended remote-control yolo: later owner commands arrive via
     * `promptAsync` and never inherit cold-launch `opencode run --auto`.
     * Auto-allow only while a DevSpec bond is live in this process.
     */
    'permission.ask': async (input, output) => {
      if (!shouldAutoAllowRemoteControlPermission()) return
      output.status = 'allow'
      const kind = typeof input?.type === 'string' ? input.type : 'unknown'
      const patterns = input?.pattern
      const patternPreview = Array.isArray(patterns)
        ? patterns.slice(0, 3).join(', ')
        : typeof patterns === 'string'
          ? patterns
          : ''
      logPoll(
        `permission.ask auto-allow (remote-control bond active) type=${kind}` +
          (patternPreview ? ` patterns=${patternPreview}` : ''),
      )
    },
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
      // Never hijack bonds from background session.* noise — only tool.execute.after
      // register/attach adds bonds (see comment historically on lastKnownSessionId).
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
        const target = sessionId ?? fallbackSessionId
        if (target) {
          const stateKey = stateKeyForOpenCodeBond(target)
          if (stateKey !== undefined) {
            await runWithBoundSessionAsync(stateKey, () => setBusy(directory, false))
          } else {
            await setBusy(directory, false)
          }
          flushMirrorNow(client, directory, target)
        }
      } else if (event.type === 'message.updated') {
        // MIRRORING is event-driven now, not a side-effect of the poll tick (see
        // scheduleMirrorNow). Debounce so a model that still calls
        // post_session_message (against skill docs) can record its content hash
        // before we mirror — otherwise text lands first and we double-post.
        const target = sessionId ?? fallbackSessionId
        if (target) {
          scheduleMirrorNow(client, directory, target)
          // The live work trail (item bfca2495) rides the SAME event but must not
          // wait for the mirror's settle debounce: the whole point is that the
          // room sees progress while the turn is still running, so this publishes
          // on its own throttle and closes nothing.
          scheduleWorkTrailPost(client, directory, target)
        }
      } else if (event.type === 'session.error') {
        // Confirmed live: MiniMax connect failures emit session.error. Clear
        // busy and surface the payload into DevSpec — previously only the
        // type line landed in poll.log and the UI stayed "working…".
        await handleSessionError(directory, event)
      } else if (event.type === 'command.executed') {
        // `/devspec.remote` / `/devspec.remote-stop` assistant turns must never
        // mirror into the room (session e7ecc1de connect-turn race).
        recordRemoteControlSkillCommand(directory, props ?? null)
      } else if (isPermissionAskedEvent(event.type)) {
        // Hung permission wait is NOT stall progress — mark so checkBusyStall
        // never slides on the still-"running" tool (bb633917). OpenCode emits
        // `permission.asked` live; SDK Event typings may lag — compare as string.
        const target = sessionId ?? fallbackSessionId
        const mark = async () => {
          markPermissionAsked(directory)
        }
        if (target) {
          const stateKey = stateKeyForOpenCodeBond(target)
          if (stateKey !== undefined) {
            await runWithBoundSessionAsync(stateKey, mark)
          } else {
            await mark()
          }
        } else {
          await mark()
        }
      } else if (isPermissionResolvedEvent(event.type)) {
        const target = sessionId ?? fallbackSessionId
        const clear = async () => {
          clearPermissionAsked(directory)
        }
        if (target) {
          const stateKey = stateKeyForOpenCodeBond(target)
          if (stateKey !== undefined) {
            await runWithBoundSessionAsync(stateKey, clear)
          } else {
            await clear()
          }
        } else {
          await clear()
        }
      }
    },
    'tool.execute.after': async (input, output) => {
      try {
        const opencodeSessionId = typeof input.sessionID === 'string' ? input.sessionID : null
        recordConnectionEventFromTool(directory, input.tool, input.args, output, opencodeSessionId)
        recordManualPostSessionMessage(directory, input.tool, input.args)
        if (
          (input.tool === 'devspec_register_connection' ||
            input.tool.endsWith('register_connection') ||
            input.tool === 'devspec_attach_connection' ||
            input.tool.endsWith('attach_connection')) &&
          opencodeSessionId
        ) {
          fallbackSessionId = opencodeSessionId
          logPoll(
            `bond handshake tool=${input.tool} opencodeSession=${opencodeSessionId} ` +
              `active=${listOpenCodeBondSessions().length}`,
          )
          // Re-arm if the pump ever exited (dispose / empty). pumpRunning makes
          // this a no-op while the multi-bond loop is already alive.
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
