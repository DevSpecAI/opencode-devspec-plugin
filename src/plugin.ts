import type { Plugin } from '@opencode-ai/plugin'
import {
  clearPermissionAsked,
  clearPendingQuestion,
  flushMirrorNow,
  handleQuestionAsked,
  handleSessionError,
  listOpenCodeBondSessions,
  logPoll,
  markPermissionAsked,
  pollAndDeliver,
  recordConnectionEventFromTool,
  recordManualPostSessionMessage,
  bondLocalId,
  isBondedOpenCodeSession,
  recordRemoteControlSkillCommand,
  rejectPendingQuestion,
  runWithBondAsync,
  scheduleMirrorNow,
  scheduleWorkTrailPost,
  setBusy,
  shouldAutoAllowRemoteControlPermission,
} from './remote-control.js'
import { registerBundledCommands } from './register-commands.js'
import {
  applyServeAuthToPluginClient,
  ensureServeAuthEnv,
} from './serve-auth.js'
import { TrackBeforeMutation } from './track-before-mutation.js'

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

/** MCP tool names arrive prefixed per server (`devspec_register_connection`) or bare. */
function isRegisterConnectionTool(tool: string): boolean {
  return tool === "devspec_register_connection" || tool.endsWith("register_connection")
}

/** The model-facing answer-egress verb, prefixed per MCP server or bare. */
function isPostSessionMessageTool(tool: string): boolean {
  return tool === "devspec_post_session_message" || tool.endsWith("post_session_message")
}

function isAttachConnectionTool(tool: string): boolean {
  return tool === "devspec_attach_connection" || tool.endsWith("attach_connection")
}

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

function isQuestionAskedEvent(type: string): boolean {
  return type === 'question.asked' || type === 'question.v2.asked'
}

function isQuestionResolvedEvent(type: string): boolean {
  return (
    type === 'question.replied' ||
    type === 'question.rejected' ||
    type === 'question.v2.replied' ||
    type === 'question.v2.rejected'
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
  // Claim attestation is intentionally process-local. A plugin restart creates a
  // fresh empty tracker, so local mutation fails closed until this session claims.
  const mutationTracker = new TrackBeforeMutation()

  // Defensive: older OpenCode builds omit Authorization on the plugin client
  // when a serve password is set. No-op on builds that already inject it.
  applyServeAuthToPluginClient(client, interactiveServeAuth)

  // There is deliberately NO fallback session id here (item 2a5d212b). An event
  // that carries no sessionID cannot be attributed to a bond, and "the last
  // session that ran a connect handshake" was never a correct answer to "which
  // room does this belong in" — it is how an unbonded @explore child published
  // 3,886 tokens of internal handoff into DevSpec session 8fd18ec0 as the bonded
  // agent on 2026-08-17. Bonds live in remote-control's openCodeBonds map; an
  // event whose session is absent from it is inert.

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
          // `listOpenCodeBondSessions()` only yields bonded sessions, and the
          // bond key IS the session id — nothing left to look up.
          try {
            const outcome = await runWithBondAsync(sessionId, () =>
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
      // Bond-scoped, not process-wide (item 2a5d212b). Auto-allow is the
      // unattended equivalent of yolo for a REMOTE turn; granting it to an
      // ordinary interactive chat because some *other* chat in this process is
      // bonded silently removes a human safety prompt from a session nobody
      // connected. A remote turn runs in its own bonded session, so this still
      // fires exactly where it is meant to.
      const askingSession = typeof input?.sessionID === 'string' ? input.sessionID : undefined
      if (!askingSession || !isBondedOpenCodeSession(askingSession)) return
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
      mutationTracker.clearAll()
      logPoll('dispose: pump stopped, in-flight hold aborted, and claim attestations cleared')
    },
    config: async (cfg) => {
      registerBundledCommands(cfg)
    },
    event: async ({ event }) => {
      // Never hijack bonds from background session.* noise — only tool.execute.after
      // register/attach adds bonds (see comment historically on lastKnownSessionId).
      const props = (event as { properties?: Record<string, unknown> }).properties
      const eventInfo =
        props?.info && typeof props.info === 'object'
          ? (props.info as Record<string, unknown>)
          : undefined
      const sessionId =
        typeof props?.sessionID === 'string'
          ? props.sessionID
          : event.type === 'session.deleted' && typeof eventInfo?.id === 'string'
            ? eventInfo.id
            : undefined

      // OpenCode exposes session deletion through the generic event hook. Clear
      // claim attestation before the unrelated remote-control bond gate so an
      // unbonded deleted session is cleaned up too.
      if (event.type === 'session.deleted' && sessionId) {
        mutationTracker.clearSession(sessionId)
      }

      // ---- The bond gate (item 2a5d212b) -------------------------------------
      // One gate for every branch below, deliberately here rather than repeated
      // inside each one: a branch added later cannot forget it. An event whose
      // OpenCode session holds no bond is INERT — no post, no trail, no busy
      // mutation, no state write — and an event with no sessionID at all cannot
      // be attributed to a bond, so it is inert too.
      //
      // Unbonded sessions are the common case in a TUI someone is also using
      // normally, so they get one short line and no props dump: this log is
      // per-process and grew to 24MB in three weeks, most of it other people's
      // conversations.
      if (sessionId === undefined || !isBondedOpenCodeSession(sessionId)) {
        logPoll(`event skipped (no bond): type=${event.type} sessionID=${sessionId ?? '(none)'}`)
        return
      }

      let propsSummary = ''
      try {
        propsSummary = props ? JSON.stringify(props) : ''
        if (propsSummary.length > 500) propsSummary = `${propsSummary.slice(0, 500)}…`
      } catch {
        propsSummary = String(props)
      }
      logPoll(`event received: type=${event.type} sessionID=${sessionId} props=${propsSummary}`)

      /** Run a state-touching side effect scoped to THIS event's bond. */
      const inBond = <T>(fn: () => Promise<T>): Promise<T> =>
        runWithBondAsync(sessionId, fn)

      if (event.type === 'session.idle') {
        // Turn finished: clear busy and mirror the reply immediately. Delivery is the
        // pump's job now, so this no longer needs to poll. Flush any pending settle
        // timer from message.updated so we do not double-fire after the idle path.
        await inBond(() => setBusy(directory, false))
        flushMirrorNow(client, directory, sessionId)
      } else if (event.type === 'message.updated') {
        // MIRRORING is event-driven now, not a side-effect of the poll tick (see
        // scheduleMirrorNow). Debounce so a model that still calls
        // post_session_message (against skill docs) can record its content hash
        // before we mirror — otherwise text lands first and we double-post.
        scheduleMirrorNow(client, directory, sessionId)
        // The live work trail (item bfca2495) rides the SAME event but must not
        // wait for the mirror's settle debounce: the whole point is that the
        // room sees progress while the turn is still running, so this publishes
        // on its own throttle and closes nothing.
        scheduleWorkTrailPost(client, directory, sessionId)
      } else if (event.type === 'session.error') {
        // Confirmed live: MiniMax connect failures emit session.error. Clear
        // busy and surface the payload into DevSpec — previously only the
        // type line landed in poll.log and the UI stayed "working…".
        await inBond(() => handleSessionError(directory, event))
      } else if (event.type === 'command.executed') {
        // `/devspec.remote` / `/devspec.remote-stop` assistant turns must never
        // mirror into the room (session e7ecc1de connect-turn race).
        await inBond(async () => {
          recordRemoteControlSkillCommand(props ?? null)
        })
      } else if (isPermissionAskedEvent(event.type)) {
        // Hung permission wait is NOT stall progress — mark so checkBusyStall
        // never slides on the still-"running" tool (bb633917). OpenCode emits
        // `permission.asked` live; SDK Event typings may lag — compare as string.
        await inBond(async () => {
          markPermissionAsked()
        })
      } else if (isPermissionResolvedEvent(event.type)) {
        await inBond(async () => {
          clearPermissionAsked()
        })
      } else if (isQuestionAskedEvent(event.type)) {
        await inBond(() => handleQuestionAsked(directory, props ?? null))
      } else if (isQuestionResolvedEvent(event.type)) {
        await inBond(async () => {
          // Terminal dismiss without our reply: fail the open trail so the room
          // does not sit at Needs your input forever. A successful question.reply
          // already cleared pendingQuestion before this event arrives.
          if (event.type.includes('rejected')) {
            await rejectPendingQuestion({
              client,
              directory,
              reason: 'OpenCode question was dismissed before an answer arrived.',
            })
          } else {
            clearPendingQuestion()
          }
        })
      }
    },
    /**
     * `local_id` is the server's bond key, and the only correct value is derived
     * from THIS OpenCode session (item a72a4e22).
     *
     * The model cannot compute it. OpenCode exposes no session id to a model —
     * the skill says so itself — which is why it used to instruct the model to
     * hash the working directory instead. Bond succession (`78a117ab`) then
     * revived the `(owner, local_id)` connection, so a brand-new conversation in
     * a folder was handed back the previous one's connection, id and codename.
     * That is the server half of the inheritance bug; fixing the local state key
     * alone would have left it entirely intact.
     *
     * The plugin knows the session id on every call, so it supplies the value
     * rather than letting the model derive one. This is not a guard in front of
     * a heuristic — it is the plugin providing a fact the model has no access to.
     */
    'tool.execute.before': async (input, output) => {
      // Independent of remote-control bonds and egress ownership: every session
      // must prove its own successful claim before local mutation.
      mutationTracker.before(input.tool, input.sessionID, output.args)

      // ---- Single-writer enforcement (item 4c639620) -------------------------
      // While this session holds a bond, the plugin owns answer egress, so a
      // model call to post_session_message is refused before it reaches the
      // server rather than deduplicated after it lands.
      //
      // Prose was not enough. The skill has said "never call this" since
      // 42391f84, and on 2026-08-17 the model called it anyway at 16:14:56; the
      // mirror then suppressed ITSELF using a remembered content hash, which is
      // a second writer racing a first and choosing a winner after the fact
      // (a70cdf78). Two OpenCode sessions posted contradictory answers under one
      // connection that way.
      //
      // This blocks the MODEL's tool surface only. The plugin's own delivery is
      // raw JSON-RPC from this process and never passes through here, and every
      // other DevSpec verb — report_progress, action items, memories — is
      // untouched: the boundary is answer egress, not the MCP server.
      if (isPostSessionMessageTool(input.tool)) {
        const bonded =
          typeof input.sessionID === 'string' && isBondedOpenCodeSession(input.sessionID)
        if (bonded) {
          logPoll(
            `post_session_message refused for opencodeSession=${input.sessionID} — ` +
              `plugin owns egress while a bond is active`,
          )
          throw new Error(
            'DevSpec: this OpenCode session is connected to DevSpec, and the plugin posts your ' +
              'reply for you. Do not call post_session_message — just answer normally in the ' +
              'terminal and your answer reaches the room verbatim. (Calling it would create a ' +
              'second, competing writer; see DevSpec item 4c639620.)',
          )
        }
      }

      try {
        if (!isRegisterConnectionTool(input.tool)) return
        if (typeof input.sessionID !== 'string' || !input.sessionID) return
        if (!output.args || typeof output.args !== 'object') output.args = {}
        const args = output.args as Record<string, unknown>
        const correct = bondLocalId(input.sessionID)
        if (args.local_id === correct) return
        const had = typeof args.local_id === 'string' ? args.local_id : null
        args.local_id = correct
        logPoll(
          `register_connection: local_id supplied for opencodeSession=${input.sessionID}` +
            (had ? ` (model had computed a different one)` : ' (model supplied none)'),
        )
      } catch {
        // Best-effort — must never break the tool call it's amending.
      }
    },
    'tool.execute.after': async (input, output) => {
      // Observe the raw structured result before unrelated remote-control work.
      // Malformed/failed results are inert; this observer never throws.
      mutationTracker.after(input.tool, input.sessionID, input.args, output)
      try {
        const opencodeSessionId = typeof input.sessionID === 'string' ? input.sessionID : null
        // NOT bond-gated: this is the call that CREATES the bond, so requiring one
        // first would mean no session could ever connect.
        recordConnectionEventFromTool(input.tool, input.args, output, opencodeSessionId)
        // Bond-gated (2a5d212b): a model posting from an unbonded session must not
        // stamp a content hash onto some other session's remote-turn state.
        if (opencodeSessionId && isBondedOpenCodeSession(opencodeSessionId)) {
          await runWithBondAsync(opencodeSessionId, async () => {
            recordManualPostSessionMessage(input.tool, input.args)
          })
        }
        if ((isRegisterConnectionTool(input.tool) || isAttachConnectionTool(input.tool)) && opencodeSessionId) {
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
