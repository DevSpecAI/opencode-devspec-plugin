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
import { McpTimeoutError, mcpToolsCall } from './devspec-client.js'
import { resolveDevspecAuth } from './resolve-devspec-auth.js'
import {
  HOLD_HTTP_GRACE_MS,
  createCarryBuffer,
  buildAttachmentParts,
  emptyTurnBackoffMs,
  errorBackoffMs,
  holdFor,
  isDeliverableCommand,
  pollTerminalReason,
  RECOVERABLE_TERMINAL_MAX,
  renderInjectedTurn,
  resolveServerAttachment,
  unansweredCommands,
  type AdvisoryMessage,
  type CarriedContext,
} from './poll-turn.js'

// Re-exported so the poll-turn split stays an internal refactor for importers.
export {
  buildAttachmentParts,
  isDeliverableCommand,
  pollTerminalReason,
  PERMANENT_END_REASONS,
  renderInjectedTurn,
  resolveServerAttachment,
  holdFor,
} from './poll-turn.js'

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
   * appear *after* this OpenCode message id (correlation). Null with
   * replyBaselineCaptured=true means the snapshot succeeded and there was no
   * prior assistant (empty history at inject). Null with capture failed must
   * fail closed — never fall back to newest-in-history.
   */
  replyAfterOpenCodeMessageId?: string | null
  /**
   * Whether the pre-inject assistant baseline snapshot succeeded.
   * false → fail closed on mirror (do not post any assistant for that remote turn).
   * true + null replyAfter → empty history at inject; any later assistant is new.
   */
  replyBaselineCaptured?: boolean
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

const REMOTE_STATUS_BANNER = '━━━ DevSpec Remote Control ━━━'

/**
 * Strip the terminal-only status block the devspec.remote command tells the
 * model to print. Ported from claude-code-devspec-autopilot's mirror-turn.mjs
 * (same banner template, same rule-line convention) — kept in sync so the
 * skill's "print this in the terminal only" instruction means the same thing
 * everywhere it's given, even though OpenCode has no non-chat output surface
 * to actually keep it out of its own session (unlike Claude/Cursor, where a
 * Stop hook's mirrored text and terminal stdout are architecturally
 * separate). Removes from the banner header through the trailing rule line.
 */
export function stripRemoteControlBanner(text: string): string {
  const t = String(text ?? '')
  const start = t.indexOf(REMOTE_STATUS_BANNER)
  if (start < 0) return t
  const afterHeader = t.slice(start + REMOTE_STATUS_BANNER.length)
  const ruleMatch = afterHeader.match(/\n[─-]{3,}\s*\n?/)
  let end = start + REMOTE_STATUS_BANNER.length
  if (ruleMatch && typeof ruleMatch.index === 'number') {
    end += ruleMatch.index + ruleMatch[0].length
  } else {
    const nextBlank = afterHeader.search(/\n\s*\n/)
    end = nextBlank >= 0 ? start + REMOTE_STATUS_BANNER.length + nextBlank : t.length
  }
  return `${t.slice(0, start)}${t.slice(end)}`.replace(/^\s+|\s+$/g, '')
}

/**
 * True when assistant text is operational chrome that must never become a
 * session chat bubble — the terminal status block, or a bare connect/
 * reconnect one-liner. Fail open for ambiguous / real replies: baseline
 * correlation (awaitingRemoteReply) already decides WHICH message is new;
 * this decides WHAT content in that message is actually postable, since
 * correlation alone lets a genuinely-new-but-still-chrome first reply through.
 */
export function isOperationalChrome(text: string): boolean {
  let t = String(text ?? '').trim()
  if (!t) return true

  if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
  if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true

  if (t.includes(REMOTE_STATUS_BANNER)) {
    t = stripRemoteControlBanner(t).trim()
    if (!t) return true
    if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true
    if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
    // Banner plus a tiny leftover (e.g. "Open: Agents page") — still chrome.
    if (t.length < 80 && /^(Agent|Connection|Session|Status|Open|Stop with):/m.test(t)) return true
  }

  return false
}

/**
 * Prepare an assistant turn's text for mirroring: strip known chrome, then
 * return null if nothing postable remains (pure chrome) — so a real answer
 * that happens to follow a pasted status block still gets posted, banner
 * removed, rather than being dropped along with it.
 */
export function prepareMirrorText(text: string): string | null {
  let t = String(text ?? '').trim()
  if (!t) return null
  if (t.includes(REMOTE_STATUS_BANNER)) t = stripRemoteControlBanner(t).trim()
  if (!t || isOperationalChrome(t)) return null
  return t
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
 * Per-connection pump state: the two cursors, the advisory carry buffer, and the
 * counters that shape backoff. In memory by design — OpenCode injects straight into the
 * live session, so unlike Claude Code there is no separate poller process to hand a file
 * to. The message cursor is ALSO persisted (`lastDeliveredMessageId`) so a plugin
 * restart resumes where it left off instead of re-reading the room; the carry buffer is
 * rebuilt from the cursor-less catch-up window on the first poll after a restart.
 */
interface PumpState {
  cursor: string | null
  dispatchCursor: string | null
  carry: ReturnType<typeof createCarryBuffer>
  needsSeed: boolean
  consecutiveEmpty: number
  consecutiveErrors: number
  /**
   * Consecutive teardowns the server would not attribute to a person. Reset by any
   * clean poll, so only a SUSTAINED absence stops the pump (brief e691c68a).
   */
  consecutiveRecoverableEnds: number
  deliveredDispatchIds: Set<string>
}

const pumpStates = new Map<string, PumpState>()

function pumpStateFor(
  connectionId: string,
  persisted: { cursor: string | null; dispatchIds: string[] },
): PumpState {
  let s = pumpStates.get(connectionId)
  if (!s) {
    s = {
      cursor: persisted.cursor,
      dispatchCursor: null,
      carry: createCarryBuffer(),
      // First poll of a process is a SEED: ask for the catch-up window and treat
      // already-answered commands in it as history rather than as new work.
      needsSeed: true,
      consecutiveEmpty: 0,
      consecutiveErrors: 0,
      consecutiveRecoverableEnds: 0,
      // Seeded from disk so a plugin restart cannot re-inject an assignment it already
      // handed to the model — the interval version persisted this and losing it would
      // have been a silent regression.
      deliveredDispatchIds: new Set(persisted.dispatchIds),
    }
    pumpStates.set(connectionId, s)
  }
  return s
}

/** Drop pump state for a connection (teardown / stop). */
export function forgetPumpState(connectionId: string): void {
  pumpStates.delete(connectionId)
}

/**
 * What the pump should do after one poll. `delayMs: 0` is the normal answer — the
 * server HELD the request, so the wait already happened and we go straight back in.
 */
export interface PollOutcome {
  delayMs: number
  /** The connection is gone server-side: stop pumping and do NOT restart. */
  stop: boolean
  /** Terminal reason, when stop is true. */
  reason?: string
}

/**
 * ONE held `poll_connection` call: heartbeat + dispatch inbox + room delta in a single
 * request (items c9457ab8 + 807eadcb).
 *
 * WHAT THIS REPLACED
 * The old tick was three MCP calls (`heartbeat_connection` + `get_connection_dispatch` +
 * `get_session_transcript`) on an 8s `setInterval` — the shortest cadence of any DevSpec
 * plugin, spending 2 of the token's 60 req/min budget every 8s per connection. Worse, it
 * then threw the room away: `allMessages.filter(m => m?.remote_control?.is_owner_instruction)`
 * kept only owner instructions and advanced the cursor past everything else, so a
 * question like "what do you think of this?" reached the model with no trace of the
 * conversation that prompted it. This was the ONLY hard discard among the plugins.
 *
 * NOW: the server holds one request open, answers the instant anything lands, and
 * returns the turn already tiered into commands / owner-ambient / room-context. We
 * inject what it sends — the labelling is the server's, not ours (Ali, 24 Jul:
 * standardise what we control on the server rather than forcing plugin uniformity).
 */
export async function pollAndDeliver(
  client: Parameters<Plugin>[0]['client'],
  directory: string,
  sessionId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PollOutcome> {
  const auth = resolveDevspecAuth(directory)
  // `state` is intentionally `let`: every writeState below also updates this binding so
  // later writes in the same call compose on top of earlier ones instead of reverting
  // them. A single snapshot spread into several writes is a real bug this file has had
  // twice (delivery bookkeeping erased mid-cycle, causing re-delivery).
  let state = readState(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state) {
    // Not connected yet (no `/devspec.remote` run). Idle cheaply — and note this costs
    // NO network calls, unlike the interval it replaces.
    return { delayMs: 5_000, stop: false }
  }

  const pump = pumpStateFor(state.connectionId, {
    cursor: state.lastDeliveredMessageId ?? null,
    dispatchIds: state.deliveredAssignmentIds ?? [],
  })
  const turnActive = state.busy === true
  const hold = holdFor({ attached: !!state.sessionId, turnActive })

  // While a turn genuinely runs, keep the activity lease alive and let the stall
  // detector clear a hung turn. Unchanged from the interval version, except the cadence
  // is now the hold length rather than 8s.
  if (turnActive) {
    await reportActivity(directory, 'keepalive')
    await checkBusyStall(client, directory, sessionId)
    state = readState(directory) ?? state
  }

  let res: any
  try {
    res = await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'poll_connection',
      arguments: {
        connection_id: state.connectionId,
        agent_name: AGENT_NAME,
        wait_ms: hold.waitMs,
        check_tier: hold.checkTier,
        // Re-assert our own last-known busy on every poll, per the tool's contract —
        // otherwise a long turn's busy:true decays to idle server-side mid-turn.
        busy: state.busy ?? false,
        ...(pump.cursor ? { cursor: pump.cursor } : {}),
        ...(pump.dispatchCursor ? { dispatch_cursor: pump.dispatchCursor } : {}),
        ...(pump.needsSeed ? { catch_up: true } : {}),
      },
      timeoutMs: hold.waitMs + HOLD_HTTP_GRACE_MS,
      signal: opts.signal,
    })
    pump.consecutiveErrors = 0
  } catch (err) {
    if (err instanceof McpTimeoutError) {
      // The hold outlived its client ceiling. That is not an error — it means nothing
      // arrived — so go straight back in rather than backing off.
      logPoll(`poll_connection hit the client ceiling (${err.timeoutMs}ms) — re-issuing`)
      return { delayMs: 0, stop: false }
    }
    if (opts.signal?.aborted) return { delayMs: 0, stop: true, reason: 'host_shutdown' }
    pump.consecutiveErrors++
    const rateLimited = /rate limit/i.test(err instanceof Error ? err.message : String(err))
    const backoff = errorBackoffMs(pump.consecutiveErrors, { rateLimited })
    // Surface it into the room too: a persistently failing poll means nothing below this
    // line ever runs, which from the owner's side is indistinguishable from "delivered,
    // just slow".
    await reportPollError(auth, directory, state, 'poll_connection', err)
    logPoll(`poll_connection failed (${pump.consecutiveErrors}) — retrying in ${backoff}ms: ${err}`)
    return { delayMs: backoff, stop: false }
  }

  // Teardown (UI End, /devspec.remote-stop elsewhere, already-ended row). One check now
  // covers what the separate heartbeat used to: the poll IS the heartbeat.
  const terminal = pollTerminalReason(res)
  if (terminal?.recoverable) {
    // The server says gone, but will not attribute it to a person — so we do not
    // treat it as one. This is the redeploy case: during a container swap
    // poll_connection briefly cannot see a row that is perfectly alive, and the old
    // code stopped the pump permanently on the strength of it (brief e691c68a).
    pump.consecutiveRecoverableEnds++
    const label = terminal.reason ?? 'no reason given'
    if (pump.consecutiveRecoverableEnds < RECOVERABLE_TERMINAL_MAX) {
      const backoff = errorBackoffMs(pump.consecutiveRecoverableEnds)
      logPoll(
        `${terminal.status} (${label}) — recoverable, not a UI end; retrying in ${backoff}ms ` +
          `(${pump.consecutiveRecoverableEnds}/${RECOVERABLE_TERMINAL_MAX})`,
      )
      return { delayMs: backoff, stop: false }
    }
    // Out of patience. Stand down, but say plainly that this was NOT a UI end, so
    // whoever reads the log knows the bond may simply be re-registered.
    logPoll(
      `${terminal.status} (${label}) — still gone after ${RECOVERABLE_TERMINAL_MAX} tries; ` +
        `stopping the pump. This was NOT a UI end — re-register the same bond to resume.`,
    )
    await setBusy(directory, false).catch(() => {})
    forgetPumpState(state.connectionId)
    return { delayMs: 0, stop: true, reason: terminal.reason ?? 'server_ended' }
  }
  if (terminal) {
    // A deliberate human end ('ui' / 'local_stop'). This one must stick.
    const reason = terminal.reason ?? 'ended_from_ui'
    logPoll(`connection ended (${reason}) — stopping the pump; do not restart`)
    await setBusy(directory, false).catch(() => {})
    forgetPumpState(state.connectionId)
    return { delayMs: 0, stop: true, reason }
  }
  // A clean poll clears the recoverable streak — a blip that resolves is over.
  pump.consecutiveRecoverableEnds = 0

  // Server-authoritative attachment: an attach/detach/redirect from the phone or web
  // changes the room WITHOUT touching this machine's state file, so the response — never
  // local state — decides which room we are in.
  const adopt = resolveServerAttachment(state.sessionId, res)
  if (adopt.changed) {
    logPoll(`server attachment ${state.sessionId ?? '(none)'} → ${adopt.sessionId ?? '(none)'}`)
    state = { ...state, sessionId: adopt.sessionId, lastDeliveredMessageId: null }
    writeState(directory, state)
    // Fresh room: drop the cursor and any carried context from the old one, and treat
    // the next window as history rather than as new commands.
    pump.cursor = null
    pump.carry.reset()
    pump.needsSeed = true
    return { delayMs: 0, stop: false }
  }

  if (res?.changed !== true) {
    // The hold ran its course with nothing new. No sleep: holding IS the wait.
    pump.needsSeed = false
    pump.consecutiveEmpty = 0
    return { delayMs: 0, stop: false }
  }

  // ---- Something landed: consume the packaged, tiered turn --------------------------
  const offered: any[] = Array.isArray(res.commands) ? res.commands : []
  // Fail closed: only commands the endpoint addressed to US, with an authority we
  // recognise, may drive the model. A rejected entry is logged, never silently eaten.
  const roomCommands = offered.filter((m) => isDeliverableCommand(m, state!.connectionId))
  if (roomCommands.length !== offered.length) {
    logPoll(
      `REJECTED ${offered.length - roomCommands.length} command(s) not addressed to this connection`,
    )
  }
  const ownerAmbient: AdvisoryMessage[] = Array.isArray(res.owner_ambient) ? res.owner_ambient : []
  const roomContext: AdvisoryMessage[] = Array.isArray(res.room_context) ? res.room_context : []
  const dispatches: any[] = Array.isArray(res.dispatches) ? res.dispatches : []

  // Advisory NEVER wakes the model on its own — it is carried forward and attached to
  // the next command. See createCarryBuffer for why attaching only this response's
  // advisory would not have fixed the 1-2-3 failure.
  if (ownerAmbient.length > 0 || roomContext.length > 0) {
    pump.carry.add(ownerAmbient, roomContext)
    logPoll(
      `carried advisory: +${ownerAmbient.length} owner-ambient, +${roomContext.length} room-context (buffer ${pump.carry.size})`,
    )
  }

  // Dispatched work becomes a command: the assignment reference is what wakes the agent.
  // Replaces this file's own get_connection_dispatch call — same inbox, one round trip.
  const freshDispatches = dispatches.filter(
    (d) => typeof d?.id === 'string' && !pump.deliveredDispatchIds.has(d.id) &&
      !['completed', 'released'].includes(String(d?.state ?? d?.status ?? 'pending')),
  )
  const dispatchCommands = freshDispatches.map((d) => ({
    id: `dispatch:${d.id}`,
    created_at: typeof d?.created_at === 'string' ? d.created_at : new Date().toISOString(),
    addressed_to: res.addressed_to,
    authority: { kind: 'owner', capabilities: ['full'] },
    content:
      `📦 DevSpec assignment dispatched to this connection (assignment \`${d.id}\`).\n\n` +
      `Run the assignment protocol: get_assignment → acknowledge_assignment → ` +
      `claim_work_item (each member, in position order) → implement → record_implementation → ` +
      `resolve_assignment.\n` +
      `While sessionless, report progress with report_progress / item notes — do not invent a chat room.`,
  }))

  // On a seed window, filter out commands already answered before this process existed.
  const liveRoomCommands = pump.needsSeed
    ? (unansweredCommands(roomCommands as any, roomContext) as any[])
    : roomCommands
  pump.needsSeed = false

  // Dedup against what we have already injected (a bounded set — the cursor alone is not
  // enough, as a racing/stale cursor read has caused triple-delivery in this file before).
  const deliveredIds = new Set(state.deliveredMessageIds ?? [])
  const commands = [...dispatchCommands, ...liveRoomCommands].filter(
    (m) => !(typeof m?.id === 'string' && deliveredIds.has(m.id)),
  )

  if (typeof res.cursor === 'string' && res.cursor) pump.cursor = res.cursor
  if (typeof res.dispatch_cursor === 'string') pump.dispatchCursor = res.dispatch_cursor
  // Advance the persisted cursor even for advisory-only turns, or every poll would
  // re-fetch the same window forever.
  if (pump.cursor && pump.cursor !== state.lastDeliveredMessageId) {
    state = { ...state, lastDeliveredMessageId: pump.cursor }
    writeState(directory, state)
  }

  if (commands.length === 0) {
    // Changed, but nothing to deliver (advisory-only, or all already delivered).
    // Advisory-only is normal and must NOT back off — otherwise a chatty room slows
    // command delivery. Only a genuinely empty change escalates.
    const advisoryOnly = ownerAmbient.length > 0 || roomContext.length > 0
    if (advisoryOnly) {
      pump.consecutiveEmpty = 0
      await mirrorLatestReply(client, auth, directory, state, sessionId)
      return { delayMs: 0, stop: false }
    }
    pump.consecutiveEmpty++
    const floor = emptyTurnBackoffMs(pump.consecutiveEmpty, hold.waitMs)
    if (pump.consecutiveEmpty === 1 || pump.consecutiveEmpty % 10 === 0) {
      logPoll(
        `empty change (${pump.consecutiveEmpty}) — backing off ${floor}ms. ` +
          `Repeated empty changes mean a server-side marker is hot for a reason the ` +
          `response does not carry (see item 85f5c74e) — investigate, do not normalise.`,
      )
    }
    return { delayMs: floor, stop: false }
  }
  pump.consecutiveEmpty = 0

  for (const m of commands) {
    if (typeof m?.id === 'string') deliveredIds.add(m.id)
  }
  for (const d of freshDispatches) pump.deliveredDispatchIds.add(d.id)
  // Claim BEFORE injecting and persist immediately, so a concurrent poll — or a restarted
  // process — sees these ids as delivered rather than independently delivering them again.
  state = {
    ...state,
    deliveredMessageIds: Array.from(deliveredIds).slice(-50),
    ...(freshDispatches.length > 0
      ? { deliveredAssignmentIds: Array.from(pump.deliveredDispatchIds).slice(-50) }
      : {}),
  }
  writeState(directory, state)

  // ONE prompt for the whole delivered turn: the room context (labelled inert) followed
  // by every command in the delta. Injecting per-command would queue separate OpenCode
  // turns, and only the first would carry the context they all share.
  const context: CarriedContext | null = pump.carry.take()
  // Attachments ride the same turn as real file parts (item 99165e12). Anything too
  // large to inline is named in the text rather than vanishing.
  const { parts: fileParts, declined: declinedAttachments } = buildAttachmentParts(commands as any)
  const text = renderInjectedTurn({
    commands: commands as any,
    context,
    deliveryContract: typeof res.delivery_contract === 'string' ? res.delivery_contract : null,
    declinedAttachments,
  })
  logPoll(
    `injecting ${commands.length} command(s) with context: ` +
      `${context?.owner_ambient.length ?? 0} owner-ambient, ${context?.room_context.length ?? 0} room-context, ` +
      `${context?.dropped ?? 0} dropped`,
  )

  // Per-message provider/model override — only meaningful for provider-agnostic hosts.
  const rawModel = (commands.find((c: any) => c?.dispatch_model) as any)?.dispatch_model
  const model =
    rawModel && typeof rawModel === 'object' &&
    typeof rawModel.providerID === 'string' && typeof rawModel.modelID === 'string'
      ? { providerID: rawModel.providerID, modelID: rawModel.modelID }
      : undefined

  await setBusy(directory, true)
  state = { ...state, busy: true }

  try {
    // Baseline: only mirror assistant messages that appear AFTER the last one present at
    // inject time. Capture success is tracked separately — a failed snapshot must fail
    // closed at mirror time, never fall back to "newest in history".
    let replyAfter: string | null = null
    let baselineCaptured = false
    try {
      const snap: any = await (client as any).session.messages({ path: { id: sessionId } })
      const msgs = Array.isArray(snap?.data) ? snap.data : Array.isArray(snap) ? snap : []
      const assistants = msgs.filter((m: any) => m?.info?.role === 'assistant')
      replyAfter = assistants[assistants.length - 1]?.info?.id ?? null
      baselineCaptured = true
    } catch (err) {
      logPoll(`inject: baseline snapshot failed (will fail-closed on mirror): ${err}`)
      baselineCaptured = false
    }
    state = {
      ...state,
      replyAfterOpenCodeMessageId: replyAfter,
      replyBaselineCaptured: baselineCaptured,
      awaitingRemoteReply: true,
    }
    writeState(directory, state)

    await (client as any).session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text }, ...fileParts],
        ...(model ? { model } : {}),
      },
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
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
      }).catch(() => {})
    } else {
      logPoll(`promptAsync failed (sessionless): ${reason}`)
    }
    // No turn is actually running, so clear the busy we just asserted.
    await setBusy(directory, false)
    state = {
      ...state,
      busy: false,
      awaitingRemoteReply: false,
      replyAfterOpenCodeMessageId: null,
      replyBaselineCaptured: undefined,
    }
    writeState(directory, state)
  }

  await mirrorLatestReply(client, auth, directory, state, sessionId)
  return { delayMs: 0, stop: false }
}

/**
 * Mirror a finished reply without polling — driven by OpenCode's OWN events.
 *
 * Why this exists: the interval version mirrored replies as a side-effect of its 8s
 * tick. With long-poll a tick happens roughly every 25s, so hanging mirroring off it
 * would have made replies take up to 25s to reach the room — trading delivery latency
 * for reply latency. Instead the pump owns DELIVERY and OpenCode's own message events
 * own MIRRORING, which is both faster than the old 8s floor and free.
 *
 * Cheap-guarded: at most one mirror in flight per directory, and at most one attempt per
 * MIRROR_MIN_GAP_MS, because `message.updated` can fire many times per turn.
 */
const MIRROR_MIN_GAP_MS = 1_500
const mirrorGuards = new Map<string, { at: number; inFlight: boolean }>()

export async function mirrorNow(
  client: Parameters<Plugin>[0]['client'],
  directory: string,
  sessionId: string,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const auth = resolveDevspecAuth(directory)
  const state = readState(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state?.sessionId) return

  const guard = mirrorGuards.get(directory) ?? { at: 0, inFlight: false }
  if (guard.inFlight) return
  if (!force && Date.now() - guard.at < MIRROR_MIN_GAP_MS) return
  guard.inFlight = true
  guard.at = Date.now()
  mirrorGuards.set(directory, guard)
  try {
    await mirrorLatestReply(client, auth, directory, state, sessionId)
  } catch (err) {
    logPoll(`mirrorNow failed: ${err}`)
  } finally {
    guard.inFlight = false
    mirrorGuards.set(directory, guard)
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
  const baselineCaptured = fresh.replyBaselineCaptured

  // When awaiting a remote reply: correlate to pre-inject baseline. Fail closed
  // if the baseline snapshot failed or the baseline id vanished from history.
  let candidates = assistantMessages
  if (fresh.awaitingRemoteReply) {
    if (baselineCaptured === false) {
      logPoll(
        'mirrorLatestReply: FAIL CLOSED — awaiting remote reply but baseline snapshot failed at inject',
      )
      return
    }
    if (baseline) {
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
    } else if (baselineCaptured === true) {
      // Snapshot succeeded with no prior assistant — any assistant is new.
      candidates = assistantMessages
    } else {
      // Legacy state without replyBaselineCaptured + null baseline: fail closed
      // rather than risk posting unrelated history.
      logPoll(
        'mirrorLatestReply: FAIL CLOSED — awaiting remote reply with null baseline and unknown capture status',
      )
      return
    }
  }

  const last = candidates[candidates.length - 1]
  logPoll(
    `mirrorLatestReply: ${assistantMessages.length} assistant messages, candidates=${candidates.length}, ` +
      `last.id=${last?.info?.id}, lastMirrored=${fresh.lastMirroredMessageId}, ` +
      `awaiting=${fresh.awaitingRemoteReply} baseline=${baseline} captured=${baselineCaptured}`,
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

  // Real bug found live-testing: baseline correlation (above) only decides
  // WHICH message is new post-inject — it has no opinion on WHAT the message
  // says. The devspec.remote command tells the model to print its connect
  // status block "in the terminal only", but OpenCode has no channel for
  // that: every assistant turn the model produces is both shown locally AND
  // becomes "the latest assistant message" here. So a model that dutifully
  // follows that instruction produces the status block (or a bare
  // "connected, ready" line) as a real, correctly-correlated new turn —
  // confirmed live: it mirrored into a shared session as a reply to an owner
  // command it never actually answered. prepareMirrorText strips a pasted
  // banner from an otherwise-real reply, and returns null for pure chrome.
  const preparedText = prepareMirrorText(text)

  if (!preparedText) {
    // Claim + treat as a finished (non-)turn so busy clears, but never post.
    logPoll(`mirrorLatestReply: skip (operational chrome) last.id=${last.info.id}`)
    alreadyMirrored.add(last.info.id)
    patchState(directory, {
      lastMirroredMessageId: last.info.id,
      mirroredMessageIds: Array.from(alreadyMirrored).slice(-50),
      awaitingRemoteReply: false,
      replyAfterOpenCodeMessageId: null,
      replyBaselineCaptured: undefined,
    })
    await setBusy(directory, false)
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
    replyBaselineCaptured: undefined,
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
      arguments: postMessageArgs(fresh, preparedText, { turn_kind: 'agent', model }),
    })
  } catch (err) {
    // Roll back the optimistic claim so this reply can be retried.
    const ids = (readState(directory)?.mirroredMessageIds ?? []).filter((id) => id !== last.info.id)
    patchState(directory, {
      lastMirroredMessageId: fresh.lastMirroredMessageId ?? null,
      mirroredMessageIds: ids,
      awaitingRemoteReply: fresh.awaitingRemoteReply ?? false,
      replyAfterOpenCodeMessageId: fresh.replyAfterOpenCodeMessageId ?? null,
      replyBaselineCaptured: fresh.replyBaselineCaptured,
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
