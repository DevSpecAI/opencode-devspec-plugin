/**
 * DevSpec remote control for OpenCode.
 *
 * This is a NEW design, not a straight port of claude-code-devspec-autopilot's
 * remote-control scripts (remote-control-state.mjs + devspec-remote-poll.mjs +
 * devspec-remote-wait.mjs, ~1800 lines combined). That machinery exists purely
 * to work around Claude Code having no server of its own — a detached Node
 * process polls DevSpec and writes owner commands to a file, which the
 * interactive Claude Code session has to separately run a blocking "wait"
 * process to notice.
 *
 * OpenCode doesn't have that problem: this plugin runs INSIDE the OpenCode
 * process and is handed a real SDK `client` that can push a message straight
 * into the live session (`client.session.promptAsync`, verified against the
 * installed @opencode-ai/sdk types — POST /session/:id/message under the
 * hood). So instead of a separate poller process + inbox file + wait script,
 * this hooks OpenCode's own `session.idle` event: whenever the session goes
 * quiet, check DevSpec for a dispatched owner command and inject it directly.
 *
 * Not yet tested against a live OpenCode + DevSpec pairing (no OpenCode
 * install available in the environment this was built in) — the design is
 * grounded in the real installed SDK types, but treat this as a first
 * implementation pass, not a battle-tested one.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Plugin } from '@opencode-ai/plugin'
import { AGENT_NAME } from './agent-identity.js'
import { mcpToolsCall } from './devspec-client.js'
import { resolveDevspecAuth } from './resolve-devspec-auth.js'

/**
 * Persistent diagnostic log for the poll loop's own decisions — every
 * heartbeat's busy value, every delivery/mirror decision, every busy
 * transition. Real gap found live-testing: none of this was ever recorded
 * anywhere, and Axiom has no visibility into heartbeat_connection calls
 * either (they don't appear in the standard tool-call telemetry at all,
 * unlike register_connection/get_session_transcript/post_session_message,
 * which do) — so a stuck "OpenCode is working…" indicator, or a duplicate
 * mirrored reply, was completely undiagnosable from either side without
 * this. Colocated with launch-opencode-session.mjs's own launcher.log
 * (same directory, different file) in the other repo.
 */
function pollLogFile(): string {
  return path.join(os.homedir(), '.devspec', 'opencode-remote-control', 'poll.log')
}

export function logPoll(line: string): void {
  try {
    fs.mkdirSync(path.dirname(pollLogFile()), { recursive: true })
    fs.appendFileSync(pollLogFile(), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // best-effort — logging must never be why a poll fails
  }
}

/**
 * How long a turn may stay `busy` with an empty (no-text) latest assistant
 * message before we treat it as stalled. Real gap found live-testing: a
 * turn reported pickup, stayed busy for minutes with `has no text yet`,
 * then reported complete without ever mirroring a reply — owners saw
 * "working…" forever and had to dig into poll.log. Override via
 * DEVSPEC_OPENCODE_STALL_MS (milliseconds).
 */
export const STALL_TIMEOUT_MS = (() => {
  const raw = process.env.DEVSPEC_OPENCODE_STALL_MS
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 120_000
})()

interface ConnectionState {
  connectionId: string
  sessionId: string | null
  codename: string | null
  /**
   * Id of the last OpenCode assistant message we mirrored back to DevSpec via
   * post_session_message. Prevents re-posting the same reply on every idle
   * poll — there is no other cursor for "have we already reported this one".
   */
  lastMirroredMessageId?: string | null
  /**
   * After we inject an owner command, only mirror assistant messages that
   * appear *after* this OpenCode message id (correlation). Null = no remote
   * inject pending baseline (still allow local-terminal mirror of new messages
   * when attached, never pre-attach history).
   */
  replyAfterOpenCodeMessageId?: string | null
  /** True while waiting for an assistant reply after injecting an owner command. */
  awaitingRemoteReply?: boolean
  /**
   * Cursor into the DevSpec transcript (last delivered message id). Without
   * this, every idle poll re-fetched the WHOLE transcript and re-delivered
   * every owner instruction ever posted — a real bug fixed alongside the
   * model-override work, not a hypothetical one.
   */
  lastDeliveredMessageId?: string | null
  /**
   * Bounded list of DevSpec message ids already delivered via promptAsync.
   * Real bug found live-testing: the SAME owner message got delivered to
   * OpenCode 3 separate times (3 duplicate answers inside one OpenCode
   * session for one single DevSpec-side dispatch) even though
   * get_session_transcript's own after_message_id cursor was verified
   * correct in isolation — the exact mechanism wasn't fully isolated, but
   * this list makes duplicate delivery structurally impossible regardless
   * of how a stale/racing cursor read could happen. Capped at 50 entries in
   * the delivery loop — only needs to cover recent history.
   */
  deliveredMessageIds?: string[]
  /** Assignment ids already injected into OpenCode (sessionless + attached). */
  deliveredAssignmentIds?: string[]
  /**
   * Our own last-known assertion of heartbeat_connection's `busy` flag —
   * the SOLE signal that drives the "OpenCode is working…" indicator on the
   * agent's icon in the DevSpec session UI (confirmed against the tool's
   * own contract). Real gap found: every heartbeat_connection call in this
   * file only ever sent `status: 'live'` — never `busy` — so the connection
   * always showed live but never showed as working, no matter how long a
   * turn actually took. Tracked here so re-asserting on routine keep-alives
   * (per the tool's contract) doesn't require an extra read each time, and
   * so we only call the tool again when the value actually changes.
   */
  busy?: boolean
  /**
   * Epoch ms when `busy` last flipped to true. Used by the stall detector
   * (see checkBusyStall). Cleared when busy goes false. Absent on older
   * state files — checkBusyStall seeds it on first sight rather than
   * immediately treating the turn as already timed out.
   */
  busySince?: number | null
  /**
   * Epoch ms of the busySince window we already posted a stall warning for.
   * Prevents re-posting the same stall on every subsequent poll if clearing
   * busy somehow fails.
   */
  stallWarnedAt?: number | null
  /**
   * Bounded list of OpenCode assistant message ids already mirrored to
   * DevSpec — defense in depth alongside `lastMirroredMessageId` (a single
   * pointer only stops re-posting the SAME message twice in a row). Real
   * bug found live-testing: two unrelated OpenCode-internal sessions ended
   * up alternately "last known" (see plugin.ts's lastKnownSessionId fix),
   * so this pointer kept flipping between two DIFFERENT already-seen
   * messages and reposting each one every time the OTHER one's post
   * overwrote the pointer — an infinite ping-pong between two messages
   * that were each individually "new" relative to whatever the pointer
   * happened to hold at that moment. A set makes that structurally
   * impossible regardless of how the pointer itself gets confused.
   */
  mirroredMessageIds?: string[]
}

/**
 * Report a connection activity verb — the canonical "I'm working" signal as
 * of DevSpec's newer activity state machine (ported from the same fix in
 * claude-code-devspec-autopilot's poller). `busy` (via heartbeat_connection,
 * below) is the OLDER mechanism; the server still translates it, but that
 * translation is documented as a rollout safety net, not the long-term
 * design — report_pickup/keepalive/complete is. Kept additive (both fire
 * together from setBusy, never as a replacement) for exactly the same
 * reason the Claude poller kept its busy-heartbeat unchanged when adding
 * this: both feed the same server-side attempt idempotently, so there's no
 * migration risk in running them side by side. Connection-scoped
 * (attempt_id omitted) — the server resolves the current attempt.
 */
async function reportActivity(directory: string, verb: 'pickup' | 'keepalive' | 'complete'): Promise<void> {
  const auth = resolveDevspecAuth(directory)
  const state = readState(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state) return
  const tool = { pickup: 'report_pickup', keepalive: 'report_keepalive', complete: 'report_complete' }[verb]
  try {
    await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: tool,
      arguments: { connection_id: state.connectionId },
    })
  } catch (err) {
    // Best-effort — never break the poll loop over this.
    logPoll(`reportActivity(${verb}) failed: ${err}`)
  }
}

/**
 * Assert heartbeat_connection's `busy` flag — see the `busy` field doc on
 * ConnectionState for why this exists. Call with `true` right before
 * kicking off a delivered message's turn, and `false` as soon as OpenCode's
 * own `session.idle` event confirms the turn actually finished. Also emits
 * the corresponding report_pickup/report_complete activity verb (see
 * reportActivity) on the same transition — folded in here rather than at
 * each call site so the two mechanisms can never drift out of sync.
 */
export async function setBusy(directory: string, busy: boolean): Promise<void> {
  const auth = resolveDevspecAuth(directory)
  const state = readState(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state) return
  if (state.busy === busy) {
    logPoll(`setBusy(${busy}) skipped — already ${state.busy}`)
    return // already asserted — avoid a redundant call
  }
  logPoll(`setBusy(${busy}) — was ${state.busy}`)
  try {
    await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'heartbeat_connection',
      // Re-assert the fixed agent identity on every heartbeat, like the Claude
      // poller — the connection can never mislabel itself from a stale state file.
      arguments: { connection_id: state.connectionId, agent_name: AGENT_NAME, status: 'live', busy },
    })
    // patchState re-reads disk — never spread a stale snapshot here (see
    // patchState's doc: that lost-update duplicated mirrored replies).
    patchState(directory, {
      busy,
      busySince: busy ? Date.now() : null,
      stallWarnedAt: busy ? null : state.stallWarnedAt ?? null,
    })
  } catch (err) {
    // Best-effort — a failed busy assertion must never crash the poll loop.
    logPoll(`setBusy(${busy}) heartbeat_connection call failed: ${err}`)
    return
  }
  await reportActivity(directory, busy ? 'pickup' : 'complete')
}

function assistantTextFromMessage(message: { parts?: unknown } | null | undefined): string {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  return parts
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('\n')
    .trim()
}

/** Prefer connection_id so the server uses the current attachment (reattach-safe). */
function postMessageArgs(
  state: ConnectionState,
  message: string,
  extras?: { turn_kind?: 'agent' | 'local_prompt'; model?: { providerID: string; modelID: string } },
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    message,
    agent_name: AGENT_NAME,
    ...(extras?.turn_kind ? { turn_kind: extras.turn_kind } : {}),
    ...(extras?.model ? { model: extras.model } : {}),
  }
  if (state.connectionId) args.connection_id = state.connectionId
  else if (state.sessionId) args.session_id = state.sessionId
  return args
}

async function postSessionNotice(
  auth: ReturnType<typeof resolveDevspecAuth>,
  state: ConnectionState,
  message: string,
): Promise<void> {
  if (!auth.ok || !auth.token || !auth.mcp_url) return
  // Notices still need an attached session; connection_id path rejects sessionless.
  if (!state.sessionId && !state.connectionId) return
  try {
    await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'post_session_message',
      arguments: postMessageArgs(state, message, { turn_kind: 'agent' }),
    })
  } catch (err) {
    logPoll(`postSessionNotice failed: ${err}`)
  }
}

/**
 * If we've been busy longer than STALL_TIMEOUT_MS and the latest OpenCode
 * assistant message still has no text, clear busy and warn in the DevSpec
 * session. Called every poll while busy — cheap when under the timeout.
 */
export async function checkBusyStall(
  client: Parameters<Plugin>[0]['client'],
  directory: string,
  sessionId: string,
): Promise<void> {
  const auth = resolveDevspecAuth(directory)
  let state = readState(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state?.busy || !state.sessionId) return

  // Older state files may have busy:true with no busySince — seed now so we
  // don't immediately treat a mid-flight upgrade as already timed out.
  if (!state.busySince) {
    patchState(directory, { busySince: Date.now() })
    logPoll(`stall check: seeded busySince for pre-existing busy=true`)
    return
  }

  const elapsed = Date.now() - state.busySince
  if (elapsed < STALL_TIMEOUT_MS) {
    logPoll(`stall check: busy ${elapsed}ms (< ${STALL_TIMEOUT_MS}ms) — ok`)
    return
  }

  let messages: any[]
  try {
    const res: any = await (client as any).session.messages({ path: { id: sessionId } })
    messages = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  } catch (err) {
    logPoll(`stall check: client.session.messages failed: ${err}`)
    return
  }

  const assistantMessages = messages.filter((m) => m?.info?.role === 'assistant')
  const last = assistantMessages[assistantMessages.length - 1]
  const text = assistantTextFromMessage(last)
  if (text) {
    logPoll(
      `stall check: busy ${elapsed}ms but last assistant (${last?.info?.id}) has text — not a stall`,
    )
    return
  }

  if (state.stallWarnedAt === state.busySince) {
    logPoll(`stall check: already warned for busySince=${state.busySince} — clearing busy again`)
    await setBusy(directory, false)
    return
  }

  const lastId = last?.info?.id ?? 'none'
  logPoll(
    `STALL: busy ${elapsed}ms with empty assistant text (last.id=${lastId}) — clearing busy and posting warning`,
  )
  patchState(directory, { stallWarnedAt: state.busySince })
  await postSessionNotice(
    auth,
    state,
    `⚠️ OpenCode turn stalled after ${Math.round(elapsed / 1000)}s with no reply text ` +
      `(assistant message \`${lastId}\`). Cleared the busy indicator — check ` +
      `~/.devspec/opencode-remote-control/poll.log if this keeps happening.`,
  )
  await setBusy(directory, false)
}

/**
 * Handle OpenCode's `session.error` event: clear busy, post into DevSpec,
 * and log the full event payload. Confirmed live (poll.log) that this event
 * fires on MiniMax connect failures — previously only the type+sessionID
 * were logged and busy was left untouched.
 */
export async function handleSessionError(directory: string, event: unknown): Promise<void> {
  const auth = resolveDevspecAuth(directory)
  const state = readState(directory)
  let detail = ''
  try {
    detail = JSON.stringify(event)
  } catch {
    detail = String(event)
  }
  if (detail.length > 2000) detail = `${detail.slice(0, 2000)}…`
  logPoll(`session.error handled: ${detail}`)

  if (state && auth.ok && (state.sessionId || state.connectionId)) {
    await postSessionNotice(
      auth,
      state,
      `⚠️ OpenCode reported \`session.error\`. Busy cleared. Detail: ${detail}`,
    )
  }
  await setBusy(directory, false)
}

/**
 * DevSpec session id this plugin process is currently bound to. Set once
 * `recordConnectionEventFromTool` observes a successful `attach_connection`
 * carrying a session id — mirrors plugin.ts's own `lastKnownSessionId` pin
 * (same event, same moment), just keyed to the DevSpec session instead of
 * the OpenCode-internal one.
 *
 * Folding this into `stateFile`'s key (below) is what lets two `opencode
 * serve` processes for the SAME project folder — one per DevSpec session —
 * keep fully independent local state instead of silently sharing (and
 * corrupting) one file keyed on folder path alone. Before attach (or for a
 * bare, sessionless connection) this stays null and state falls back to the
 * folder-only key, unchanged from before — session-scoping only matters once
 * a session is actually in play.
 */
let boundSessionId: string | null = null

/**
 * Real bug found live-testing (round 10, same day as the round 9 fix above):
 * plain `Buffer.from(raw).toString('base64url').slice(0, 32)` does NOT
 * distinguish sessions in practice. A typical resolved project path is
 * already well over 32 base64 characters on its own (e.g. a ~100-char
 * Windows path encodes to 130+ base64 chars), so truncating to 32 chars
 * keeps ONLY the directory prefix's encoding — the appended `:sessionId`
 * never survives the slice, no matter what the session id is. Confirmed
 * live: three different session ids for the same folder all produced the
 * BYTE-IDENTICAL 32-char key, so every "session-scoped" launch was still
 * silently sharing one connection/state file, same as before round 9.
 *
 * A real hash (not truncated raw encoding) is required so every input byte
 * — including ones past position ~24 — affects every output character.
 */
function hashKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 32)
}

/**
 * Matches the key `devspec.remote.md` computes for `local_id` (see step 2
 * there) so the local state file and the server-side connection identity
 * stay in step: same folder+session in, same hash out, on both sides.
 */
function stateFile(directory: string): string {
  const base = path.resolve(directory)
  const raw = boundSessionId ? `${base}:${boundSessionId}` : base
  const key = hashKey(raw)
  const dir = path.join(os.homedir(), '.devspec', 'opencode-remote-control')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${key}.json`)
}

function readState(directory: string): ConnectionState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(directory), 'utf8'))
  } catch {
    return null
  }
}

function writeState(directory: string, state: ConnectionState): void {
  fs.writeFileSync(stateFile(directory), JSON.stringify(state, null, 2), { mode: 0o600 })
}

/**
 * Re-read the on-disk state, merge `patch`, write back. Real bug found
 * live-testing: setBusy(false) on the session.idle path and
 * mirrorLatestReply both did `writeState({ ...staleInMemory, … })`, so
 * whichever finished second rolled back the other's cursor fields —
 * lastMirrored got reset to the previous id and the next poll posted the
 * same reply twice into DevSpec. Always merge onto the latest disk
 * snapshot so concurrent writers only touch their own keys.
 */
function patchState(directory: string, patch: Partial<ConnectionState>): ConnectionState | null {
  const current = readState(directory)
  if (!current) return null
  const next = { ...current, ...patch }
  writeState(directory, next)
  return next
}

function clearState(directory: string): void {
  try {
    fs.unlinkSync(stateFile(directory))
  } catch {
    /* already gone */
  }
}

/**
 * Bridge between the `/devspec.remote` MARKDOWN command (which has the model
 * call `register_connection`/`attach_connection` directly as raw MCP tool
 * calls) and this file's own local state, which `pollAndDeliver` depends on
 * to know a connection exists at all.
 *
 * Real gap found live-testing: the command completes a genuine connect
 * handshake with DevSpec's server, but never went through `ensureConnection`/
 * `attachSession` above — so no local state file was ever written, and
 * `pollAndDeliver` (gated on `readState(directory)` being non-null) silently
 * never activated for that session. Wire this into the `tool.execute.after`
 * plugin hook so ANY path that results in these tool calls (the command,
 * or the model doing it ad hoc) keeps local state in sync automatically —
 * no dependence on the command's own wording.
 *
 * `hookOutput` is the RAW `tool.execute.after` output object. Verified live
 * that this does NOT match the hook's own declared `{title, output,
 * metadata}` shape for MCP-sourced tools specifically — MCP results instead
 * arrive as the standard MCP envelope `{content: [{type: 'text', text:
 * '...'}]}`, with the actual JSON payload inside `text`. Built-in tools
 * (bash, glob, ...) DO use `{output: string}`. Check both rather than
 * trusting the declared type, which is only accurate for the built-in case.
 */
export function recordConnectionEventFromTool(
  directory: string,
  toolName: string,
  args: unknown,
  hookOutput: unknown,
): void {
  const isRegister = toolName === 'devspec_register_connection' || toolName.endsWith('register_connection')
  const isAttach = toolName === 'devspec_attach_connection' || toolName.endsWith('attach_connection')
  if (!isRegister && !isAttach) return

  const out = (hookOutput && typeof hookOutput === 'object' ? hookOutput : {}) as Record<string, unknown>
  const mcpContent = Array.isArray(out.content) ? out.content : null
  const rawText =
    typeof out.output === 'string'
      ? out.output
      : mcpContent && typeof mcpContent[0]?.text === 'string'
        ? (mcpContent[0].text as string)
        : null
  if (!rawText) return

  let result: any
  try {
    result = JSON.parse(rawText)
  } catch {
    return
  }

  const argsObj = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>

  if (isRegister) {
    // boundSessionId isn't set yet at this point on a fresh process (attach,
    // below, is what sets it) — this read/write still lands in the
    // folder-only file, same as a bare connection. That's fine: the attach
    // branch below re-binds and migrates state into the session-scoped file
    // moments later in the same command run, before any poll loop starts.
    const existing = readState(directory)
    const connectionId = typeof result?.connection_id === 'string' ? result.connection_id : existing?.connectionId
    if (!connectionId) return
    writeState(directory, {
      connectionId,
      sessionId: existing?.sessionId ?? null,
      codename: typeof result?.codename === 'string' ? result.codename : existing?.codename ?? null,
      lastMirroredMessageId: existing?.lastMirroredMessageId,
      lastDeliveredMessageId: existing?.lastDeliveredMessageId,
      deliveredMessageIds: existing?.deliveredMessageIds,
      mirroredMessageIds: existing?.mirroredMessageIds,
    })
    return
  }

  // Attach: connection_id/session_id may come back on the result, or only be
  // present on the call's own args (DevSpec's attach_connection echoes both,
  // but don't assume — fall back to what the model was called with).
  const sessionId =
    typeof result?.session_id === 'string'
      ? result.session_id
      : typeof argsObj.session_id === 'string'
        ? (argsObj.session_id as string)
        : null

  // Bind BEFORE reading `existing` — a reconnect to a session this process
  // (or a prior run of it) already attached to must resume THAT session's
  // own state file (cursors, dedup sets), not the transient pre-attach
  // scratch state the register branch above just wrote to the folder-only
  // file. See stateFile's doc for why this key flip is what keeps two
  // concurrent `opencode serve` processes for one folder from sharing state.
  if (sessionId) boundSessionId = sessionId
  const existing = readState(directory)

  const connectionId =
    typeof result?.connection_id === 'string'
      ? result.connection_id
      : typeof argsObj.connection_id === 'string'
        ? (argsObj.connection_id as string)
        : existing?.connectionId
  if (!connectionId) return

  writeState(directory, {
    connectionId,
    sessionId: sessionId ?? existing?.sessionId ?? null,
    codename: existing?.codename ?? null,
    lastMirroredMessageId: existing?.lastMirroredMessageId,
    lastDeliveredMessageId: existing?.lastDeliveredMessageId,
    deliveredMessageIds: existing?.deliveredMessageIds,
    mirroredMessageIds: existing?.mirroredMessageIds,
  })
}

/**
 * Register (or reuse) this OpenCode instance as a DevSpec connection.
 * Idempotent per (directory, sessionId) — pass the target DevSpec session id
 * when one is already known (see `attachSession`) so this doesn't collapse
 * onto the same connection as an unrelated session against the same folder;
 * omit it only for a genuinely sessionless (bare) connection.
 */
export async function ensureConnection(
  directory: string,
  sessionId?: string | null,
): Promise<{ auth: ReturnType<typeof resolveDevspecAuth>; state: ConnectionState | null; error?: string }> {
  const auth = resolveDevspecAuth(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url) {
    return { auth, state: null, error: auth.error }
  }

  if (sessionId) boundSessionId = sessionId
  const existing = readState(directory)
  if (existing) return { auth, state: existing }

  const base = path.resolve(directory)
  const localId = hashKey(sessionId ? `${base}:${sessionId}` : base)
  const result: any = await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'register_connection',
    arguments: { local_id: localId, agent_name: AGENT_NAME, cwd: directory },
  })

  const state: ConnectionState = {
    connectionId: result.connection_id,
    sessionId: null,
    codename: result.codename ?? null,
  }
  writeState(directory, state)
  return { auth, state }
}

/** Attach the connection to a DevSpec session — `/devspec.remote --session <id>`. */
export async function attachSession(directory: string, sessionId: string): Promise<void> {
  const { auth, state } = await ensureConnection(directory, sessionId)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state) throw new Error(auth.error || 'DevSpec not configured')
  await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'attach_connection',
    arguments: { connection_id: state.connectionId, session_id: sessionId },
  })
  writeState(directory, { ...state, sessionId })
}

/** Detach + mark the connection offline — `/devspec.remote-stop`. */
export async function stopConnection(directory: string): Promise<void> {
  const auth = resolveDevspecAuth(directory)
  const state = readState(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state) {
    clearState(directory)
    boundSessionId = null
    return
  }
  try {
    await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'detach_connection',
      arguments: { connection_id: state.connectionId },
    })
  } finally {
    clearState(directory)
    boundSessionId = null
  }
}

// Dedup key for reportPollError, keyed by directory — avoids spamming DevSpec
// with the same warning every 8s from the interval backstop. Module-level and
// in-memory only (resets on server restart); that's fine, a repeat failure
// re-posting once per minute is still far better than the total silence this
// replaces.
const lastPollErrorReports = new Map<string, { message: string; at: number }>()
const POLL_ERROR_REPORT_COOLDOWN_MS = 60_000

/**
 * Post a poll failure back into the DevSpec session so it's diagnosable from
 * the owner's side, not just the machine's own (usually inaccessible) logs.
 *
 * Real gap found live-testing: `pollAndDeliver`'s heartbeat/transcript-fetch
 * failures were caught-and-swallowed with zero trace anywhere — a dispatched
 * message could sit as "waiting for pickup" forever with no way for the
 * owner (or anyone debugging remotely) to tell whether delivery was merely
 * slow or the whole poll loop was silently broken.
 */
async function reportPollError(
  auth: ReturnType<typeof resolveDevspecAuth>,
  directory: string,
  state: ConnectionState | null,
  stage: string,
  err: unknown,
): Promise<void> {
  if (!auth.ok || !auth.token || !auth.mcp_url || !state?.sessionId) return
  const message = err instanceof Error ? err.message : String(err)
  const key = `${directory}:${stage}`
  const prior = lastPollErrorReports.get(key)
  if (prior && prior.message === message && Date.now() - prior.at < POLL_ERROR_REPORT_COOLDOWN_MS) return
  lastPollErrorReports.set(key, { message, at: Date.now() })

  await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'post_session_message',
    arguments: postMessageArgs(state, `⚠️ Remote-control poll failed at \`${stage}\`: ${message}`, {
      turn_kind: 'agent',
    }),
  }).catch(() => {
    // Best-effort — a failed error-report must never crash the poll loop.
  })
}

/**
 * Server-authoritative attachment decision — mirrors the Claude poller's
 * `resolveServerAttachment` (devspec-remote-poll.mjs).
 *
 * The heartbeat echo (`hb.session_id`) is the one source of truth for which
 * session this connection is attached to; local state is written FROM it, never
 * used to override it. That is what lets an attach/detach/redirect done from the
 * phone/web Agents page reach this in-process poller at all — the server changes
 * the attachment without ever touching this machine's local state file, so
 * reading the attached session from local state alone would never learn of it.
 *
 * A `not_found` heartbeat means the connection ended server-side and must
 * re-register; it omits `session_id`, so it must NEVER be read as a detach →
 * return no change and leave the current session intact. `changed` is the ONE
 * trigger to reseed the transcript cursor, and it flips only when the
 * server-reported session actually differs from what we currently hold.
 */
export function resolveServerAttachment(
  currentSessionId: string | null,
  hb: unknown,
): { sessionId: string | null; changed: boolean } {
  const obj = hb && typeof hb === 'object' ? (hb as Record<string, unknown>) : null
  if (!obj || obj.status === 'not_found') {
    return { sessionId: currentSessionId, changed: false }
  }
  const raw = obj.session_id
  const hbSession = typeof raw === 'string' && raw ? raw : null
  return { sessionId: hbSession, changed: hbSession !== currentSessionId }
}

/**
 * Poll DevSpec for owner commands and inject any into the live OpenCode
 * session directly. Call this from the `session.idle` event — no separate
 * poller process or inbox file needed, unlike Claude Code's design.
 */
export async function pollAndDeliver(
  client: Parameters<Plugin>[0]['client'],
  directory: string,
  sessionId: string,
): Promise<void> {
  const auth = resolveDevspecAuth(directory)
  // `state` is intentionally `let`, not `const` — real bug found live-
  // testing: every writeState call in this function used to spread from
  // ONE snapshot captured here at the top, so each successive write threw
  // away whatever the PREVIOUS write in this same invocation had just set
  // (deliveredMessageIds clobbering lastDeliveredMessageId, mirrorLatestReply's
  // write then clobbering both of those back to their pre-poll values).
  // Confirmed live: a message got delivered and answered correctly, then
  // re-delivered and re-answered again on the very next 8s poll, because
  // the dedup bookkeeping this same cycle had just written was erased
  // before the cycle even finished. Every write below now also updates
  // this local binding, so later writes in the same call compose on top
  // of earlier ones instead of reverting them.
  let state = readState(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state) return
  logPoll(`pollAndDeliver start sessionId(opencode)=${sessionId} devspecSession=${state.sessionId} busy=${state.busy} lastDelivered=${state.lastDeliveredMessageId} lastMirrored=${state.lastMirroredMessageId}`)

  let hb: unknown
  try {
    hb = await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'heartbeat_connection',
      // Re-assert our fixed identity + last-known busy value on every keep-alive,
      // per heartbeat_connection's own documented contract ("re-assert on
      // keep-alives") — otherwise a long-running turn's busy:true would silently
      // decay back to idle server-side after its freshness window.
      arguments: { connection_id: state.connectionId, agent_name: AGENT_NAME, status: 'live', busy: state.busy ?? false },
    })
  } catch (err) {
    // connection may have ended server-side — next idle cycle will re-check.
    // Still surface it: a persistently failing heartbeat means NOTHING below
    // this line ever runs, which previously looked identical to "delivered,
    // just slow" from the owner's side.
    await reportPollError(auth, directory, state, 'heartbeat_connection', err)
    return
  }

  // Ported from the Claude Code poller's activity-verb emission: while a
  // turn is genuinely in progress, re-assert report_keepalive on the SAME
  // cadence as the routine busy-heartbeat above (this function already runs
  // every 8s via the interval backstop) — mirrors "one poll tick = one
  // keepalive (attended cadence)" from the reference implementation.
  if (state.busy) {
    await reportActivity(directory, 'keepalive')
    // Stall detector — clears busy + posts a warning when a turn sits
    // busy with empty assistant text past STALL_TIMEOUT_MS. Must run
    // BEFORE delivery/mirror so a hung prior turn doesn't block forever.
    await checkBusyStall(client, directory, sessionId)
    state = readState(directory) ?? state
  }

  // Server-authoritative attachment. The heartbeat response — not local state —
  // is the source of truth for which session this connection is attached to. An
  // attach / detach / redirect done from the phone or web Agents page changes it
  // server-side WITHOUT touching this machine's state file, so this poll used to
  // never see it (it read state.sessionId only). Adopt the server's answer here,
  // and only here. `not_found` is guarded inside resolveServerAttachment as
  // "re-register needed" (never a detach), so the session is left intact for it.
  const adopt = resolveServerAttachment(state.sessionId, hb)
  if (adopt.changed) {
    // Adopt the server's session and reseed the transcript cursor exactly once so
    // delivery starts fresh from the newly-attached room instead of resuming an
    // old room's cursor. deliveredMessageIds is left alone — its bounded set
    // still guards against re-delivering anything we genuinely already handled.
    state = { ...state, sessionId: adopt.sessionId, lastDeliveredMessageId: null }
    writeState(directory, state)
  }

  // Sessionless path: still receive connection-native assignment work (ADR).
  // No DevSpec chat posts — inject into the local OpenCode session only.
  if (!state.sessionId) {
    await deliverConnectionAssignments(client, auth, directory, state, sessionId)
    return
  }

  // NOTE: get_connection_dispatch is for agent_assignment work-item batches
  // (autopilot), not ad-hoc chat messages — it has no `owner_messages` field.
  // Session owner commands still come from the transcript's remote_control stamp.
  // Also poll connection dispatch while attached so dual-targeted batches land.
  await deliverConnectionAssignments(client, auth, directory, state, sessionId)
  state = readState(directory) ?? state

  const transcript: any = await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'get_session_transcript',
    arguments: {
      session_id: state.sessionId,
      connection_id: state.connectionId,
      ...(state.lastDeliveredMessageId ? { after_message_id: state.lastDeliveredMessageId } : {}),
    },
  }).catch((err) => {
    // Non-null assertion: `state` is a `let` (reassigned above to compose
    // writes within this call), so TS can't narrow it across this closure —
    // but it's never set back to null anywhere in this function.
    void reportPollError(auth, directory, state, 'get_session_transcript', err)
    return null
  })

  const allMessages: any[] = Array.isArray(transcript?.messages) ? transcript.messages : []
  if (allMessages.length > 0) {
    // Advance the cursor even for messages we don't deliver (advisory context) —
    // without this, every idle poll re-fetched the WHOLE transcript and
    // re-delivered every owner instruction ever posted to this session.
    state = { ...state, lastDeliveredMessageId: allMessages[allMessages.length - 1].id }
    writeState(directory, state)
  }

  const toDeliver = allMessages.filter((m) => m?.remote_control?.is_owner_instruction === true)
  const deliveredIds = new Set(state.deliveredMessageIds ?? [])
  logPoll(
    `fetched ${allMessages.length} messages, ${toDeliver.length} owner instructions, ` +
      `undelivered=${toDeliver.filter((m) => typeof m?.id === 'string' && !deliveredIds.has(m.id)).map((m) => m.id).join(',') || 'none'}`,
  )

  // Assert busy BEFORE kicking off any turn — see setBusy's doc. Only the
  // undelivered ones matter (an all-already-delivered batch means nothing
  // new is actually starting).
  if (toDeliver.some((m) => typeof m?.id === 'string' && !deliveredIds.has(m.id))) {
    await setBusy(directory, true)
    state = { ...state, busy: true } // keep our local copy in sync with what setBusy just wrote
  }

  for (const msg of toDeliver) {
    if (typeof msg?.id === 'string' && deliveredIds.has(msg.id)) continue // see deliveredMessageIds doc

    // Mark as claimed BEFORE calling promptAsync (not after) and persist
    // immediately — closes the race window as tightly as possible so a
    // concurrent/overlapping poll invocation sees this id already delivered
    // rather than independently fetching and delivering it a second time.
    if (typeof msg?.id === 'string') {
      deliveredIds.add(msg.id)
      state = { ...state, deliveredMessageIds: Array.from(deliveredIds).slice(-50) }
      writeState(directory, state)
    }

    const text = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content ?? msg)
    // Per-message provider/model override — only meaningful for
    // provider-agnostic tools (OpenCode). Verified live: promptAsync's body
    // accepts an optional {providerID, modelID} independent of any agent config.
    const rawModel = msg?.dispatch_model
    const model =
      rawModel && typeof rawModel === 'object' && typeof rawModel.providerID === 'string' && typeof rawModel.modelID === 'string'
        ? { providerID: rawModel.providerID, modelID: rawModel.modelID }
        : undefined

    try {
      // Baseline: only mirror assistants that appear *after* the last assistant
      // present at inject time (do not post an unrelated prior local answer).
      let replyAfter: string | null = null
      try {
        const res: any = await (client as any).session.messages({ path: { id: sessionId } })
        const msgs = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
        const assistants = msgs.filter((m: any) => m?.info?.role === 'assistant')
        replyAfter = assistants[assistants.length - 1]?.info?.id ?? null
      } catch {
        /* baseline optional — still inject */
      }
      state = {
        ...state,
        replyAfterOpenCodeMessageId: replyAfter,
        awaitingRemoteReply: true,
      }
      writeState(directory, state)

      // client.session.promptAsync injects the message directly into the running
      // session (POST /session/:id/message under the hood) — no manual paste.
      await (client as any).session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text }], ...(model ? { model } : {}) },
      })
    } catch (err) {
      // A rejected model/credential must surface back into the DevSpec
      // transcript, not vanish silently on the user's own machine.
      const reason = err instanceof Error ? err.message : String(err)
      // Only post errors into DevSpec when attached (sessionless has no room).
      if (state.sessionId) {
        await mcpToolsCall({
          mcpUrl: auth.mcp_url,
          token: auth.token,
          name: 'post_session_message',
          arguments: postMessageArgs(
            state,
            model
              ? `⚠️ Could not run this message on \`${model.providerID}/${model.modelID}\`: ${reason}`
              : `⚠️ Could not deliver this message: ${reason}`,
            { turn_kind: 'agent' },
          ),
        }).catch(() => {
          // Best-effort — a failed error-report must never crash the poll loop.
        })
      } else {
        logPoll(`promptAsync failed (sessionless): ${reason}`)
      }
      // promptAsync itself failed, so no turn is actually running — clear
      // the busy flag asserted above, or it would stick at true with no
      // reply ever coming to clear it via mirrorLatestReply's own path.
      await setBusy(directory, false)
      state = { ...state, busy: false, awaitingRemoteReply: false }
      writeState(directory, state)
    }
  }

  await mirrorLatestReply(client, auth, directory, state, sessionId)
}

/**
 * Poll get_connection_dispatch and inject undelivered assignment batches into
 * the local OpenCode session (works sessionless — no DevSpec chat post).
 */
async function deliverConnectionAssignments(
  client: Parameters<Plugin>[0]['client'],
  auth: ReturnType<typeof resolveDevspecAuth>,
  directory: string,
  state: ConnectionState,
  openCodeSessionId: string,
): Promise<void> {
  if (!auth.ok || !auth.token || !auth.mcp_url || !state.connectionId) return
  let dispatch: any
  try {
    dispatch = await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'get_connection_dispatch',
      arguments: { connection_id: state.connectionId },
    })
  } catch (err) {
    logPoll(`get_connection_dispatch failed: ${err}`)
    return
  }

  const batches: any[] = Array.isArray(dispatch?.assignments)
    ? dispatch.assignments
    : Array.isArray(dispatch?.dispatches)
      ? dispatch.dispatches
      : Array.isArray(dispatch)
        ? dispatch
        : []
  if (batches.length === 0) return

  const delivered = new Set(state.deliveredAssignmentIds ?? [])
  for (const batch of batches) {
    const id = typeof batch?.id === 'string' ? batch.id : typeof batch?.assignment_id === 'string' ? batch.assignment_id : null
    if (!id || delivered.has(id)) continue
    const stateName = String(batch?.state || batch?.status || 'pending')
    if (stateName === 'completed' || stateName === 'released') continue

    delivered.add(id)
    state = {
      ...state,
      deliveredAssignmentIds: Array.from(delivered).slice(-50),
    }
    writeState(directory, state)

    const prompt =
      `📦 DevSpec assignment for this connection (sessionless-capable).\n\n` +
      `Assignment reference: \`${id}\`\n\n` +
      `Run the assignment protocol: get_assignment → acknowledge_assignment → ` +
      `claim_work_item (each member) → implement → record_implementation → resolve_assignment.\n` +
      `Do not invent a DevSpec chat room. Report progress with report_progress / notes only while sessionless.`

    try {
      await setBusy(directory, true)
      await (client as any).session.promptAsync({
        path: { id: openCodeSessionId },
        body: { parts: [{ type: 'text', text: prompt }] },
      })
      logPoll(`injected assignment ${id} into OpenCode session`)
    } catch (err) {
      logPoll(`failed to inject assignment ${id}: ${err}`)
      // Allow retry on next poll
      const ids = (readState(directory)?.deliveredAssignmentIds ?? []).filter((x) => x !== id)
      patchState(directory, { deliveredAssignmentIds: ids })
      await setBusy(directory, false)
    }
  }
}

/**
 * Mirror a completed OpenCode assistant reply into the attached DevSpec session.
 *
 * OpenCode has no separate skill post path — this plugin *is* the agent writer.
 * Rules (ADR b98a39a9 clean cut):
 * - Sessionless: never post chat (assignment/progress only).
 * - Prefer connection_id (server resolves current attachment).
 * - After a remote inject, only mirror assistants newer than the pre-inject baseline
 *   so an unrelated older local answer is not re-posted.
 * - turn_kind: agent.
 */
async function mirrorLatestReply(
  client: Parameters<Plugin>[0]['client'],
  auth: ReturnType<typeof resolveDevspecAuth>,
  directory: string,
  state: ConnectionState,
  sessionId: string,
): Promise<void> {
  // Sessionless: no room. connection_id without attachment would be rejected server-side.
  if (!auth.ok || !auth.token || !auth.mcp_url || !state.sessionId || !state.connectionId) return

  let messages: any[]
  try {
    const res: any = await (client as any).session.messages({ path: { id: sessionId } })
    messages = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  } catch (err) {
    logPoll(`mirrorLatestReply: client.session.messages failed: ${err}`)
    return
  }

  const assistantMessages = messages.filter((m) => m?.info?.role === 'assistant')
  // Always re-read disk before the dedup decision — a concurrent setBusy /
  // prior mirror may have advanced the cursor since `state` was snapshotted
  // at the top of pollAndDeliver.
  const fresh = readState(directory) ?? state
  const alreadyMirrored = new Set(fresh.mirroredMessageIds ?? [])
  const baseline = fresh.replyAfterOpenCodeMessageId ?? null

  // When awaiting a remote reply with a baseline: only assistants *after* that id.
  // If baseline is missing from the list, FAIL CLOSED (do not post whole history).
  let candidates = assistantMessages
  if (fresh.awaitingRemoteReply && baseline) {
    const idx = assistantMessages.findIndex((m) => m?.info?.id === baseline)
    if (idx < 0) {
      logPoll(
        `mirrorLatestReply: FAIL CLOSED — awaiting remote reply but baseline ${baseline} not in message list`,
      )
      return
    }
    candidates = assistantMessages.slice(idx + 1)
    if (candidates.length === 0) {
      logPoll(`mirrorLatestReply: still waiting for assistant after baseline ${baseline}`)
      return
    }
  } else if (fresh.awaitingRemoteReply && !baseline) {
    // Inject had no prior assistant — newest is the only candidate; still OK.
    candidates = assistantMessages
  }

  const last = candidates[candidates.length - 1]
  logPoll(
    `mirrorLatestReply: ${assistantMessages.length} assistant messages, candidates=${candidates.length}, ` +
      `last.id=${last?.info?.id}, lastMirrored=${fresh.lastMirroredMessageId}, ` +
      `awaiting=${fresh.awaitingRemoteReply} baseline=${baseline}`,
  )
  if (!last?.info?.id || last.info.id === fresh.lastMirroredMessageId || alreadyMirrored.has(last.info.id)) {
    logPoll(`mirrorLatestReply: skip (already mirrored or no last message)`)
    return
  }
  // When not awaiting a remote reply, still allow local-terminal answers while
  // attached — but never re-post something older than lastMirrored (handled above).

  const text = assistantTextFromMessage(last)

  if (!text) {
    logPoll(`mirrorLatestReply: last.id=${last.info.id} has no text yet, not persisting — will recheck`)
    // Real bug found live-testing: a message can be checked WHILE STILL
    // STREAMING (no text parts yet) — marking it "mirrored" here (as this
    // code used to) meant it was permanently skipped even once it finished
    // streaming with real text moments later, since the dedup check above
    // only compares message IDs, not content. Confirmed live: a genuine
    // answer to a plain question never made it to DevSpec at all because an
    // earlier poll caught it empty and marked it done first. Do NOT persist
    // here — leave last.info.id unrecorded so the next poll re-evaluates
    // this same message once it (likely) has text. A message that is
    // permanently textless (a real pure-tool-call turn) is harmless to
    // recheck: `last` moves on naturally once a newer message exists.
    // Stall detection for long-lived empty text lives in checkBusyStall.
    return
  }

  // Optimistic claim BEFORE the network post — closes the race where two
  // concurrent poll/idle paths both pass the dedup check, both post, then
  // both write. Whichever claims second sees the id already in the set and
  // skips. If the post fails we roll the claim back so a later poll can retry.
  alreadyMirrored.add(last.info.id)
  const claimed = patchState(directory, {
    lastMirroredMessageId: last.info.id,
    mirroredMessageIds: Array.from(alreadyMirrored).slice(-50),
    awaitingRemoteReply: false,
    replyAfterOpenCodeMessageId: null,
  })
  if (!claimed) return
  // Another writer may have claimed the same id between our check and patch
  // if we lost a race on lastMirrored — re-check isn't perfect without a
  // lock, but the set membership after merge is enough when both use patchState.

  const modelInfo = last.info.model
  const model =
    modelInfo && typeof modelInfo.providerID === 'string' && typeof modelInfo.modelID === 'string'
      ? { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
      : undefined

  try {
    await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'post_session_message',
      arguments: postMessageArgs(fresh, text, { turn_kind: 'agent', model }),
    })
  } catch (err) {
    // Roll back the optimistic claim so this reply can be retried.
    const ids = (readState(directory)?.mirroredMessageIds ?? []).filter((id) => id !== last.info.id)
    patchState(directory, {
      lastMirroredMessageId: fresh.lastMirroredMessageId ?? null,
      mirroredMessageIds: ids,
      awaitingRemoteReply: fresh.awaitingRemoteReply ?? false,
      replyAfterOpenCodeMessageId: fresh.replyAfterOpenCodeMessageId ?? null,
    })
    logPoll(`mirrorLatestReply: post_session_message failed for last.id=${last.info.id}: ${err}`)
    return
  }

  logPoll(`mirrorLatestReply: posted last.id=${last.info.id} via connection_id`)

  // Real bug found live-testing: `session.idle` — the event the busy:false
  // transition was gated on — never fires even once in practice (confirmed
  // by logging every single event type received over a full connect +
  // multiple turns: session.created/updated/status/diff, message.updated,
  // message.part.updated/delta — never session.idle). That left busy stuck
  // true forever after the first delivered message, exactly matching a
  // live report of the "OpenCode is working…" indicator never turning off.
  // A completed reply with real text (this point, right after successfully
  // posting one) is the clearest signal actually available that a turn
  // just finished — use it instead of the dead event.
  // (Later live runs DID see session.idle fire — keep both paths; setBusy
  // is idempotent when already false.)
  await setBusy(directory, false)
}
