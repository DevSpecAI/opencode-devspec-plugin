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
import { AsyncLocalStorage } from 'node:async_hooks'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
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
  shouldAdvanceMessageCursor,
  unansweredCommands,
  adoptRequiresNullCursorRepoll,
  type AdvisoryMessage,
  type CarriedContext,
} from './poll-turn.js'
import {
  isDevspecRemoteControlCommand,
  prepareMirrorText,
  shouldClaimConnectTurnSuppress,
  shouldDeferInjectDuringConnect,
  shouldSkipConnectTurnMirror,
} from './mirror-chrome.js'
import { logRemoteControlStory } from './remote-control-story.js'
import {
  TRAIL_POST_MIN_GAP_MS,
  TRAIL_SEED_TEXT,
  serializeTurnTrail,
  shouldPostTrail,
} from './work-trail.js'

export {
  REMOTE_STATUS_BANNER,
  collapseOrphanMarkdownFences,
  isDevspecRemoteControlCommand,
  isOperationalChrome,
  prepareMirrorText,
  shouldClaimConnectTurnSuppress,
  shouldDeferInjectDuringConnect,
  shouldSkipConnectTurnMirror,
  stripRemoteControlBanner,
  unwrapSingleOuterMarkdownFence,
} from './mirror-chrome.js'

// Re-exported so the poll-turn split stays an internal refactor for importers.
export {
  buildAttachmentParts,
  isDeliverableCommand,
  pollTerminalReason,
  PERMANENT_END_REASONS,
  renderInjectedTurn,
  resolveServerAttachment,
  shouldAdvanceMessageCursor,
  holdFor,
  adoptRequiresNullCursorRepoll,
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
 * How long a turn may stay `busy` with no observable progress before we
 * treat it as stalled. Progress means reply text, a new assistant message,
 * or an in-flight tool on the latest assistant — not merely "busy wall-clock
 * with empty text" (Tembo / Racing Heron false stalls: MiniMax tool loops
 * spent minutes with no mirrorable text while still working). Override via
 * DEVSPEC_OPENCODE_STALL_MS (milliseconds).
 */
export const STALL_TIMEOUT_MS = (() => {
  const raw = process.env.DEVSPEC_OPENCODE_STALL_MS
  const n = raw ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 120_000
})()

/**
 * Client ceiling for ordinary (non-long-poll) MCP calls on the pump path.
 * `fetch` has no default timeout — a hung keepalive / heartbeat / notice ahead
 * of the next `poll_connection` freezes `last_seen` while the connection still
 * looks attached, and the server eventually ends it with `idle_timeout`
 * (Climbing Koala / Steady Wolf). Matches Claude poller's activity-verb ceiling.
 */
export const MCP_SHORT_CALL_TIMEOUT_MS = 10_000

/** Tighter ceiling for heartbeat_connection / detach — same as Claude's teardown heartbeats. */
export const MCP_HEARTBEAT_TIMEOUT_MS = 5_000

/**
 * Ceiling for OpenCode `session.messages` on the pump / stall / inject-baseline
 * paths. A hung SDK call ahead of the next `poll_connection` freezes `last_seen`
 * the same way hung MCP did (item 875d75b5 — Crimson Osprey / Gentle Weasel).
 */
export const OPENCODE_SESSION_API_TIMEOUT_MS = 5_000

/**
 * Warn (story `presence_gap`) when this many ms pass without a successful
 * `poll_connection` while the bond is still supposed to look live. Server
 * attached liveness is ~90s — warn before that so Axiom shows the starve.
 */
export const PRESENCE_GAP_WARN_MS = 60_000

/** Minimum spacing between `presence_gap` stories for one connection. */
export const PRESENCE_GAP_WARN_COOLDOWN_MS = 30_000

/**
 * How many consecutive `active_tool` slides on the SAME assistant id are allowed
 * before we treat the turn as stalled. Eternal "running" tool parts otherwise
 * reset `busySince` forever and keep hammering keepalive while poll never runs.
 */
export const MAX_SAME_ASSISTANT_ACTIVE_TOOL_SLIDES = 2

/**
 * After OpenCode emits `permission.asked` (or a tool part is stuck in an ask /
 * permission-wait state), how long we wait before clearing busy. A hung
 * permission prompt is not progress — do not slide the busy timer the way a
 * healthy `active_tool` does (live hang: write tool `running` + external_directory
 * ask → multi-slide then ~6 min empty_assistant_timeout).
 */
export const PERMISSION_ASK_STALL_MS = 15_000

/**
 * Race a promise against a wall-clock ceiling. Used for OpenCode session API
 * calls that have no built-in timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    t.unref?.()
    promise.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (err) => {
        clearTimeout(t)
        reject(err)
      },
    )
  })
}

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
  /**
   * DevSpec message ids injected for the turn CURRENTLY in flight (bounded,
   * cleared once the turn ends). Distinct from `deliveredMessageIds` — that
   * set is permanent (never delivered twice, ever), while this one exists so
   * an abnormal end (stall / `session.error`) can unclaim exactly this
   * turn's ids from `deliveredMessageIds` and let them re-inject, without
   * touching anything an earlier, already-answered turn delivered. Real bug
   * found live: a stalled turn's command stayed marked delivered forever, so
   * `shouldAdvanceMessageCursor` held the poll cursor in place (seedKept>0,
   * inject=0) with no way to ever make progress — see `clearInjectTurnState`.
   * Populated in `pollAndDeliver` alongside `deliveredMessageIds`; cleared
   * (without unclaiming) on a genuine answer, or unclaimed via
   * `clearInjectTurnState` on stall/error.
   */
  currentTurnMessageIds?: string[] | null
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
   * Latest OpenCode assistant message id observed while evaluating stall
   * progress. When a newer assistant appears (even tool-only / empty text),
   * checkBusyStall slides `busySince` forward so a healthy multi-step turn
   * does not trip on wall-clock alone.
   */
  stallProgressAssistantId?: string | null
  /**
   * Consecutive `active_tool` slides already granted for `stallProgressAssistantId`.
   * Reset when busy clears or progress is a new assistant / different reason.
   */
  stallActiveToolSlides?: number | null
  /**
   * True while OpenCode is waiting on a permission prompt (`permission.asked`
   * or equivalent). Cleared when the ask is resolved/denied or busy clears.
   * Stall policy treats this as non-progress — never an `active_tool` slide.
   */
  permissionAskedPending?: boolean
  /**
   * Epoch ms when we first observed the pending permission ask. Used with
   * `PERMISSION_ASK_STALL_MS` for an early stall (sooner than `STALL_TIMEOUT_MS`).
   */
  permissionAskedAt?: number | null
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
  /**
   * Recent content hashes of replies already posted to DevSpec (manual
   * model `post_session_message` OR plugin mirror). Live regression
   * (session 506e2926 / Climbing Zebra): docs told the model not to call
   * `post_session_message`, but it still did — so mirror + model each
   * posted the same answer ~1–2s apart. Hash dedup makes that structurally
   * impossible even when the model ignores the skill wording.
   */
  recentPostedContentHashes?: string[]
  /**
   * True once the model has itself called `post_session_message` during the
   * CURRENT `awaitingRemoteReply` turn (item 5f75c2cb). A message-id-independent
   * double-post guard alongside the hash/tool-part checks in `mirrorLatestReply` —
   * it survives even if the posting assistant message is not (or is no longer)
   * the candidate `mirrorLatestReply` is evaluating. Set by
   * `recordManualPostSessionMessage`; reset to false whenever a turn ends
   * (answer landed, chrome-only, stalled, errored) or a new one is injected.
   */
  manualAnswerPostedThisTurn?: boolean
  /**
   * OpenCode assistant message ids that must never be mirrored — filled from
   * `command.executed` for `/devspec.remote` / `/devspec.remote-stop` so the
   * connect skill turn cannot settle a pending owner dispatch (e7ecc1de).
   */
  nonMirrorMessageIds?: string[]
  /**
   * Set on register / first attach so a connect-turn mirror that races ahead
   * of `command.executed` is still skipped. Cleared once that skip lands or
   * a real post-inject mirror runs. Not set on re-attach to an already-bound
   * session (avoids eating a normal TUI reply after a mid-session reattach).
   */
  connectMirrorSuppressed?: boolean
  /**
   * DevSpec `session_messages.id` of the live work-trail turn currently open for
   * this connection (item bfca2495). Set from the first `phase:'trail'` post of a
   * turn, cleared when the answer or an error closes it. Its real purpose is
   * knowing whether there IS an open bubble to fail: without it a stalled or dead
   * turn leaves a bubble streaming for ever, which is the one outcome the live
   * trail must never produce. The SERVER still resolves which row to write from
   * the connection itself — this is never sent as a target.
   */
  activeTrailMessageId?: string | null
  /** Hash of the last trail body posted — skips updates that would change nothing. */
  lastTrailHash?: string | null
  /** Epoch ms of the last trail post (throttle floor, TRAIL_POST_MIN_GAP_MS). */
  lastTrailPostedAt?: number | null
  /**
   * OpenCode question the turn is blocked on (item 7b4090e4). While set, the next
   * owner `local_agent_dispatch` is delivered via `client.question.reply` instead
   * of `promptAsync`, and busy-stall does not fire — a human may take minutes.
   */
  pendingQuestion?: {
    requestId: string
    questionCount: number
    postedAt: number
  } | null
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
      timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
    })
  } catch (err) {
    // Best-effort — never break the poll loop over this (incl. client timeout).
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
      timeoutMs: MCP_HEARTBEAT_TIMEOUT_MS,
    })
    // patchState re-reads disk — never spread a stale snapshot here (see
    // patchState's doc: that lost-update duplicated mirrored replies).
    patchState(directory, {
      busy,
      busySince: busy ? Date.now() : null,
      stallWarnedAt: busy ? null : state.stallWarnedAt ?? null,
      stallProgressAssistantId: busy ? null : state.stallProgressAssistantId ?? null,
      stallActiveToolSlides: busy ? 0 : null,
      // Permission wait is turn-scoped — clear on both busy edges so a stale
      // ask cannot poison the next turn or linger after we clear busy.
      permissionAskedPending: false,
      permissionAskedAt: null,
    })
  } catch (err) {
    // Best-effort — a failed busy assertion must never crash the poll loop.
    logPoll(`setBusy(${busy}) heartbeat_connection call failed: ${err}`)
    return
  }
  await reportActivity(directory, busy ? 'pickup' : 'complete')
  if (!busy) {
    const after = readState(directory)
    if (after) {
      logRemoteControlStory({
        phase: 'complete_turn',
        outcome: 'cleared',
        connectionId: after.connectionId,
        sessionId: after.sessionId,
        agent: AGENT_NAME,
        codename: after.codename,
        tool: 'setBusy',
        reason: 'busy_false',
      })
    }
  }
}

export function assistantTextFromMessage(message: { parts?: unknown } | null | undefined): string {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  return parts
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('\n')
    .trim()
}

/** Shape `post_session_message` accepts for reply model attribution. */
export type OpenCodeModelStamp = { providerID: string; modelID: string }

const MODEL_SHAPE_SNIPPET_MAX = 240

/**
 * Compact, safe-for-logs preview of an unknown model field — never silent
 * when the stamp guard rejects a shape (Obsidian Gecko / Restless Ocelot).
 */
export function summarizeModelShapeSnippet(raw: unknown): string {
  if (raw === undefined) return 'undefined'
  if (raw === null) return 'null'
  if (typeof raw === 'string') {
    return raw.length > MODEL_SHAPE_SNIPPET_MAX
      ? `${raw.slice(0, MODEL_SHAPE_SNIPPET_MAX)}…`
      : raw
  }
  try {
    const json = JSON.stringify(raw)
    if (json == null) return Object.prototype.toString.call(raw)
    return json.length > MODEL_SHAPE_SNIPPET_MAX
      ? `${json.slice(0, MODEL_SHAPE_SNIPPET_MAX)}…`
      : json
  } catch {
    return Object.prototype.toString.call(raw)
  }
}

function pickStringField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

/**
 * Extract `{ providerID, modelID }` from OpenCode `message.info.model` (or a
 * dispatch_model override). Accepts common aliases; returns why the stamp
 * failed when the raw value is present but unusable — callers must log that
 * path instead of dropping model silently.
 *
 * Model.Ref nested shapes use `id` for the model slug (`{ providerID, id }`);
 * `id` is accepted as a modelID alias.
 */
export function extractOpenCodeReplyModel(raw: unknown): {
  model?: OpenCodeModelStamp
  missingReason?: 'absent' | 'non_object' | 'missing_fields' | 'empty_fields'
  rawSnippet?: string
} {
  if (raw == null) return { missingReason: 'absent' }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return { missingReason: 'empty_fields', rawSnippet: summarizeModelShapeSnippet(raw) }
    const slash = trimmed.indexOf('/')
    if (slash > 0 && slash < trimmed.length - 1) {
      return {
        model: {
          providerID: trimmed.slice(0, slash),
          modelID: trimmed.slice(slash + 1),
        },
      }
    }
    return { missingReason: 'missing_fields', rawSnippet: summarizeModelShapeSnippet(raw) }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { missingReason: 'non_object', rawSnippet: summarizeModelShapeSnippet(raw) }
  }
  const obj = raw as Record<string, unknown>
  const providerID = pickStringField(obj, ['providerID', 'providerId', 'provider'])
  // `id` is OpenCode Model.Ref's model slug (not message id) when paired with providerID.
  const modelID = pickStringField(obj, ['modelID', 'modelId', 'model', 'id'])
  if (providerID && modelID) return { model: { providerID, modelID } }
  if (!providerID && !modelID) {
    return { missingReason: 'missing_fields', rawSnippet: summarizeModelShapeSnippet(raw) }
  }
  return { missingReason: 'empty_fields', rawSnippet: summarizeModelShapeSnippet(raw) }
}

/** Where `resolveOpenCodeAssistantModel` found (or failed to find) the stamp. */
export type OpenCodeAssistantModelSource =
  | 'info.flat'
  | 'info.model'
  | 'info.metadata.assistant'
  | 'absent'

/**
 * Resolve the reply model from an OpenCode session message.
 *
 * Assistant turns store flat `info.providerID` + `info.modelID` (e.g. MiniMax).
 * Nested `info.model` is the user-message / Model.Ref shape. Reading only
 * `info.model` caused false `model_missing` / `mirrored_without_model` when
 * the model was present on the assistant message.
 *
 * Tries in order: flat info fields → nested `info.model` → legacy
 * `info.metadata.assistant`.
 */
export function resolveOpenCodeAssistantModel(message: {
  info?: unknown
} | null | undefined): {
  model?: OpenCodeModelStamp
  missingReason?: 'absent' | 'non_object' | 'missing_fields' | 'empty_fields'
  rawSnippet?: string
  source: OpenCodeAssistantModelSource
} {
  const info = message?.info
  if (info == null || typeof info !== 'object' || Array.isArray(info)) {
    return {
      missingReason: 'absent',
      rawSnippet: summarizeModelShapeSnippet(info),
      source: 'absent',
    }
  }
  const infoObj = info as Record<string, unknown>

  // 1. Flat assistant shape — do not pass nested `model` into the extractor
  //    (that key is a different shape on user messages).
  const flatRaw: Record<string, unknown> = {
    providerID: infoObj.providerID,
    providerId: infoObj.providerId,
    provider: infoObj.provider,
    modelID: infoObj.modelID,
    modelId: infoObj.modelId,
  }
  const hasFlatHint = Object.values(flatRaw).some((v) => typeof v === 'string' && v.trim())
  if (hasFlatHint) {
    const flat = extractOpenCodeReplyModel(flatRaw)
    if (flat.model) return { ...flat, source: 'info.flat' }
  }

  // 2. Nested info.model (user-message / Model.Ref style)
  if ('model' in infoObj && infoObj.model != null) {
    const nested = extractOpenCodeReplyModel(infoObj.model)
    if (nested.model) return { ...nested, source: 'info.model' }
    // Prefer reporting the nested failure when that field was present.
    const legacy = resolveLegacyAssistantMetadata(infoObj)
    if (legacy?.model) return legacy
    return {
      missingReason: nested.missingReason ?? 'absent',
      rawSnippet: nested.rawSnippet ?? summarizeModelShapeSnippet(infoObj.model),
      source: 'info.model',
    }
  }

  // 3. Legacy metadata.assistant
  const legacy = resolveLegacyAssistantMetadata(infoObj)
  if (legacy) return legacy

  if (hasFlatHint) {
    const flat = extractOpenCodeReplyModel(flatRaw)
    return {
      missingReason: flat.missingReason ?? 'absent',
      rawSnippet: flat.rawSnippet ?? summarizeModelShapeSnippet(flatRaw),
      source: 'info.flat',
    }
  }

  return {
    missingReason: 'absent',
    rawSnippet: summarizeModelShapeSnippet(infoObj),
    source: 'absent',
  }
}

function resolveLegacyAssistantMetadata(infoObj: Record<string, unknown>): {
  model?: OpenCodeModelStamp
  missingReason?: 'absent' | 'non_object' | 'missing_fields' | 'empty_fields'
  rawSnippet?: string
  source: OpenCodeAssistantModelSource
} | null {
  const meta = infoObj.metadata
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return null
  const assistant = (meta as Record<string, unknown>).assistant
  if (assistant == null) return null
  const legacy = extractOpenCodeReplyModel(assistant)
  if (legacy.model) return { ...legacy, source: 'info.metadata.assistant' }
  return {
    missingReason: legacy.missingReason ?? 'absent',
    rawSnippet: legacy.rawSnippet ?? summarizeModelShapeSnippet(assistant),
    source: 'info.metadata.assistant',
  }
}

/** Story `data` fragment when a model stamp is known. */
export function modelStoryData(model: OpenCodeModelStamp | undefined): Record<string, unknown> {
  if (!model) return {}
  return {
    model: `${model.providerID}/${model.modelID}`,
    providerID: model.providerID,
    modelID: model.modelID,
  }
}

/**
 * True when the latest assistant message still has an in-flight tool
 * (pending / running). Completed tools alone are not progress — the turn
 * may be wedged between steps with an empty completed tool message.
 */
export function messageHasActiveToolWork(message: { parts?: unknown } | null | undefined): boolean {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue
    const part = p as Record<string, unknown>
    if (part.type !== 'tool') continue
    const state = part.state
    if (!state || typeof state !== 'object') continue
    const status = String((state as Record<string, unknown>).status ?? '').toLowerCase()
    if (status === 'pending' || status === 'running') return true
  }
  return false
}

/**
 * True when the latest assistant message indicates OpenCode is waiting on a
 * permission prompt (hung `permission.asked`). Defensive across part shapes
 * OpenCode has used: dedicated permission parts, tool state ask/waiting/
 * permission*, and nested permission flags. A "running" tool alone is NOT
 * enough — that still looks like healthy work until an ask is present.
 */
export function messageHasPendingPermissionAsk(
  message: { parts?: unknown } | null | undefined,
): boolean {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue
    const part = p as Record<string, unknown>
    const type = String(part.type ?? '').toLowerCase()
    if (
      type === 'permission' ||
      type === 'permission_ask' ||
      type === 'permission-ask' ||
      type === 'permission.asked'
    ) {
      return true
    }

    const topStatus = String(part.status ?? '').toLowerCase()
    if (
      topStatus === 'ask' ||
      topStatus === 'waiting' ||
      topStatus === 'permission' ||
      topStatus === 'permission_ask' ||
      topStatus === 'awaiting_permission' ||
      topStatus.includes('permission')
    ) {
      return true
    }
    if (part.permission === true || part.permissionAsk === true || part.needsPermission === true) {
      return true
    }

    const state = part.state
    if (state && typeof state === 'object') {
      const st = state as Record<string, unknown>
      const status = String(st.status ?? '').toLowerCase()
      if (
        status === 'ask' ||
        status === 'waiting' ||
        status === 'permission' ||
        status === 'permission_ask' ||
        status === 'awaiting_permission' ||
        status.includes('permission')
      ) {
        return true
      }
      if (st.permission === true || st.permissionAsk === true || st.needsPermission === true) {
        return true
      }
      const nestedPerm = st.permission
      if (nestedPerm && typeof nestedPerm === 'object') {
        const np = nestedPerm as Record<string, unknown>
        const nestStatus = String(np.status ?? np.state ?? '').toLowerCase()
        if (
          nestStatus === 'ask' ||
          nestStatus === 'asked' ||
          nestStatus === 'pending' ||
          nestStatus === 'waiting' ||
          nestStatus.includes('ask')
        ) {
          return true
        }
      }
    }
  }
  return false
}

/**
 * Record that OpenCode asked for permission (plugin `permission.asked` path).
 * Idempotent on the timestamp — keep the first ask time so the early stall
 * clock does not reset if the event repeats.
 */
export function markPermissionAsked(directory: string, nowMs: number = Date.now()): void {
  const state = readState(directory)
  if (!state) return
  if (state.permissionAskedPending && state.permissionAskedAt != null) {
    logPoll(`markPermissionAsked: already pending since ${state.permissionAskedAt}`)
    return
  }
  patchState(directory, {
    permissionAskedPending: true,
    permissionAskedAt: state.permissionAskedAt ?? nowMs,
  })
  logPoll(`markPermissionAsked: pending permission ask at ${state.permissionAskedAt ?? nowMs}`)
}

/** Clear a pending permission ask (resolved / denied / replied, or busy clear). */
export function clearPermissionAsked(directory: string): void {
  const state = readState(directory)
  if (!state) return
  if (!state.permissionAskedPending && state.permissionAskedAt == null) return
  patchState(directory, {
    permissionAskedPending: false,
    permissionAskedAt: null,
  })
  logPoll('clearPermissionAsked: cleared pending permission ask')
}

/** Format OpenCode question.asked properties into a DevSpec-readable prompt. */
export function formatQuestionPrompt(props: {
  questions?: Array<{
    question?: string
    header?: string
    options?: Array<{ label?: string; description?: string }>
  }>
}): string {
  const questions = Array.isArray(props.questions) ? props.questions : []
  if (questions.length === 0) return 'OpenCode needs your input.'
  const blocks = questions.map((q, i) => {
    const header = typeof q.header === 'string' && q.header.trim() ? q.header.trim() : null
    const body = typeof q.question === 'string' && q.question.trim() ? q.question.trim() : 'Question'
    const opts = Array.isArray(q.options)
      ? q.options
          .map((o) => {
            const label = typeof o?.label === 'string' ? o.label.trim() : ''
            if (!label) return null
            const desc = typeof o?.description === 'string' && o.description.trim() ? ` — ${o.description.trim()}` : ''
            return `- ${label}${desc}`
          })
          .filter(Boolean)
      : []
    const title = questions.length > 1 ? `${i + 1}. ${header ? `${header}: ` : ''}${body}` : `${header ? `${header}: ` : ''}${body}`
    return opts.length > 0 ? `${title}\n${opts.join('\n')}` : title
  })
  return blocks.join('\n\n')
}

/**
 * Surface an OpenCode question.asked event as DevSpec needs-your-input on the
 * open live trail turn. Idempotent on the same request id.
 */
export async function handleQuestionAsked(
  directory: string,
  props: Record<string, unknown> | null | undefined,
): Promise<void> {
  const requestId = typeof props?.id === 'string' ? props.id.trim() : ''
  if (!requestId) {
    logPoll('handleQuestionAsked: missing request id — ignored')
    return
  }
  const state = readState(directory)
  if (!state?.connectionId) {
    logPoll(`handleQuestionAsked: no connection for request ${requestId}`)
    return
  }
  if (state.pendingQuestion?.requestId === requestId) {
    logPoll(`handleQuestionAsked: already pending ${requestId}`)
    return
  }

  const questions = Array.isArray(props?.questions) ? (props!.questions as Array<Record<string, unknown>>) : []
  const prompt = formatQuestionPrompt({ questions: questions as any })
  const auth = resolveDevspecAuth(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url) return

  try {
    const result = await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'post_session_message',
      arguments: postMessageArgs(state, prompt, {
        turn_kind: 'agent',
        phase: 'needs_input',
        needs_input: {
          kind: 'question',
          request_id: requestId,
          prompt,
          options: questions,
        },
      }),
      timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
    })
    const messageId = extractPostedMessageId(result)
    patchState(directory, {
      pendingQuestion: {
        requestId,
        questionCount: Math.max(1, questions.length),
        postedAt: Date.now(),
      },
      ...(messageId ? { activeTrailMessageId: messageId } : {}),
    })
    logPoll(`handleQuestionAsked: posted needs_input request=${requestId} message=${messageId ?? 'n/a'}`)
    logRemoteControlStory({
      phase: 'mirror_post',
      outcome: 'posted',
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      agent: AGENT_NAME,
      codename: state.codename,
      tool: 'post_session_message',
      reason: 'needs_input',
      data: { request_id: requestId, question_count: questions.length },
    })
  } catch (err) {
    logPoll(`handleQuestionAsked: post failed: ${err}`)
  }
}

/** Clear a pending question after reply/reject/disconnect. */
export function clearPendingQuestion(directory: string): void {
  const state = readState(directory)
  if (!state?.pendingQuestion) return
  patchState(directory, { pendingQuestion: null })
  logPoll('clearPendingQuestion: cleared')
}

/**
 * Deliver an owner command into a waiting OpenCode question (not a new prompt).
 * Returns true when the reply was sent (caller should not also promptAsync).
 */
export async function replyPendingQuestion(input: {
  client: Parameters<Plugin>[0]['client']
  directory: string
  answerText: string
}): Promise<boolean> {
  const { client, directory, answerText } = input
  const state = readState(directory)
  const pending = state?.pendingQuestion
  if (!state || !pending?.requestId) return false
  const text = answerText.trim()
  if (!text) {
    logPoll('replyPendingQuestion: empty answer — not sending')
    return false
  }
  const answers = Array.from({ length: Math.max(1, pending.questionCount) }, () => [text])
  try {
    await withTimeout(
      (client as any).question.reply({
        requestID: pending.requestId,
        answers,
      }),
      OPENCODE_SESSION_API_TIMEOUT_MS,
      'question.reply',
    )
    clearPendingQuestion(directory)
    logPoll(`replyPendingQuestion: replied to ${pending.requestId}`)
    logRemoteControlStory({
      phase: 'inject',
      outcome: 'queued',
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      agent: AGENT_NAME,
      codename: state.codename,
      tool: 'question.reply',
      reason: 'needs_input_answer',
      data: { request_id: pending.requestId },
    })
    return true
  } catch (err) {
    logPoll(`replyPendingQuestion: failed: ${err}`)
    return false
  }
}

/**
 * Reject a pending OpenCode question (terminal dismiss / disconnect path).
 */
export async function rejectPendingQuestion(input: {
  client: Parameters<Plugin>[0]['client']
  directory: string
  reason?: string
}): Promise<void> {
  const { client, directory, reason } = input
  const state = readState(directory)
  const pending = state?.pendingQuestion
  if (!state || !pending?.requestId) return
  try {
    await withTimeout(
      (client as any).question.reject({ requestID: pending.requestId }),
      OPENCODE_SESSION_API_TIMEOUT_MS,
      'question.reject',
    )
  } catch (err) {
    logPoll(`rejectPendingQuestion: reject call failed: ${err}`)
  }
  clearPendingQuestion(directory)
  const auth = resolveDevspecAuth(directory)
  if (auth.ok && auth.token && auth.mcp_url) {
    await failOpenTrailTurn(
      auth,
      directory,
      state,
      reason ?? 'OpenCode question was dismissed before an answer arrived.',
    )
  }
}

export type BusyStallDecision =
  | { action: 'under_timeout' }
  | { action: 'has_text' }
  | { action: 'slide'; reason: 'active_tool' | 'new_assistant'; assistantId: string | null }
  | {
      action: 'stall'
      assistantId: string | null
      reason: 'permission_asked' | 'empty_assistant_timeout' | 'active_tool_cap'
    }

/**
 * Pure stall policy (unit-tested). Call only after `elapsedMs >= timeoutMs`
 * except the early `under_timeout` branch used by callers that still gate
 * on wall-clock first — and the permission-ask early path, which can stall
 * before `timeoutMs` once `permissionAskElapsedMs >= permissionAskStallMs`.
 */
export function decideBusyStall(input: {
  elapsedMs: number
  timeoutMs: number
  lastAssistant: { info?: { id?: string }; parts?: unknown } | null | undefined
  previousProgressAssistantId?: string | null
  /** Slides already granted for the current `previousProgressAssistantId` via active_tool. */
  sameAssistantActiveToolSlides?: number
  maxActiveToolSlides?: number
  /** Hung permission wait — never treated as active_tool progress. */
  permissionAskPending?: boolean
  /** ms since `permissionAskedAt` (0 if pending but clock unknown). */
  permissionAskElapsedMs?: number
  permissionAskStallMs?: number
}): BusyStallDecision {
  const lastId =
    typeof input.lastAssistant?.info?.id === 'string' && input.lastAssistant.info.id.length > 0
      ? input.lastAssistant.info.id
      : null

  if (assistantTextFromMessage(input.lastAssistant)) return { action: 'has_text' }

  const permissionPending =
    !!input.permissionAskPending || messageHasPendingPermissionAsk(input.lastAssistant)
  const askStallMs = input.permissionAskStallMs ?? PERMISSION_ASK_STALL_MS
  const askElapsed = input.permissionAskElapsedMs ?? 0

  if (permissionPending) {
    // Never slide on active_tool while a permission ask is outstanding — the
    // tool looks "running" but nothing can proceed until a human answers.
    if (askElapsed >= askStallMs) {
      return { action: 'stall', assistantId: lastId, reason: 'permission_asked' }
    }
    return { action: 'under_timeout' }
  }

  if (input.elapsedMs < input.timeoutMs) return { action: 'under_timeout' }

  if (messageHasActiveToolWork(input.lastAssistant)) {
    const prev = input.previousProgressAssistantId ?? null
    const slides = input.sameAssistantActiveToolSlides ?? 0
    const max = input.maxActiveToolSlides ?? MAX_SAME_ASSISTANT_ACTIVE_TOOL_SLIDES
    // Same stuck "running" tool forever is not progress — cap slides so keepalive
    // cannot starve poll_connection until the server idle_timeouts the bond.
    if (lastId && lastId === prev && slides >= max) {
      return { action: 'stall', assistantId: lastId, reason: 'active_tool_cap' }
    }
    return { action: 'slide', reason: 'active_tool', assistantId: lastId }
  }

  const prev = input.previousProgressAssistantId ?? null
  if (lastId && lastId !== prev) {
    return { action: 'slide', reason: 'new_assistant', assistantId: lastId }
  }

  return { action: 'stall', assistantId: lastId, reason: 'empty_assistant_timeout' }
}

/** Normalize reply text before hashing so trivial whitespace drift cannot bypass dedup. */
export function normalizePostedContent(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
}

/** Stable short hash of a reply body (used for mirror ↔ manual-post dedup). */
export function hashPostedContent(text: string): string {
  return crypto.createHash('sha256').update(normalizePostedContent(text), 'utf8').digest('hex').slice(0, 32)
}

/**
 * True when this OpenCode assistant message already invoked DevSpec's
 * `post_session_message` (any MCP name variant). Mirror must not post again.
 */
export function messageHasPostSessionMessageTool(
  message: { parts?: unknown } | null | undefined,
): boolean {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue
    const part = p as Record<string, unknown>
    const candidates = [part.tool, part.name, part.toolName, part.call]
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.toLowerCase())
    for (const name of candidates) {
      if (name === 'post_session_message' || name.endsWith('_post_session_message') || name.endsWith('/post_session_message')) {
        return true
      }
    }
    // Nested tool metadata shapes observed across OpenCode versions.
    const nested = part.tool as Record<string, unknown> | undefined
    if (nested && typeof nested === 'object') {
      const nestedName = typeof nested.name === 'string' ? nested.name.toLowerCase() : ''
      if (
        nestedName === 'post_session_message' ||
        nestedName.endsWith('_post_session_message') ||
        nestedName.endsWith('/post_session_message')
      ) {
        return true
      }
    }
  }
  return false
}

function rememberPostedContentHash(directory: string, hash: string): void {
  const state = readState(directory)
  if (!state) return
  const prev = state.recentPostedContentHashes ?? []
  if (prev.includes(hash)) return
  patchState(directory, {
    recentPostedContentHashes: [...prev, hash].slice(-40),
  })
}

/**
 * Record a successful model-initiated `post_session_message` so the auto-mirror
 * skips the same body. Wired from `tool.execute.after` in plugin.ts.
 *
 * Item 5f75c2cb / turn-scoped tool detection: `tool.execute.after` carries no
 * `messageID` (verified against the plugin's own hook signature), so this
 * cannot correlate the call back to a specific OpenCode assistant message —
 * the content-hash remembered below is the mechanical guard for that. This
 * also sets `manualAnswerPostedThisTurn`, a second, message-id-independent
 * guard scoped to "did the model post at all during THIS remote turn" —
 * `mirrorLatestReply` checks both, so a manual post cannot double up with the
 * mirror even in a shape neither the hash nor the tool-part scan catches.
 * Only set while `awaitingRemoteReply`: a manual post during a plain local
 * OpenCode turn (not remote-injected) has no turn to scope it to, and this
 * flag must never suppress an unrelated later remote turn's mirror.
 */
export function recordManualPostSessionMessage(directory: string, toolName: string, args: unknown): void {
  const lower = String(toolName ?? '').toLowerCase()
  if (
    lower !== 'post_session_message' &&
    !lower.endsWith('_post_session_message') &&
    !lower.endsWith('/post_session_message') &&
    lower !== 'devspec_post_session_message'
  ) {
    return
  }
  const argsObj = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
  const message = typeof argsObj.message === 'string' ? argsObj.message : null
  if (!message || !normalizePostedContent(message)) {
    logPoll(
      `recordManualPostSessionMessage: model called post_session_message with an empty/whitespace ` +
        `message — nothing to dedup, not recording a hash`,
    )
    return
  }
  const hash = hashPostedContent(message)
  rememberPostedContentHash(directory, hash)
  const state = readState(directory)
  if (state?.awaitingRemoteReply && !state.manualAnswerPostedThisTurn) {
    patchState(directory, { manualAnswerPostedThisTurn: true })
  }
  logPoll(
    `recordManualPostSessionMessage: remembered hash=${hash.slice(0, 8)}… ` +
      `awaitingRemoteReply=${Boolean(state?.awaitingRemoteReply)}`,
  )
}

/**
 * Spill an oversize attachment to ~/.devspec/opencode-remote-control/attachments/
 * and return a file:// URL OpenCode can open. Used when decoded size exceeds
 * INLINE_DATA_URL_MAX_BYTES but is still under MAX_ATTACHMENT_BYTES.
 */
export function materializeLargeAttachmentToDisk(input: {
  filename: string
  mime: string
  bytes: number
  buffer: Buffer
}): string | null {
  try {
    const dir = path.join(os.homedir(), '.devspec', 'opencode-remote-control', 'attachments')
    fs.mkdirSync(dir, { recursive: true })
    const safe =
      String(input.filename || 'attachment')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .slice(0, 80) || 'attachment'
    const filePath = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`)
    fs.writeFileSync(filePath, input.buffer)
    const url = pathToFileURL(filePath).href
    logPoll(
      `materializeLargeAttachmentToDisk: wrote ${input.bytes}B → ${filePath} (${input.mime})`,
    )
    return url
  } catch (err) {
    logPoll(`materializeLargeAttachmentToDisk failed: ${err}`)
    return null
  }
}

/** Prefer connection_id so the server uses the current attachment (reattach-safe). */
function postMessageArgs(
  state: ConnectionState,
  message: string,
  extras?: {
    turn_kind?: 'agent' | 'local_prompt'
    model?: { providerID: string; modelID: string }
    /** Live-trail lifecycle (items bfca2495 / 7b4090e4). Omitted = the historical answer post. */
    phase?: 'trail' | 'needs_input' | 'answer' | 'error'
    needs_input?: {
      kind: 'question' | 'permission'
      request_id: string
      prompt: string
      options?: unknown
    }
    /** End the connection's Working attempt in the same request as the bubble. */
    complete_turn?: boolean
  },
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    message,
    agent_name: AGENT_NAME,
    ...(extras?.turn_kind ? { turn_kind: extras.turn_kind } : {}),
    ...(extras?.model ? { model: extras.model } : {}),
    ...(extras?.phase ? { phase: extras.phase } : {}),
    ...(extras?.needs_input ? { needs_input: extras.needs_input } : {}),
    ...(extras?.complete_turn ? { complete_turn: true } : {}),
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
      timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
    })
  } catch (err) {
    logPoll(`postSessionNotice failed: ${err}`)
  }
}

/**
 * If we've been busy longer than STALL_TIMEOUT_MS with no observable progress
 * (no reply text, no new assistant step, no in-flight tool), clear busy and
 * warn in the DevSpec session. Healthy tool-heavy turns slide `busySince`
 * instead of false-stalling. A pending `permission.asked` is NOT progress —
 * it never slides and stalls after PERMISSION_ASK_STALL_MS. Called every poll
 * while busy.
 */
export async function checkBusyStall(
  client: Parameters<Plugin>[0]['client'],
  directory: string,
  sessionId: string,
): Promise<void> {
  const auth = resolveDevspecAuth(directory)
  let state = readState(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state?.busy || !state.sessionId) return

  // Waiting on a DevSpec-surfaced OpenCode question is not a stall — the human
  // may answer from phone/web minutes later (item 7b4090e4).
  if (state.pendingQuestion?.requestId) {
    logPoll(
      `stall check: pending question ${state.pendingQuestion.requestId} — waiting on owner, not stalling`,
    )
    return
  }

  // Older state files may have busy:true with no busySince — seed now so we
  // don't immediately treat a mid-flight upgrade as already timed out.
  if (!state.busySince) {
    patchState(directory, { busySince: Date.now() })
    logPoll(`stall check: seeded busySince for pre-existing busy=true`)
    return
  }

  const elapsed = Date.now() - state.busySince
  const permissionPendingFromState = !!state.permissionAskedPending
  const permissionAskElapsed =
    state.permissionAskedAt != null ? Date.now() - state.permissionAskedAt : 0
  const mayPermissionStallEarly =
    permissionPendingFromState && permissionAskElapsed >= PERMISSION_ASK_STALL_MS

  if (!mayPermissionStallEarly && elapsed < STALL_TIMEOUT_MS) {
    logPoll(
      `stall check: busy ${elapsed}ms (< ${STALL_TIMEOUT_MS}ms)` +
        (permissionPendingFromState
          ? ` permission_ask ${permissionAskElapsed}ms (< ${PERMISSION_ASK_STALL_MS}ms)`
          : '') +
        ' — ok',
    )
    return
  }

  let messages: any[]
  try {
    const res: any = await withTimeout(
      (client as any).session.messages({ path: { id: sessionId } }),
      OPENCODE_SESSION_API_TIMEOUT_MS,
      'session.messages(stall)',
    )
    messages = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  } catch (err) {
    logPoll(`stall check: client.session.messages failed: ${err}`)
    return
  }

  const assistantMessages = messages.filter((m) => m?.info?.role === 'assistant')
  // Item 40279ae0: scope progress to assistants AFTER the pre-inject baseline,
  // not the global last assistant. The old global-last version had a real bug:
  // a freshly-injected turn's stall check could see the PRE-inject assistant's
  // old text — from a completely different, already-answered turn — and report
  // "last assistant has text — not a stall" even though THIS turn had produced
  // nothing at all yet. Mirrors the same correlation `mirrorLatestReply` uses.
  const baselineDecision = decideAwaitingBaseline({
    baseline: state.replyAfterOpenCodeMessageId ?? null,
    baselineCaptured: state.replyBaselineCaptured,
    assistantIds: assistantMessages.map((m) => m?.info?.id).filter(Boolean) as string[],
  })
  if (baselineDecision.action === 'clear_abandoned') {
    // The pre-inject baseline id is gone from the current OpenCode session
    // (session rotated under an abandoned turn — 8d0f1726). There is nothing
    // to evaluate progress against; recover immediately instead of waiting
    // out the stall timeout on a cursor that can never resolve.
    clearAbandonedInjectCursor(directory, baselineDecision.baseline)
    clearInjectTurnState(directory, { unclaim: true })
    logPoll(
      `stall check: abandoned inject cursor (baseline ${baselineDecision.baseline} not in current ` +
        `session) — cleared busy/awaiting immediately`,
    )
    return
  }
  const scopedAssistants = scopeAssistantsAfterBaseline(assistantMessages, baselineDecision)
  const last = scopedAssistants[scopedAssistants.length - 1]
  const fromMessage = messageHasPendingPermissionAsk(last)
  const permissionAskPending = permissionPendingFromState || fromMessage
  // Late message-only detection (no event): treat the ask window as already
  // elapsed so we stall instead of sliding active_tool into another 2+ minutes.
  const permissionAskElapsedMs =
    state.permissionAskedAt != null
      ? Date.now() - state.permissionAskedAt
      : fromMessage && !permissionPendingFromState
        ? PERMISSION_ASK_STALL_MS
        : permissionPendingFromState
          ? permissionAskElapsed
          : 0

  if (fromMessage && !permissionPendingFromState) {
    patchState(directory, {
      permissionAskedPending: true,
      permissionAskedAt: state.permissionAskedAt ?? Date.now() - PERMISSION_ASK_STALL_MS,
    })
    state = readState(directory) ?? state
  }

  const decision = decideBusyStall({
    elapsedMs: elapsed,
    timeoutMs: STALL_TIMEOUT_MS,
    lastAssistant: last,
    previousProgressAssistantId: state.stallProgressAssistantId,
    sameAssistantActiveToolSlides: state.stallActiveToolSlides ?? 0,
    maxActiveToolSlides: MAX_SAME_ASSISTANT_ACTIVE_TOOL_SLIDES,
    permissionAskPending,
    permissionAskElapsedMs,
    permissionAskStallMs: PERMISSION_ASK_STALL_MS,
  })

  if (decision.action === 'has_text') {
    logPoll(
      `stall check: busy ${elapsed}ms but last assistant (${last?.info?.id}) has text — not a stall`,
    )
    return
  }

  if (decision.action === 'under_timeout') {
    logPoll(
      `stall check: under_timeout` +
        (permissionAskPending
          ? ` (permission ask ${permissionAskElapsedMs}ms / ${PERMISSION_ASK_STALL_MS}ms)`
          : ` (busy ${elapsed}ms)`),
    )
    return
  }

  if (decision.action === 'slide') {
    const now = Date.now()
    const sameAssistant =
      decision.reason === 'active_tool' &&
      decision.assistantId != null &&
      decision.assistantId === (state.stallProgressAssistantId ?? null)
    const nextSlides = decision.reason === 'active_tool' ? (sameAssistant ? (state.stallActiveToolSlides ?? 0) + 1 : 1) : 0
    patchState(directory, {
      busySince: now,
      stallProgressAssistantId: decision.assistantId,
      stallActiveToolSlides: nextSlides,
    })
    logPoll(
      `stall check: progress (${decision.reason}) on ${decision.assistantId ?? 'none'} — slid busySince after ${elapsed}ms` +
        (decision.reason === 'active_tool' ? ` (active_tool slides=${nextSlides})` : ''),
    )
    return
  }

  if (decision.action !== 'stall') return

  if (state.stallWarnedAt === state.busySince) {
    logPoll(`stall check: already warned for busySince=${state.busySince} — clearing busy again`)
    await setBusy(directory, false)
    return
  }

  const lastId = decision.assistantId ?? 'none'
  const stallReason = decision.reason
  logPoll(
    `STALL: busy ${elapsed}ms reason=${stallReason} (last.id=${lastId}) — clearing busy and posting warning`,
  )
  logRemoteControlStory({
    phase: 'stall',
    outcome: 'stalled',
    connectionId: state.connectionId,
    sessionId: state.sessionId,
    agent: AGENT_NAME,
    codename: state.codename,
    tool: 'checkBusyStall',
    reason: stallReason,
    data: {
      elapsed_ms: elapsed,
      stall_timeout_ms: STALL_TIMEOUT_MS,
      permission_ask_elapsed_ms: permissionAskPending ? permissionAskElapsedMs : undefined,
      permission_ask_stall_ms: PERMISSION_ASK_STALL_MS,
      last_id: lastId,
    },
  })
  patchState(directory, { stallWarnedAt: state.busySince })
  const notice =
    stallReason === 'permission_asked'
      ? `⚠️ OpenCode turn stalled after a hung permission ask ` +
        `(~${Math.round((permissionAskElapsedMs || elapsed) / 1000)}s; assistant \`${lastId}\`). ` +
        `Cleared the busy indicator — approve/deny the permission in the TUI or check ` +
        `~/.devspec/opencode-remote-control/poll.log.`
      : `⚠️ OpenCode turn stalled after ${Math.round(elapsed / 1000)}s with no reply text ` +
        `(assistant message \`${lastId}\`). Cleared the busy indicator — check ` +
        `~/.devspec/opencode-remote-control/poll.log if this keeps happening.`
  // A stall is exactly the case a live trail bubble cannot survive: the turn is
  // over and no answer is coming, so failing the open bubble (which keeps the
  // trail readable under error chrome) says more than a separate notice under a
  // turn still claiming to stream. Fall back to the notice when none is open.
  const failedTrail = await failOpenTrailTurn(auth, directory, readState(directory) ?? state, notice)
  if (!failedTrail) await postSessionNotice(auth, state, notice)
  // Item 40279ae0: this IS the abnormal end — unclaim this turn's command ids
  // from `deliveredMessageIds` so they are eligible to re-inject, breaking the
  // seedKept>0/inject=0 hold loop a stalled-but-never-answered command used to
  // cause. `failOpenTrailTurn` above already cleared the non-unclaiming parts
  // of inject-turn state; this call additionally unclaims.
  clearInjectTurnState(directory, { unclaim: true })
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
    const notice = `⚠️ OpenCode reported \`session.error\`. Busy cleared. Detail: ${detail}`
    // Same reasoning as the stall path: close the open live-trail bubble as
    // failed so it stops streaming, keeping the trail visible; only post a
    // standalone notice when this turn never opened one.
    const failedTrail = await failOpenTrailTurn(auth, directory, state, notice)
    if (!failedTrail) await postSessionNotice(auth, state, notice)
  }
  // Item 40279ae0: a session.error is an abnormal end for whatever turn was
  // in flight — unclaim its command ids so they can re-inject instead of
  // being silently swallowed forever by the delivery dedup set.
  clearInjectTurnState(directory, { unclaim: true })
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
 * Per-async-context override of `boundSessionId`. Multi-bond (item 7a9b7b0f):
 * one OpenCode process can drive several DevSpec connections; each poll /
 * inject / mirror must read and write THAT bond's state file even when
 * another bond's work is in flight on the same event loop.
 *
 * `undefined` store = not inside `runWithBoundSession` → fall back to the
 * process-global `boundSessionId`. An explicit `null` store means folder-only
 * state (sessionless bond).
 */
const boundSessionAls = new AsyncLocalStorage<string | null>()

function effectiveBoundSessionId(): string | null {
  const fromAls = boundSessionAls.getStore()
  return fromAls === undefined ? boundSessionId : fromAls
}

/** Run `fn` with state reads/writes scoped to `stateKey` (DevSpec session id or null). */
export function runWithBoundSession<T>(stateKey: string | null, fn: () => T): T {
  return boundSessionAls.run(stateKey, fn)
}

export async function runWithBoundSessionAsync<T>(
  stateKey: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return boundSessionAls.run(stateKey, fn)
}

/**
 * OpenCode session id → DevSpec state-file key (session UUID, or null for
 * folder-only / sessionless). The pump iterates this map so a second
 * `/devspec.remote` ADDS a bond instead of overwriting a single pin
 * (Ivory Panda idle_timeout when Racing Dolphin attached — 2026-08-07).
 */
const openCodeBonds = new Map<string, string | null>()

export function rememberOpenCodeBond(opencodeSessionId: string, stateKey: string | null): void {
  if (!opencodeSessionId) return
  openCodeBonds.set(opencodeSessionId, stateKey)
  logPoll(
    `bond remember opencodeSession=${opencodeSessionId} stateKey=${stateKey ?? '(folder-only)'} ` +
      `(active=${openCodeBonds.size})`,
  )
}

export function forgetOpenCodeBond(opencodeSessionId: string): void {
  if (!opencodeSessionId) return
  if (!openCodeBonds.delete(opencodeSessionId)) return
  logPoll(`bond forget opencodeSession=${opencodeSessionId} (active=${openCodeBonds.size})`)
}

export function listOpenCodeBondSessions(): string[] {
  return [...openCodeBonds.keys()]
}

/**
 * Whether OpenCode's `permission.ask` hook should auto-allow.
 *
 * Cold-launch `opencode run --auto` only covers the first connect turn.
 * Later owner commands are injected via `promptAsync` into the live session,
 * so they never inherit `--auto`. Live stall 2026-08-10 (session 1187956b):
 * `external_directory` for `~/.config/opencode` got `permission.asked` with
 * no `permission.replied`, then hung until empty_assistant_timeout ~131s.
 *
 * While any DevSpec remote-control bond is active in this process, auto-allow
 * — that is the unattended equivalent of Claude/Cursor yolo for remote turns.
 * Plain interactive TUI with no `/devspec.remote` bond still prompts.
 */
export function shouldAutoAllowRemoteControlPermission(): boolean {
  return listOpenCodeBondSessions().length > 0
}

export function stateKeyForOpenCodeBond(opencodeSessionId: string): string | null | undefined {
  if (!openCodeBonds.has(opencodeSessionId)) return undefined
  return openCodeBonds.get(opencodeSessionId)
}

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
 *
 * `sessionKey` overrides the process-global bind for read/migrate paths:
 * `null` = folder-only file; a string = that session id's scoped file.
 */
function stateFileForKey(directory: string, sessionKey: string | null): string {
  const base = path.resolve(directory)
  const raw = sessionKey ? `${base}:${sessionKey}` : base
  const key = hashKey(raw)
  const dir = path.join(os.homedir(), '.devspec', 'opencode-remote-control')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${key}.json`)
}

function stateFile(directory: string): string {
  return stateFileForKey(directory, effectiveBoundSessionId())
}

function readStateAtKey(directory: string, sessionKey: string | null): ConnectionState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFileForKey(directory, sessionKey), 'utf8'))
  } catch {
    return null
  }
}

function unlinkStateAtKey(directory: string, sessionKey: string | null): void {
  try {
    fs.unlinkSync(stateFileForKey(directory, sessionKey))
  } catch {
    /* already gone */
  }
}

function unionIds(a?: string[] | null, b?: string[] | null): string[] | undefined {
  if (!a?.length && !b?.length) return a ?? b ?? undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of [...(a ?? []), ...(b ?? [])]) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Merge two connection-state snapshots. `primary` wins on scalar conflicts;
 * list fields are unioned. When either side is mid-inject (`awaitingRemoteReply`),
 * that side's baseline fields win so a key flip cannot drop the inject cursor.
 */
export function mergeConnectionStates(
  primary: ConnectionState | null | undefined,
  secondary: ConnectionState | null | undefined,
): ConnectionState | null {
  if (!primary && !secondary) return null
  if (!primary) return { ...secondary! }
  if (!secondary) return { ...primary }
  const awaiting = Boolean(primary.awaitingRemoteReply || secondary.awaitingRemoteReply)
  const awaitingPrimary = primary.awaitingRemoteReply
    ? primary
    : secondary.awaitingRemoteReply
      ? secondary
      : primary
  return {
    ...secondary,
    ...primary,
    deliveredMessageIds: unionIds(secondary.deliveredMessageIds, primary.deliveredMessageIds),
    deliveredAssignmentIds: unionIds(secondary.deliveredAssignmentIds, primary.deliveredAssignmentIds),
    mirroredMessageIds: unionIds(secondary.mirroredMessageIds, primary.mirroredMessageIds),
    recentPostedContentHashes: unionIds(
      secondary.recentPostedContentHashes,
      primary.recentPostedContentHashes,
    ),
    nonMirrorMessageIds: unionIds(secondary.nonMirrorMessageIds, primary.nonMirrorMessageIds),
    awaitingRemoteReply: awaiting,
    replyAfterOpenCodeMessageId: awaiting
      ? awaitingPrimary.replyAfterOpenCodeMessageId
      : (primary.replyAfterOpenCodeMessageId ?? secondary.replyAfterOpenCodeMessageId),
    replyBaselineCaptured: awaiting
      ? awaitingPrimary.replyBaselineCaptured
      : (primary.replyBaselineCaptured ?? secondary.replyBaselineCaptured),
    busy: Boolean(primary.busy || secondary.busy),
    busySince: primary.busy
      ? (primary.busySince ?? null)
      : (primary.busySince ?? secondary.busySince ?? null),
    stallWarnedAt: primary.stallWarnedAt ?? secondary.stallWarnedAt ?? null,
    permissionAskedPending: Boolean(
      primary.permissionAskedPending || secondary.permissionAskedPending,
    ),
    // Keep the earliest ask clock so a merge cannot reset the early-stall window.
    permissionAskedAt: (() => {
      const a = primary.permissionAskedAt ?? null
      const b = secondary.permissionAskedAt ?? null
      if (a == null) return b
      if (b == null) return a
      return Math.min(a, b)
    })(),
    connectMirrorSuppressed: Boolean(
      primary.connectMirrorSuppressed || secondary.connectMirrorSuppressed,
    ),
  }
}

function foldConnectionStates(states: Array<ConnectionState | null | undefined>): ConnectionState | null {
  let acc: ConnectionState | null = null
  for (const s of states) {
    if (!s) continue
    if (!acc) {
      acc = { ...s }
      continue
    }
    // Prefer the awaiting snapshot as primary so inject cursors survive bind.
    acc =
      s.awaitingRemoteReply && !acc.awaitingRemoteReply
        ? mergeConnectionStates(s, acc)
        : mergeConnectionStates(acc, s)
  }
  return acc
}

/**
 * Flip `boundSessionId` to `sessionId` and migrate every prior key that may
 * hold live remote-control state into the canonical session-scoped file.
 *
 * Live bug (d5efd533 / Fierce Eagle): seed inject wrote `awaitingRemoteReply`
 * on the folder-only file; mid-turn `attach_connection` rebound to the full
 * UUID file without migrating — mirror then connect-skip-claimed the answer.
 * Comments already claimed this migration existed; it did not.
 */
export function bindSessionState(
  directory: string,
  sessionId: string,
  patch: Partial<ConnectionState> = {},
): ConnectionState {
  const donorKeys = new Set<string | null>([boundSessionId])
  // Always consider the folder-only scratch file (register + pre-bind inject).
  donorKeys.add(null)
  // Short 8-char prefix — `devspec.remote.md` / attach args often use this.
  if (sessionId.length > 8) donorKeys.add(sessionId.slice(0, 8))
  if (boundSessionId && boundSessionId.length > 8) {
    donorKeys.add(boundSessionId.slice(0, 8))
  }

  const donors: Array<ConnectionState | null> = []
  for (const key of donorKeys) {
    donors.push(readStateAtKey(directory, key))
  }

  const destBefore = readStateAtKey(directory, sessionId)
  const firstSessionBind = !destBefore?.sessionId
  donors.push(destBefore)

  const folded = foldConnectionStates(donors)
  if (!folded && !patch.connectionId) {
    throw new Error('bindSessionState: no connection state to migrate')
  }

  boundSessionId = sessionId
  const connectionId = patch.connectionId ?? folded?.connectionId
  if (!connectionId) {
    throw new Error('bindSessionState: connectionId required')
  }

  const next: ConnectionState = {
    ...(folded ?? { connectionId, sessionId: null, codename: null }),
    ...patch,
    connectionId,
    sessionId,
    codename:
      patch.codename !== undefined
        ? patch.codename
        : (folded?.codename ?? null),
    // Re-apply awaiting merge after patch so an identity-only patch cannot
    // clobber an in-flight inject cursor carried from a donor key.
    awaitingRemoteReply: Boolean(
      patch.awaitingRemoteReply ?? folded?.awaitingRemoteReply,
    ),
    replyAfterOpenCodeMessageId:
      folded?.awaitingRemoteReply || patch.awaitingRemoteReply
        ? (patch.replyAfterOpenCodeMessageId ?? folded?.replyAfterOpenCodeMessageId)
        : (patch.replyAfterOpenCodeMessageId !== undefined
            ? patch.replyAfterOpenCodeMessageId
            : folded?.replyAfterOpenCodeMessageId),
    replyBaselineCaptured:
      folded?.awaitingRemoteReply || patch.awaitingRemoteReply
        ? (patch.replyBaselineCaptured ?? folded?.replyBaselineCaptured)
        : (patch.replyBaselineCaptured !== undefined
            ? patch.replyBaselineCaptured
            : folded?.replyBaselineCaptured),
    connectMirrorSuppressed: firstSessionBind
      ? true
      : (patch.connectMirrorSuppressed ?? folded?.connectMirrorSuppressed),
  }

  writeState(directory, next)

  // Drop donor files that are no longer the canonical key so the next cold
  // launch cannot resume a stale folder-only snapshot beside the real one.
  for (const key of donorKeys) {
    if (key === sessionId) continue
    const donorPath = stateFileForKey(directory, key)
    const destPath = stateFileForKey(directory, sessionId)
    if (donorPath === destPath) continue
    unlinkStateAtKey(directory, key)
  }

  return next
}

/** Test helper — reset the process-global session bind between cases. */
export function resetBoundSessionIdForTests(): void {
  boundSessionId = null
  openCodeBonds.clear()
}

/** Exported for regression tests (item 67794386) — prefer patchState in production paths. */
export function readState(directory: string): ConnectionState | null {
  return readStateAtKey(directory, effectiveBoundSessionId())
}

/**
 * Full replace of the on-disk state file. Only safe for handshake / clear paths
 * that intentionally own the whole snapshot. Mid-tick poll updates MUST use
 * patchState — a stale `writeState({ ...inMemory })` rolls back concurrent
 * mirror claims (live: session f3af591e double-posted msg_fc80605c).
 */
export function writeState(directory: string, state: ConnectionState): void {
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
 *
 * Regression (67794386 / f3af591e): pollAndDeliver still used writeState with
 * a stale in-memory spread for cursor / delivered-ids / inject-baseline; the
 * advisory echo of a just-mirrored reply then re-mirrored the same OpenCode
 * message. Every mid-tick persistence must go through this helper.
 */
export function patchState(directory: string, patch: Partial<ConnectionState>): ConnectionState | null {
  const current = readState(directory)
  if (!current) return null
  const next = { ...current, ...patch }
  writeState(directory, next)
  return next
}

function clearState(directory: string): void {
  unlinkStateAtKey(directory, boundSessionId)
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
  opencodeSessionId?: string | null,
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
    // folder-only file, same as a bare connection. Attach migrates the full
    // snapshot into the session-scoped file via bindSessionState.
    const existing = readState(directory)
    const connectionId = typeof result?.connection_id === 'string' ? result.connection_id : existing?.connectionId
    if (!connectionId) return
    if (existing) {
      // Preserve awaiting/busy/baseline — a register that races an inject
      // must not wipe the inject cursor (hand-picked writeState used to).
      patchState(directory, {
        connectionId,
        codename: typeof result?.codename === 'string' ? result.codename : existing.codename,
        connectMirrorSuppressed: true,
      })
    } else {
      writeState(directory, {
        connectionId,
        sessionId: null,
        codename: typeof result?.codename === 'string' ? result.codename : null,
        connectMirrorSuppressed: true,
      })
    }
    // Sessionless (or pre-attach) bond: folder-only state key. A later attach
    // in this OpenCode session upgrades the key — rememberOpenCodeBond again.
    if (opencodeSessionId) rememberOpenCodeBond(opencodeSessionId, boundSessionId)
    return
  }

  // Attach: connection_id/session_id may come back on the result, or only be
  // present on the call's own args (DevSpec's attach_connection echoes both,
  // but don't assume — fall back to what the model was called with). Prefer
  // the server's full UUID over a short prefix in args (ce0dab86).
  const sessionId =
    typeof result?.session_id === 'string'
      ? result.session_id
      : typeof argsObj.session_id === 'string'
        ? (argsObj.session_id as string)
        : null
  if (!sessionId) return

  const connectionIdHint =
    typeof result?.connection_id === 'string'
      ? result.connection_id
      : typeof argsObj.connection_id === 'string'
        ? (argsObj.connection_id as string)
        : undefined

  // Migrate folder-only / short-prefix inject state into the canonical
  // session-scoped file BEFORE any further mirror decision (d5efd533).
  const prior = readState(directory)
  const connectionId = connectionIdHint ?? prior?.connectionId
  if (!connectionId) return

  bindSessionState(directory, sessionId, {
    connectionId,
    codename: prior?.codename ?? null,
  })
  if (opencodeSessionId) rememberOpenCodeBond(opencodeSessionId, sessionId)
}

/**
 * Record an OpenCode `command.executed` for `/devspec.remote` /
 * `/devspec.remote-stop` so mirrorLatestReply never posts that assistant turn.
 *
 * While `awaitingRemoteReply` is set, ignore the event: OpenCode has been
 * observed to fire a late `devspec.remote` command.executed against the
 * *post-inject answer* message id (session 8a97effc). Recording that id would
 * poison nonMirrorMessageIds and skip-mirror the real reply.
 */
export function recordRemoteControlSkillCommand(
  directory: string,
  props: Record<string, unknown> | null | undefined,
): void {
  if (!props) return
  if (!isDevspecRemoteControlCommand(props.name)) return
  const messageId = typeof props.messageID === 'string' ? props.messageID : null
  if (!messageId) return
  const existing = readState(directory)
  if (!existing) return
  if (existing.awaitingRemoteReply) {
    logPoll(
      `recordRemoteControlSkillCommand: ignore id=${messageId} name=${props.name} (awaitingRemoteReply)`,
    )
    return
  }
  const ids = new Set(existing.nonMirrorMessageIds ?? [])
  if (ids.has(messageId)) return
  ids.add(messageId)
  patchState(directory, {
    nonMirrorMessageIds: Array.from(ids).slice(-50),
  })
  logPoll(`recordRemoteControlSkillCommand: skip-mirror id=${messageId} name=${props.name}`)
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

  if (sessionId && sessionId !== boundSessionId) {
    const existingAnywhere =
      readState(directory) ??
      readStateAtKey(directory, null) ??
      (sessionId.length > 8 ? readStateAtKey(directory, sessionId.slice(0, 8)) : null) ??
      readStateAtKey(directory, sessionId)
    if (existingAnywhere?.connectionId) {
      return {
        auth,
        state: bindSessionState(directory, sessionId, {
          connectionId: existingAnywhere.connectionId,
          codename: existingAnywhere.codename,
        }),
      }
    }
    boundSessionId = sessionId
  } else if (sessionId) {
    boundSessionId = sessionId
  }
  const existing = readState(directory)
  if (existing) return { auth, state: existing }

  const base = path.resolve(directory)
  const localId = hashKey(sessionId ? `${base}:${sessionId}` : base)
  const result: any = await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'register_connection',
    arguments: { local_id: localId, agent_name: AGENT_NAME, cwd: directory },
    timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
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
  const result: any = await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'attach_connection',
    arguments: { connection_id: state.connectionId, session_id: sessionId },
    timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
  })
  const canonicalSessionId =
    typeof result?.session_id === 'string' ? result.session_id : sessionId
  bindSessionState(directory, canonicalSessionId, {
    connectionId: state.connectionId,
    codename: state.codename,
  })
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
      timeoutMs: MCP_HEARTBEAT_TIMEOUT_MS,
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
 * How many consecutive poll failures before a recoverable gateway blip is posted
 * into the room. A single MCP HTTP 502 during a Coolify swap is normal and the
 * pump already retries — posting on attempt 1 made owners think the bond died
 * (session b088b9a6 / Brave Osprey, 2026-08-08). Auth and other hard failures
 * still report on the first hit.
 */
export const POLL_ERROR_REPORT_AFTER_TRANSIENT = 3

/** True for gateway / redeploy-shaped MCP transport errors the pump already retries. */
export function isTransientMcpGatewayError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /MCP HTTP 50[234]\b/i.test(message) || /\bBad Gateway\b/i.test(message)
}

/**
 * Whether a poll failure should be mirrored into the DevSpec room.
 * Transient 5xx waits until `POLL_ERROR_REPORT_AFTER_TRANSIENT` consecutive
 * failures; everything else reports immediately (still cooldown-deduped).
 */
export function shouldReportPollErrorToRoom(
  consecutiveErrors: number,
  err: unknown,
): boolean {
  if (consecutiveErrors < 1) return false
  if (isTransientMcpGatewayError(err)) {
    return consecutiveErrors >= POLL_ERROR_REPORT_AFTER_TRANSIENT
  }
  return true
}

/** Room-facing copy for a poll failure (softer for recoverable gateway blips). */
export function formatPollErrorRoomMessage(stage: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (isTransientMcpGatewayError(err)) {
    return (
      `DevSpec briefly unreachable at \`${stage}\` (${message}). ` +
      `Usually a redeploy — the bond is still retrying, not ended.`
    )
  }
  return `⚠️ Remote-control poll failed at \`${stage}\`: ${message}`
}

/**
 * Post a poll failure back into the DevSpec session so it's diagnosable from
 * the owner's side, not just the machine's own (usually inaccessible) logs.
 *
 * Real gap found live-testing: `pollAndDeliver`'s heartbeat/transcript-fetch
 * failures were caught-and-swallowed with zero trace anywhere — a dispatched
 * message could sit as "waiting for pickup" forever with no way for the
 * owner (or anyone debugging remotely) to tell whether delivery was merely
 * slow or the whole poll loop was silently broken.
 *
 * Transient MCP 502/503/504 blips (Coolify swap) must NOT scream into the room
 * on the first recovered attempt — see `shouldReportPollErrorToRoom`.
 */
async function reportPollError(
  auth: ReturnType<typeof resolveDevspecAuth>,
  directory: string,
  state: ConnectionState | null,
  stage: string,
  err: unknown,
  consecutiveErrors: number,
): Promise<void> {
  if (!auth.ok || !auth.token || !auth.mcp_url || !state?.sessionId) return
  if (!shouldReportPollErrorToRoom(consecutiveErrors, err)) return
  const message = err instanceof Error ? err.message : String(err)
  const key = `${directory}:${stage}`
  const prior = lastPollErrorReports.get(key)
  if (prior && prior.message === message && Date.now() - prior.at < POLL_ERROR_REPORT_COOLDOWN_MS) return
  lastPollErrorReports.set(key, { message, at: Date.now() })

  await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'post_session_message',
    arguments: postMessageArgs(state, formatPollErrorRoomMessage(stage, err), {
      turn_kind: 'agent',
    }),
    timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
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

/** Epoch ms of last successful `poll_connection` per connection (presence breadcrumb). */
const lastSuccessfulPollAt = new Map<string, number>()
/** Cooldown so presence_gap stories do not spam every tick. */
const lastPresenceGapWarnedAt = new Map<string, number>()

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
  lastSuccessfulPollAt.delete(connectionId)
  lastPresenceGapWarnedAt.delete(connectionId)
}

/** Test/helpers: last successful poll timestamp for a connection, or null. */
export function getLastSuccessfulPollAt(connectionId: string): number | null {
  return lastSuccessfulPollAt.get(connectionId) ?? null
}

export function recordSuccessfulPoll(connectionId: string, at: number = Date.now()): void {
  lastSuccessfulPollAt.set(connectionId, at)
}

/**
 * Emit a presence_gap story when the pump has gone too long without a successful
 * poll while the bond should still look live. Returns true if a warning was logged.
 */
export function maybeWarnPresenceGap(input: {
  connectionId: string
  sessionId?: string | null
  codename?: string | null
  busy?: boolean
  now?: number
  gapWarnMs?: number
}): boolean {
  const now = input.now ?? Date.now()
  const last = lastSuccessfulPollAt.get(input.connectionId)
  if (last == null) return false
  const age = now - last
  const gapMs = input.gapWarnMs ?? PRESENCE_GAP_WARN_MS
  if (age < gapMs) return false
  const prevWarn = lastPresenceGapWarnedAt.get(input.connectionId) ?? 0
  if (now - prevWarn < PRESENCE_GAP_WARN_COOLDOWN_MS) return false
  lastPresenceGapWarnedAt.set(input.connectionId, now)
  logRemoteControlStory({
    phase: 'poll_error',
    outcome: 'presence_gap',
    reason: input.busy ? 'no_poll_since_pickup' : 'no_poll_while_attached',
    connectionId: input.connectionId,
    sessionId: input.sessionId ?? null,
    agent: AGENT_NAME,
    codename: input.codename ?? null,
    tool: 'poll_connection',
    data: {
      last_poll_age_ms: age,
      busy: input.busy === true,
      gap_warn_ms: gapMs,
    },
  })
  return true
}

export function logConnectionEndedStory(input: {
  connectionId: string
  sessionId?: string | null
  codename?: string | null
  endReason: string
  via: string
  busy?: boolean
  now?: number
}): void {
  const now = input.now ?? Date.now()
  const last = lastSuccessfulPollAt.get(input.connectionId)
  const lastPollAgeMs = last != null ? now - last : null
  logRemoteControlStory({
    phase: 'ended',
    outcome: 'server_ended',
    reason: input.endReason,
    connectionId: input.connectionId,
    sessionId: input.sessionId ?? null,
    agent: AGENT_NAME,
    codename: input.codename ?? null,
    tool: 'poll_connection',
    data: {
      last_poll_age_ms: lastPollAgeMs,
      busy: input.busy === true,
      via: input.via,
    },
  })
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
 * Wake text for a playbook_run dispatch. Must NOT send the agent down the
 * assignment protocol — wrong tools, and a look-only playbook would lose its
 * permission line. Keep in step with Cursor's playbookRunCommandText.
 *
 * Always pass provider on claim (hard match against preferred_provider). Omitting
 * it fails even when this agent is the named one — same habit as claim_work_item.
 */
function playbookRunCommandText(d: Record<string, unknown>): string {
  const permission =
    d.permission === 'can_push'
      ? 'You MAY edit, commit and push.'
      : d.permission === 'can_commit'
        ? 'You MAY edit and commit locally, but MUST NOT push.'
        : 'This playbook is LOOK ONLY — investigate and report, do not edit, commit or push anything.'

  const runId = typeof d.run_id === 'string' ? d.run_id : String(d.id ?? '')
  const name = typeof d.playbook_name === 'string' ? d.playbook_name : 'playbook'

  return [
    `▶️ Playbook run dispatched to this connection: "${name}" (run ${runId}).`,
    '',
    'What to do:',
    `1. claim_playbook_run({ run_id: "${runId}", provider: "opencode" }) — always pass provider (and model if the playbook names one). If claimed:false the run was already taken by another of your agents, which is normal; stop there.`,
    '2. Do the work described below, in this repo.',
    '3. record_playbook_run — report status, a verdict for EACH acceptance criterion WITH evidence, and whatever the run produced as artifacts.',
    '',
    `Permission: ${permission}`,
    '',
    'The instruction:',
    typeof d.instruction === 'string' && d.instruction.trim()
      ? d.instruction
      : '(claim the run to read it)',
  ].join('\n')
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
/**
 * One-shot latch for the "bond exists but auth is unresolvable" log line in
 * pollAndDeliver. That state is ALWAYS a bug (as opposed to no state file at
 * all, which just means `/devspec.remote` was never run) — yet the idle path
 * below costs no network calls precisely so it can burn forever without a
 * trace, which is exactly how the .jsonc resolver bug (item 8e0bb031) hid for
 * an entire session. Log once per failure streak, never every 5s.
 */
let authFailureLogged = false

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
    if (state && (!auth.ok || !auth.token || !auth.mcp_url)) {
      if (!authFailureLogged) {
        authFailureLogged = true
        logPoll(
          `poll idle: connection state exists (${state.codename ?? state.connectionId ?? 'unknown'}) ` +
            `but DevSpec auth is unresolvable — no polls until fixed: ${auth.error ?? 'incomplete config'}`,
        )
      }
    } else {
      authFailureLogged = false
    }
    return { delayMs: 5_000, stop: false }
  }
  authFailureLogged = false

  const pump = pumpStateFor(state.connectionId, {
    cursor: state.lastDeliveredMessageId ?? null,
    dispatchIds: state.deliveredAssignmentIds ?? [],
  })
  const turnActive = state.busy === true
  const hold = holdFor({ attached: !!state.sessionId, turnActive })

  // While a turn genuinely runs, keep the activity lease alive. Stall detection
  // must NOT sit on the critical path ahead of poll_connection — a hung
  // session.messages call there freezes last_seen until idle_timeout (875d75b5).
  if (turnActive) {
    await reportActivity(directory, 'keepalive')
    void checkBusyStall(client, directory, sessionId).catch((err) => {
      logPoll(`checkBusyStall (async) failed: ${err}`)
    })
    maybeWarnPresenceGap({
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      codename: state.codename,
      busy: true,
    })
    state = readState(directory) ?? state
  } else if (state.sessionId) {
    maybeWarnPresenceGap({
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      codename: state.codename,
      busy: false,
    })
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
    recordSuccessfulPoll(state.connectionId)
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
    await reportPollError(auth, directory, state, 'poll_connection', err, pump.consecutiveErrors)
    logPoll(`poll_connection failed (${pump.consecutiveErrors}) — retrying in ${backoff}ms: ${err}`)
    logRemoteControlStory({
      phase: 'poll_error',
      outcome: 'error',
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      agent: AGENT_NAME,
      codename: state.codename,
      tool: 'poll_connection',
      reason: rateLimited ? 'rate_limited' : 'poll_failed',
      data: { consecutiveErrors: pump.consecutiveErrors, backoff_ms: backoff },
    })
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
    logConnectionEndedStory({
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      codename: state.codename,
      endReason: label,
      via: 'recoverable_exhausted',
      busy: state.busy === true,
    })
    await setBusy(directory, false).catch(() => {})
    forgetPumpState(state.connectionId)
    forgetOpenCodeBond(sessionId)
    return { delayMs: 0, stop: true, reason: terminal.reason ?? 'server_ended' }
  }
  if (terminal) {
    // A deliberate human end ('ui' / 'local_stop'). This one must stick.
    const reason = terminal.reason ?? 'ended_from_ui'
    logPoll(`connection ended (${reason}) — dropping this bond; other bonds keep polling`)
    logConnectionEndedStory({
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      codename: state.codename,
      endReason: reason,
      via: 'deliberate_end',
      busy: state.busy === true,
    })
    await setBusy(directory, false).catch(() => {})
    forgetPumpState(state.connectionId)
    forgetOpenCodeBond(sessionId)
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
    // patchState — never writeState a stale full snapshot (mirror claims race).
    state =
      patchState(directory, {
        sessionId: adopt.sessionId,
        lastDeliveredMessageId: null,
      }) ?? { ...state, sessionId: adopt.sessionId, lastDeliveredMessageId: null }
    // Fresh room: drop the cursor and any carried context from the old one, and treat
    // the NEXT poll (cursor:null + catch_up) as the seed. Never consume this hold's
    // package as a completed seed — it was opened under the previous room's cursor,
    // so packaging is a delta against the wrong clock. Fall-through + advisory-only
    // advance locked lastDelivered past a cold-launch dispatch that landed moments
    // later with a backdated paint timestamp (session 23da0643 / item 2411dd5a).
    // Session 1383cbb8 needed the pending command delivered; a null-cursor re-poll
    // gets the catch-up window and does that correctly without the race.
    pump.cursor = null
    pump.carry.reset()
    pump.needsSeed = true
    if (adoptRequiresNullCursorRepoll()) {
      logPoll(
        `adopt → re-poll with cursor:null + catch_up (discarding pre-adopt package; ` +
          `changed=${res?.changed === true})`,
      )
      return { delayMs: 0, stop: false }
    }
  } else if (res?.changed !== true) {
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

  // Dispatched work becomes a command. Playbook runs and assignments share the
  // same inbox — branch on kind so a look-only playbook is never described as
  // an assignment (and never loses its permission line). Parity with Cursor's
  // playbookRunCommandText (item 25a1c4e6 / Codex sibling 09ffbba9).
  const freshDispatches = dispatches.filter(
    (d) => typeof d?.id === 'string' && !pump.deliveredDispatchIds.has(d.id) &&
      !['completed', 'released'].includes(String(d?.state ?? d?.status ?? 'pending')),
  )
  const dispatchCommands = freshDispatches.map((d) => {
    const kind = typeof d?.kind === 'string' ? d.kind : 'assignment'
    const content =
      kind === 'playbook_run'
        ? playbookRunCommandText(d)
        : (
          `📦 DevSpec assignment dispatched to this connection (assignment \`${d.id}\`).\n\n` +
          `Run the assignment protocol: get_assignment → acknowledge_assignment → ` +
          `claim_work_item (each member, in position order) → implement → record_implementation → ` +
          `resolve_assignment.\n` +
          `While sessionless, report progress with report_progress / item notes — do not invent a chat room.`
        )
    return {
      id: `dispatch:${d.id}`,
      created_at: typeof d?.created_at === 'string' ? d.created_at : new Date().toISOString(),
      addressed_to: res.addressed_to,
      authority: { kind: 'owner', capabilities: ['full'] },
      content,
    }
  })

  // On a seed window, filter out commands already answered before this process existed.
  const wasSeed = pump.needsSeed
  const liveRoomCommands = wasSeed
    ? (unansweredCommands(roomCommands as any, roomContext, {
        agentName: AGENT_NAME,
        connectionId: state.connectionId,
      }) as any[])
    : roomCommands
  if (wasSeed && roomCommands.length > 0) {
    const keptIds = new Set(
      liveRoomCommands.map((c) => (typeof c?.id === 'string' ? c.id : null)).filter(Boolean),
    )
    const dropped = roomCommands.filter(
      (c) => typeof c?.id === 'string' && !keptIds.has(c.id),
    )
    if (dropped.length > 0) {
      logPoll(
        `seed filter dropped ${dropped.length} already-answered command(s): ` +
          dropped.map((c) => c.id).join(', '),
      )
      logRemoteControlStory({
        phase: 'seed_filter',
        outcome: 'dropped',
        connectionId: state.connectionId,
        sessionId: state.sessionId,
        agent: AGENT_NAME,
        codename: state.codename,
        tool: 'poll_connection',
        reason: 'already_answered',
        data: {
          dropped: dropped.length,
          kept: liveRoomCommands.length,
          dropped_ids: dropped.map((c) => c.id).filter(Boolean),
        },
      })
    }
    if (liveRoomCommands.length > 0) {
      logPoll(`seed window: ${liveRoomCommands.length} unanswered command(s) to inject`)
      logRemoteControlStory({
        phase: 'seed_filter',
        outcome: 'kept',
        connectionId: state.connectionId,
        sessionId: state.sessionId,
        agent: AGENT_NAME,
        codename: state.codename,
        tool: 'poll_connection',
        reason: 'unanswered',
        data: { kept: liveRoomCommands.length },
      })
    }
  }
  pump.needsSeed = false

  // Dedup against what we have already injected (a bounded set — the cursor alone is not
  // enough, as a racing/stale cursor read has caused triple-delivery in this file before).
  const deliveredIds = new Set(state.deliveredMessageIds ?? [])
  const pendingCommands = [...dispatchCommands, ...liveRoomCommands].filter(
    (m) => !(typeof m?.id === 'string' && deliveredIds.has(m.id)),
  )
  // Item 6990fd9e: never inject owner commands into a still-settling connect turn.
  // Hold the cursor until connectMirrorSuppressed clears, then deliver on a later poll.
  const deferInject = shouldDeferInjectDuringConnect({
    connectMirrorSuppressed: state.connectMirrorSuppressed,
    awaitingRemoteReply: state.awaitingRemoteReply,
  })
  const commands = deferInject ? [] : pendingCommands
  if (deferInject && pendingCommands.length > 0) {
    logPoll(
      `deferring inject of ${pendingCommands.length} command(s) — connect handshake still settling ` +
        `(connectMirrorSuppressed); will retry after suppress clears`,
    )
    logRemoteControlStory({
      phase: 'inject',
      outcome: 'deferred',
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      agent: AGENT_NAME,
      codename: state.codename,
      tool: 'promptAsync',
      reason: 'connect_handshake',
      data: { commands: pendingCommands.length },
    })
  }

  if (typeof res.dispatch_cursor === 'string') pump.dispatchCursor = res.dispatch_cursor
  // Advance the message cursor only when the packaged turn was fully consumed.
  // Holding both the in-memory and persisted cursor is required — next poll's
  // `cursor` arg is what skips messages on the wire (session 1383cbb8).
  // MUST patchState — a full writeState of the pre-await snapshot wipes mirror claims.
  const nextCursor = typeof res.cursor === 'string' && res.cursor ? res.cursor : null
  const advanceCursor = shouldAdvanceMessageCursor({
    injectCount: commands.length,
    deliverableRoomCount: roomCommands.length,
    seedKeptCount: liveRoomCommands.length,
    wasSeed,
    dispatchCount: dispatchCommands.length,
  })
  if (nextCursor && advanceCursor) {
    pump.cursor = nextCursor
    if (pump.cursor !== state.lastDeliveredMessageId) {
      state =
        patchState(directory, { lastDeliveredMessageId: pump.cursor }) ?? {
          ...state,
          lastDeliveredMessageId: pump.cursor,
        }
    }
  } else if (nextCursor && !advanceCursor) {
    logPoll(
      `holding message cursor — deliverable work not injected ` +
        `(room=${roomCommands.length}, seedKept=${liveRoomCommands.length}, ` +
        `dispatch=${dispatchCommands.length}, inject=${commands.length}` +
        `${deferInject ? ', deferred=connect_handshake' : ''}); will retry`,
    )
    // Keep seed semantics so the next poll still asks for catch-up.
    if (wasSeed || liveRoomCommands.length > 0 || dispatchCommands.length > 0) {
      pump.needsSeed = true
    }
  }

  // Deferred mid-connect inject: do not fall into empty-change backoff — the
  // package had real owner work; we deliberately held it.
  if (deferInject && pendingCommands.length > 0) {
    pump.consecutiveEmpty = 0
    await mirrorNow(client, directory, sessionId)
    return { delayMs: 0, stop: false }
  }

  if (commands.length === 0) {
    // Changed, but nothing to deliver (advisory-only, or all already delivered).
    // Advisory-only is normal and must NOT back off — otherwise a chatty room slows
    // command delivery. Only a genuinely empty change escalates.
    const advisoryOnly = ownerAmbient.length > 0 || roomContext.length > 0
    if (advisoryOnly) {
      pump.consecutiveEmpty = 0
      logRemoteControlStory({
        phase: 'wake',
        outcome: 'advisory_only',
        connectionId: state.connectionId,
        sessionId: state.sessionId,
        agent: AGENT_NAME,
        codename: state.codename,
        tool: 'poll_connection',
        reason: 'room_delta',
        data: {
          owner_ambient: ownerAmbient.length,
          room_context: roomContext.length,
        },
      })
      // Event-driven mirroring owns replies; advisory echo must not bypass the
      // in-flight / min-gap guard with a bare mirrorLatestReply (double-post race).
      await mirrorNow(client, directory, sessionId)
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

  const commandIds = commands
    .map((m) => (typeof m?.id === 'string' ? m.id : null))
    .filter((id): id is string => id != null)
  for (const id of commandIds) deliveredIds.add(id)
  for (const d of freshDispatches) pump.deliveredDispatchIds.add(d.id)
  // Claim BEFORE injecting and persist immediately, so a concurrent poll — or a restarted
  // process — sees these ids as delivered rather than independently delivering them again.
  // patchState only — never clobber mirror claim fields with a stale full snapshot.
  {
    const deliveryPatch: Partial<ConnectionState> = {
      deliveredMessageIds: Array.from(deliveredIds).slice(-50),
      // Item 40279ae0: also track which ids belong to the turn currently in
      // flight (unioned, not replaced — a needs_input answer can extend an
      // already-open turn) so an abnormal end can unclaim exactly these ids
      // from deliveredMessageIds via clearInjectTurnState, without touching
      // anything an earlier, already-answered turn delivered.
      currentTurnMessageIds: Array.from(
        new Set([...(state.currentTurnMessageIds ?? []), ...commandIds]),
      ).slice(-50),
    }
    if (freshDispatches.length > 0) {
      deliveryPatch.deliveredAssignmentIds = Array.from(pump.deliveredDispatchIds).slice(-50)
    }
    state = patchState(directory, deliveryPatch) ?? { ...state, ...deliveryPatch }
  }

  // Needs-your-input round-trip (item 7b4090e4): when OpenCode is blocked on a
  // question, the next owner command answers THAT question — it must not start
  // a fresh promptAsync turn. Advisory chatter never reaches this branch
  // (commands are local_agent_dispatch only).
  if (state.pendingQuestion?.requestId) {
    const pendingRequestId = state.pendingQuestion.requestId
    const answerText = commands
      .map((c: any) => (typeof c?.content === 'string' ? c.content : typeof c?.text === 'string' ? c.text : ''))
      .filter((t: string) => t.trim())
      .join('\n\n')
    const replied = await replyPendingQuestion({ client, directory, answerText })
    if (replied) {
      pump.carry.take() // discard carried advisory — it must not become the answer
      logPoll(`needs_input: delivered owner reply to question ${pendingRequestId}`)
      return { delayMs: 0, stop: false }
    }
    logPoll('needs_input: question.reply failed — will retry owner command on next poll')
    // Un-claim so the same dispatch is retried (ids already in delivered set would
    // otherwise soft-drop). Drop only the last batch from the set.
    for (const id of commandIds) deliveredIds.delete(id)
    const stillCurrent = new Set(commandIds)
    patchState(directory, {
      deliveredMessageIds: Array.from(deliveredIds).slice(-50),
      currentTurnMessageIds: (state.currentTurnMessageIds ?? []).filter((id) => !stillCurrent.has(id)),
    })
    return { delayMs: 2000, stop: false }
  }

  // ONE prompt for the whole delivered turn: the room context (labelled inert) followed
  // by every command in the delta. Injecting per-command would queue separate OpenCode
  // turns, and only the first would carry the context they all share.
  const context: CarriedContext | null = pump.carry.take()
  // Attachments ride the same turn as real file parts (item 99165e12). Anything too
  // large to inline is named in the text rather than vanishing.
  const { parts: fileParts, declined: declinedAttachments } = buildAttachmentParts(commands as any, {
    materializeLarge: materializeLargeAttachmentToDisk,
  })
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
  const rawDispatchModel = (commands.find((c: any) => c?.dispatch_model) as any)?.dispatch_model
  const dispatchModelExtract = extractOpenCodeReplyModel(rawDispatchModel)
  const model = dispatchModelExtract.model
  if (rawDispatchModel != null && !model) {
    logPoll(
      `inject: dispatch_model shape rejected (${dispatchModelExtract.missingReason}): ` +
        `${dispatchModelExtract.rawSnippet ?? summarizeModelShapeSnippet(rawDispatchModel)}`,
    )
    logRemoteControlStory({
      phase: 'inject',
      outcome: 'model_missing',
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      agent: AGENT_NAME,
      codename: state.codename,
      tool: 'promptAsync',
      reason: dispatchModelExtract.missingReason ?? 'missing_fields',
      data: {
        source: 'dispatch_model',
        model_shape: dispatchModelExtract.rawSnippet ?? summarizeModelShapeSnippet(rawDispatchModel),
      },
    })
  }

  logRemoteControlStory({
    phase: 'inject',
    outcome: 'queued',
    connectionId: state.connectionId,
    sessionId: state.sessionId,
    agent: AGENT_NAME,
    codename: state.codename,
    tool: 'promptAsync',
    reason: 'owner_commands',
    data: {
      commands: commands.length,
      owner_ambient: context?.owner_ambient.length ?? 0,
      room_context: context?.room_context.length ?? 0,
      ...modelStoryData(model),
    },
  })

  // Assert busy BEFORE returning to the pump so the next poll_connection re-asserts
  // busy:true. Inject (baseline + promptAsync + mirror) must NOT block presence —
  // awaiting session.messages / kickoff here was starving last_seen (875d75b5).
  await setBusy(directory, true)
  // Mark awaiting BEFORE fire-and-forget deliverInjectedTurn. Baseline capture
  // used to set this only after session.messages — during that window a late
  // command.executed / connect suppress could poison the answer id (b156e680).
  patchState(directory, { awaitingRemoteReply: true })
  logRemoteControlStory({
    phase: 'pickup',
    outcome: 'started',
    connectionId: state.connectionId,
    sessionId: state.sessionId,
    agent: AGENT_NAME,
    codename: state.codename,
    tool: 'setBusy',
    reason: 'inject_turn',
    data: {
      commands: commands.length,
      ...modelStoryData(model),
    },
  })

  // Capture this bond's state key so fire-and-forget deliver keeps writing the
  // right file even if the pump moves on to another OpenCode session (7a9b7b0f).
  const injectStateKey = effectiveBoundSessionId()
  void runWithBoundSessionAsync(injectStateKey, () =>
    deliverInjectedTurn({
      client,
      directory,
      sessionId,
      auth,
      text,
      fileParts,
      model,
    }),
  ).catch((err) => {
    logPoll(`deliverInjectedTurn failed: ${err}`)
  })

  return { delayMs: 0, stop: false }
}

/**
 * Kick off an injected owner turn without blocking the presence pump.
 * Presence (`poll_connection`) must keep updating `last_seen` while this runs.
 */
export async function deliverInjectedTurn(input: {
  client: Parameters<Plugin>[0]['client']
  directory: string
  sessionId: string
  auth: { ok: boolean; token?: string; mcp_url?: string }
  text: string
  fileParts: unknown[]
  model?: { providerID: string; modelID: string }
}): Promise<void> {
  const { client, directory, sessionId, auth, text, fileParts, model } = input
  let state = readState(directory)
  if (!state) return

  try {
    // Baseline: only mirror assistant messages that appear AFTER the last one present at
    // inject time. Capture success is tracked separately — a failed snapshot must fail
    // closed at mirror time, never fall back to "newest in history".
    let replyAfter: string | null = null
    let baselineCaptured = false
    try {
      const snap: any = await withTimeout(
        (client as any).session.messages({ path: { id: sessionId } }),
        OPENCODE_SESSION_API_TIMEOUT_MS,
        'session.messages(inject-baseline)',
      )
      const msgs = Array.isArray(snap?.data) ? snap.data : Array.isArray(snap) ? snap : []
      const assistants = msgs.filter((m: any) => m?.info?.role === 'assistant')
      replyAfter = assistants[assistants.length - 1]?.info?.id ?? null
      baselineCaptured = true
    } catch (err) {
      logPoll(`inject: baseline snapshot failed (will fail-closed on mirror): ${err}`)
      baselineCaptured = false
    }
    // A new turn starts with no bubble of its own: dropping the previous turn's
    // trail pointer here is what stops the first chunk of THIS turn from being
    // appended to the last turn's already-answered row.
    const freshTurnTrail = {
      activeTrailMessageId: null,
      lastTrailHash: null,
      lastTrailPostedAt: null,
    } as const
    state =
      patchState(directory, {
        replyAfterOpenCodeMessageId: replyAfter,
        replyBaselineCaptured: baselineCaptured,
        awaitingRemoteReply: true,
        ...freshTurnTrail,
      }) ?? {
        ...state,
        replyAfterOpenCodeMessageId: replyAfter,
        replyBaselineCaptured: baselineCaptured,
        awaitingRemoteReply: true,
        ...freshTurnTrail,
      }

    await (client as any).session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text }, ...fileParts],
        ...(model ? { model } : {}),
      },
    })
    logRemoteControlStory({
      phase: 'inject',
      outcome: 'kicked',
      connectionId: state.connectionId,
      sessionId: state.sessionId,
      agent: AGENT_NAME,
      codename: state.codename,
      tool: 'promptAsync',
      reason: 'owner_commands',
      data: { ...modelStoryData(model) },
    })
    // Eager Working trail (item 05a88ed5): open the bubble the instant OpenCode
    // has accepted the turn, rather than waiting for the first message.updated
    // with real content — on a slow model that gap can be many seconds, during
    // which the room looks dead even though the turn is genuinely running.
    // force+seed: `shouldPostTrail` would otherwise refuse an empty trail; this
    // is the one case a placeholder body is correct, since the very next real
    // update overwrites it wholesale (the client always resends the full
    // cumulative trail, never an append) — so it never lingers, and there is
    // still only ever one trail row for this turn.
    //
    // Own try/catch: promptAsync already succeeded by this point, so a trail
    // hiccup must never fall into the catch below and be misreported as a
    // failed delivery (which would unclaim and re-inject an already-running turn).
    try {
      await postWorkTrail(client, directory, sessionId, { force: true, seed: true })
    } catch (err) {
      logPoll(`deliverInjectedTurn: eager trail seed failed (non-fatal): ${err}`)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const freshForNotice = readState(directory) ?? state
    if (freshForNotice.sessionId && auth.ok && auth.token && auth.mcp_url) {
      await mcpToolsCall({
        mcpUrl: auth.mcp_url,
        token: auth.token,
        name: 'post_session_message',
        arguments: postMessageArgs(
          freshForNotice,
          model
            ? `⚠️ Could not run this message on \`${model.providerID}/${model.modelID}\`: ${reason}`
            : `⚠️ Could not deliver this message: ${reason}`,
          { turn_kind: 'agent' },
        ),
        timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
      }).catch(() => {})
    } else {
      logPoll(`promptAsync failed (sessionless): ${reason}`)
    }
    // No turn is actually running, so clear the busy we just asserted. Item
    // 40279ae0: `promptAsync` itself rejecting means OpenCode never even
    // started this turn — unclaim so the command is eligible to re-inject on
    // the next poll instead of being silently swallowed forever.
    await setBusy(directory, false)
    clearInjectTurnState(directory, { unclaim: true })
    return
  }

  // Prefer the guarded path — session.idle / message.updated own the real flush;
  // this is a best-effort nudge that must not race a bare concurrent mirror.
  await mirrorNow(client, directory, sessionId)
}

/**
 * Decide how to correlate assistants while awaiting a remote inject reply.
 *
 * Live (8d0f1726): a concrete baseline id that is *gone* from the current
 * OpenCode session means the serve process rotated under an abandoned inject
 * cursor — clear it instead of fail-closing forever. A failed snapshot at
 * inject time (`baselineCaptured === false`) still fails closed.
 */
export type AwaitingBaselineDecision =
  | { action: 'fail_closed_snapshot' }
  | { action: 'clear_abandoned'; baseline: string }
  | { action: 'wait'; baseline: string }
  | { action: 'slice'; fromIndex: number }
  | { action: 'all' }
  | { action: 'fail_closed_legacy' }

export function decideAwaitingBaseline(opts: {
  baseline: string | null
  baselineCaptured: boolean | undefined
  assistantIds: string[]
}): AwaitingBaselineDecision {
  if (opts.baselineCaptured === false) return { action: 'fail_closed_snapshot' }
  if (opts.baseline) {
    const idx = opts.assistantIds.indexOf(opts.baseline)
    if (idx < 0) return { action: 'clear_abandoned', baseline: opts.baseline }
    if (idx === opts.assistantIds.length - 1) {
      return { action: 'wait', baseline: opts.baseline }
    }
    return { action: 'slice', fromIndex: idx + 1 }
  }
  if (opts.baselineCaptured === true) return { action: 'all' }
  return { action: 'fail_closed_legacy' }
}

/**
 * Turn an `AwaitingBaselineDecision` into the assistant messages `checkBusyStall`
 * should evaluate progress against (item 40279ae0). Unlike `mirrorLatestReply`'s
 * own use of the same decision — where several actions must `return` outright
 * (never post an answer without a confident correlation) — stall detection has
 * a safe meaning for "nothing after baseline yet": empty input is exactly what
 * `decideBusyStall` needs to correctly declare `empty_assistant_timeout` for a
 * freshly-injected turn that has produced nothing at all, rather than falling
 * back to whatever a completely unrelated, already-answered turn's last
 * assistant happened to say (the bug this fix closes: a stale global-last
 * assistant with real text made a brand-new, silent turn look "not a stall").
 */
export function scopeAssistantsAfterBaseline<T extends { info?: { id?: string } }>(
  assistants: T[],
  decision: AwaitingBaselineDecision,
): T[] {
  switch (decision.action) {
    case 'slice':
      return assistants.slice(decision.fromIndex)
    case 'all':
    case 'fail_closed_legacy':
      // Legacy state shape (no baseline info at all) — fall back to the whole
      // history rather than fail closed, which has no safe meaning here the
      // way it does for mirroring.
      return assistants
    case 'wait':
    case 'fail_closed_snapshot':
    default:
      return []
  }
}

/**
 * Clear an abandoned inject cursor (vanished baseline after OpenCode session
 * rotate). Returns true when state was cleared.
 */
export function clearAbandonedInjectCursor(
  directory: string,
  baseline: string,
): boolean {
  logPoll(
    `mirrorLatestReply: clearing abandoned inject cursor — baseline ${baseline} not in current OpenCode session`,
  )
  const next = patchState(directory, {
    awaitingRemoteReply: false,
    replyAfterOpenCodeMessageId: null,
    replyBaselineCaptured: undefined,
    busy: false,
    busySince: null,
  })
  return Boolean(next)
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
 *
 * Settle debounce (item a70cdf78): `message.updated` often fires with the
 * assistant text BEFORE the model finishes a `post_session_message` tool call.
 * Mirroring immediately then double-posts when the tool lands ~1s later.
 * `scheduleMirrorNow` waits MIRROR_SETTLE_MS so `tool.execute.after` can
 * record the manual-post hash first; `session.idle` still flushes immediately.
 */
const MIRROR_MIN_GAP_MS = 1_500
/** Wait after the last message.updated before mirroring — covers tool-call lag. */
export const MIRROR_SETTLE_MS = 2_000
const mirrorGuards = new Map<string, { at: number; inFlight: boolean }>()
const mirrorSettleTimers = new Map<string, ReturnType<typeof setTimeout>>()

function mirrorGuardKey(directory: string, sessionId: string): string {
  return `${path.resolve(directory)}::${sessionId}`
}

export async function mirrorNow(
  client: Parameters<Plugin>[0]['client'],
  directory: string,
  sessionId: string,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const bondKey = stateKeyForOpenCodeBond(sessionId)
  const run = async () => {
    const auth = resolveDevspecAuth(directory)
    const state = readState(directory)
    if (!auth.ok || !auth.token || !auth.mcp_url || !state?.sessionId) return

    const key = mirrorGuardKey(directory, sessionId)
    const guard = mirrorGuards.get(key) ?? { at: 0, inFlight: false }
    if (guard.inFlight) return
    if (!force && Date.now() - guard.at < MIRROR_MIN_GAP_MS) return
    guard.inFlight = true
    guard.at = Date.now()
    mirrorGuards.set(key, guard)
    try {
      await mirrorLatestReply(client, auth, directory, state, sessionId, { force })
    } catch (err) {
      logPoll(`mirrorNow failed: ${err}`)
    } finally {
      guard.inFlight = false
      mirrorGuards.set(key, guard)
    }
  }
  if (bondKey === undefined) {
    await run()
    return
  }
  await runWithBoundSessionAsync(bondKey, run)
}

/**
 * Debounced mirror for `message.updated` — resets on every update so we only
 * run after the turn has gone quiet long enough for a manual post tool to land.
 */
export function scheduleMirrorNow(
  client: Parameters<Plugin>[0]['client'],
  directory: string,
  sessionId: string,
): void {
  const key = mirrorGuardKey(directory, sessionId)
  const prev = mirrorSettleTimers.get(key)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(() => {
    mirrorSettleTimers.delete(key)
    void mirrorNow(client, directory, sessionId)
  }, MIRROR_SETTLE_MS)
  // Don't keep the process alive solely for this timer.
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    ;(timer as NodeJS.Timeout).unref()
  }
  mirrorSettleTimers.set(key, timer)
}

/** Cancel any pending settle timer and mirror immediately (session.idle path). */
export function flushMirrorNow(
  client: Parameters<Plugin>[0]['client'],
  directory: string,
  sessionId: string,
): void {
  const key = mirrorGuardKey(directory, sessionId)
  const prev = mirrorSettleTimers.get(key)
  if (prev) clearTimeout(prev)
  mirrorSettleTimers.delete(key)
  void mirrorNow(client, directory, sessionId, { force: true })
}

/**
 * Live work trail (item bfca2495) — publish what this turn has produced SO FAR
 * into DevSpec's streaming bubble, so the room is not blank while OpenCode works.
 *
 * Separate from the mirror on purpose. The mirror is answer-shaped: it fires once
 * per turn, dedups, strips chrome, and closes the turn. The trail is progress-
 * shaped: it fires repeatedly with unfiltered output and closes nothing. They
 * share only the connection and the tool.
 *
 * Throttled leading-edge: the first update of a turn goes out immediately, and
 * later ones are spaced by TRAIL_POST_MIN_GAP_MS with a trailing flush scheduled
 * at the boundary — so the bubble stays about a second behind the terminal
 * without turning `message.updated` into an MCP call per token.
 */
const trailGuards = new Map<string, { inFlight: boolean; pending: boolean }>()
const trailTrailingTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Debounced/throttled trail publish for `message.updated`. */
export function scheduleWorkTrailPost(
  client: Parameters<Plugin>[0]['client'],
  directory: string,
  sessionId: string,
): void {
  const key = mirrorGuardKey(directory, sessionId)
  void postWorkTrail(client, directory, sessionId)
  // Whatever arrives during the gap still reaches the room: schedule one trailing
  // publish so the last update before a quiet stretch is never the one dropped.
  if (trailTrailingTimers.has(key)) return
  const timer = setTimeout(() => {
    trailTrailingTimers.delete(key)
    void postWorkTrail(client, directory, sessionId)
  }, TRAIL_POST_MIN_GAP_MS)
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    ;(timer as NodeJS.Timeout).unref()
  }
  trailTrailingTimers.set(key, timer)
}

/**
 * Serialize and post the current turn's trail, subject to the throttle.
 *
 * Only while a remote turn is actually in flight (`busy` or `awaitingRemoteReply`):
 * a trail posted outside one would open a streaming bubble that nothing is going
 * to close. Best-effort throughout — a failed trail post must never disturb the
 * turn or the mirror that ends it.
 */
export async function postWorkTrail(
  client: Parameters<Plugin>[0]['client'],
  directory: string,
  sessionId: string,
  { force = false, seed = false }: { force?: boolean; seed?: boolean } = {},
): Promise<void> {
  const bondKey = stateKeyForOpenCodeBond(sessionId)
  const run = async () => {
    const auth = resolveDevspecAuth(directory)
    const state = readState(directory)
    if (!auth.ok || !auth.token || !auth.mcp_url) return
    if (!state?.sessionId || !state.connectionId) return
    if (!state.busy && !state.awaitingRemoteReply) return

    const key = mirrorGuardKey(directory, sessionId)
    const guard = trailGuards.get(key) ?? { inFlight: false, pending: false }
    if (guard.inFlight) {
      // A trailing timer alone is not enough: if it fires while this post is
      // still in flight it no-ops, and with no further message.updated the last
      // chunk of a quiet stretch never leaves the laptop. Mark dirty and flush
      // once the in-flight post clears.
      guard.pending = true
      trailGuards.set(key, guard)
      return
    }

    let messages: any[]
    try {
      const res: any = await withTimeout(
        (client as any).session.messages({ path: { id: sessionId } }),
        OPENCODE_SESSION_API_TIMEOUT_MS,
        'session.messages(trail)',
      )
      messages = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
    } catch (err) {
      logPoll(`postWorkTrail: client.session.messages failed: ${err}`)
      return
    }

    // Same baseline the mirror correlates on: everything after the pre-inject
    // assistant is this remote turn's work. Without one, only the newest turn.
    const rawTrail = serializeTurnTrail(messages, {
      afterMessageId: state.replyAfterOpenCodeMessageId ?? null,
    })
    // Turn-start seed (item 05a88ed5): only substitute the placeholder when
    // there is genuinely nothing to show yet. Real content always wins, so a
    // seed call racing behind a message.updated-triggered post never clobbers
    // it — "one trail row" holds, never an orphan second bubble.
    const usingSeed = seed && !rawTrail.trim()
    const trail = usingSeed ? TRAIL_SEED_TEXT : rawTrail
    const trailHash = hashPostedContent(trail)
    if (
      !shouldPostTrail({
        trail,
        trailHash,
        lastPostedTrailHash: state.lastTrailHash ?? null,
        lastPostedAt: state.lastTrailPostedAt ?? null,
        now: Date.now(),
        force,
        seed,
      })
    ) {
      return
    }

    guard.inFlight = true
    guard.pending = false
    trailGuards.set(key, guard)
    // Claim the throttle window before the round-trip so concurrent updates during
    // it do not queue a second identical post behind this one.
    patchState(directory, { lastTrailHash: trailHash, lastTrailPostedAt: Date.now() })
    try {
      const result = await mcpToolsCall({
        mcpUrl: auth.mcp_url,
        token: auth.token,
        name: 'post_session_message',
        arguments: postMessageArgs(state, trail, { turn_kind: 'agent', phase: 'trail' }),
        timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
      })
      const messageId = extractPostedMessageId(result)
      if (messageId && messageId !== readState(directory)?.activeTrailMessageId) {
        patchState(directory, { activeTrailMessageId: messageId })
        logPoll(`postWorkTrail: opened live trail turn ${messageId}`)
      }
    } catch (err) {
      // Roll the hash back so the next update retries rather than assuming this
      // body already landed.
      patchState(directory, { lastTrailHash: state.lastTrailHash ?? null })
      logPoll(`postWorkTrail: post_session_message(phase=trail) failed: ${err}`)
    } finally {
      const stillPending = guard.pending
      guard.inFlight = false
      guard.pending = false
      trailGuards.set(key, guard)
      if (stillPending) {
        void postWorkTrail(client, directory, sessionId)
      }
    }
  }
  if (bondKey === undefined) {
    await run()
    return
  }
  await runWithBoundSessionAsync(bondKey, run)
}

/**
 * DevSpec's `message_id` out of an MCP tool result.
 *
 * `mcpToolsCall` unwraps JSON to `{ message_id, … }`; tests and some call
 * sites still pass the raw MCP envelope. Both shapes are accepted.
 * Mirror answer posts MUST require this id before claiming success (item 6990fd9e).
 */
export function extractPostedMessageId(result: unknown): string | null {
  const parsed = parsePostedToolJson(result)
  const id = parsed?.message_id
  return typeof id === 'string' && id ? id : null
}

/** Whether `phase:'error'|'answer'` actually closed a server-open trail turn. */
export function extractClosedTrailTurn(result: unknown): boolean {
  return parsePostedToolJson(result)?.closed_trail_turn === true
}

/**
 * Parse `post_session_message` (and similar) MCP tool results.
 *
 * `mcpToolsCall` unwraps the JSON body and returns `{ message_id, … }` directly.
 * Some call sites / tests still pass the raw MCP envelope
 * `{ content: [{ type: 'text', text: '<json>' }] }`. Accept both — otherwise a
 * success check on `message_id` always misses and falsely rolls back (or, before
 * the verify fix, never verified at all).
 */
export function parsePostedToolJson(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const obj = result as Record<string, unknown>

  // Unwrapped mcpToolsCall success (the live path).
  if (
    typeof obj.message_id === 'string' ||
    obj.closed_trail_turn === true ||
    obj.noop === true ||
    typeof obj.session_id === 'string'
  ) {
    return obj
  }

  // Raw MCP envelope.
  const content = obj.content
  for (const block of Array.isArray(content) ? content : []) {
    const text = (block as { text?: unknown } | null)?.text
    if (typeof text !== 'string') continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not JSON (a plain error string) — nothing to extract.
    }
  }

  // mcpToolsCall fallback shape when the body was not valid JSON.
  if (typeof obj.raw === 'string') {
    try {
      const parsed = JSON.parse(obj.raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

/**
 * Reset all inject-turn correlation state (item 40279ae0): the
 * awaiting-reply flag, baseline pointer, turn-scoped tool-post flag, and
 * trail pointers. Every code path that ends a remote turn — a real answer,
 * chrome-only completion, a stall, or a `session.error` — must clear these
 * or the NEXT turn inherits stale correlation state (a wrong baseline, a
 * phantom manual-post flag, an orphan trail bubble).
 *
 * `unclaim: true` is for an ABNORMAL end only (stall / session.error): it
 * also removes this turn's ids from `deliveredMessageIds` so they are
 * eligible to re-inject on the next poll. Real bug found live: a stalled
 * turn's command stayed permanently marked "delivered" even though it was
 * never actually answered, so `shouldAdvanceMessageCursor` held the poll
 * cursor in place forever (deliverable room command present, but filtered
 * to zero injects by the dedup set) — see `currentTurnMessageIds` on
 * `ConnectionState`. A CLEAN end must never pass `unclaim: true` — the
 * command really was answered, and re-injecting it would duplicate the turn.
 */
export function clearInjectTurnState(directory: string, opts: { unclaim?: boolean } = {}): void {
  const state = readState(directory)
  if (!state) return
  const patch: Partial<ConnectionState> = {
    awaitingRemoteReply: false,
    replyAfterOpenCodeMessageId: null,
    replyBaselineCaptured: undefined,
    currentTurnMessageIds: null,
    manualAnswerPostedThisTurn: false,
    activeTrailMessageId: null,
    lastTrailHash: null,
    lastTrailPostedAt: null,
  }
  if (opts.unclaim && state.currentTurnMessageIds?.length) {
    const stuck = new Set(state.currentTurnMessageIds)
    patch.deliveredMessageIds = (state.deliveredMessageIds ?? []).filter((id) => !stuck.has(id))
    logPoll(
      `clearInjectTurnState: unclaiming ${stuck.size} stalled command id(s) from deliveredMessageIds ` +
        `so they can re-inject on the next poll: ${Array.from(stuck).join(', ')}`,
    )
  }
  patchState(directory, patch)
}

/** Forget this turn's trail bookkeeping once the turn has landed. */
function clearTrailState(directory: string): void {
  patchState(directory, {
    activeTrailMessageId: null,
    lastTrailHash: null,
    lastTrailPostedAt: null,
  })
}

/**
 * Close an open live-trail bubble as FAILED.
 *
 * This is the whole reason the plugin tracks an open turn at all: a stall, a
 * `session.error`, or an agent that simply dies would otherwise leave a bubble
 * streaming for ever, which reads as "still working" to whoever is watching.
 * Returns true when it closed a server-open turn, so callers can fall back to a
 * plain notice when there was no live bubble to fail in the first place.
 *
 * Do NOT gate on local `activeTrailMessageId`. The server owns the open-turn
 * pointer (`agent_connections.active_turn_message_id`); a trail may have opened
 * on DevSpec even when the plugin never stored the returned message_id (parse
 * miss, crash after write). Gating locally would leave that row streaming forever
 * while the connection stays attached.
 */
async function failOpenTrailTurn(
  auth: ReturnType<typeof resolveDevspecAuth>,
  directory: string,
  state: ConnectionState,
  reason: string,
): Promise<boolean> {
  if (!auth.ok || !auth.token || !auth.mcp_url) return false
  if (!state.connectionId || !state.sessionId) return false
  let result: unknown
  try {
    result = await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'post_session_message',
      arguments: postMessageArgs(state, reason, { turn_kind: 'agent', phase: 'error' }),
      timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
    })
  } catch (err) {
    logPoll(`failOpenTrailTurn: post_session_message(phase=error) failed: ${err}`)
    return false
  }
  const closed = extractClosedTrailTurn(result)
  if (!closed) {
    // Server had no open trail turn — leave the fallback notice path alone.
    // Item 40279ae0: also clear the broader inject-turn state (not just the
    // trail pointers) here — this "abandon" branch still means the turn is
    // over from this connection's point of view. Callers that know the end
    // was ABNORMAL (checkBusyStall, handleSessionError) additionally unclaim
    // this turn's ids at their own call site right after this returns.
    clearInjectTurnState(directory)
    return false
  }
  const messageId = extractPostedMessageId(result) ?? state.activeTrailMessageId ?? null
  logRemoteControlStory({
    phase: 'mirror_post',
    outcome: 'failed_turn',
    connectionId: state.connectionId,
    sessionId: state.sessionId,
    agent: AGENT_NAME,
    codename: state.codename,
    tool: 'post_session_message',
    reason: 'work_trail_error',
    data: { message_id: messageId, phase: 'error' },
  })
  // Item 40279ae0: same reasoning as the abandon branch above — a closed
  // trail turn means this connection's remote turn is over.
  clearInjectTurnState(directory)
  return true
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
  opts: { force?: boolean } = {},
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
  // if the baseline snapshot failed; clear an abandoned cursor when the
  // baseline id vanished (OpenCode session rotated — 8d0f1726).
  let candidates = assistantMessages
  if (fresh.awaitingRemoteReply) {
    const decision = decideAwaitingBaseline({
      baseline,
      baselineCaptured,
      assistantIds: assistantMessages.map((m) => m?.info?.id).filter(Boolean) as string[],
    })
    if (decision.action === 'fail_closed_snapshot') {
      logPoll(
        'mirrorLatestReply: FAIL CLOSED — awaiting remote reply but baseline snapshot failed at inject',
      )
      return
    }
    if (decision.action === 'clear_abandoned') {
      clearAbandonedInjectCursor(directory, decision.baseline)
      // Item 40279ae0: an abandoned cursor is an abnormal end for whatever
      // command(s) this turn claimed — unclaim them so they can re-inject
      // against the (now current) OpenCode session instead of being
      // silently swallowed forever by the delivery dedup set.
      clearInjectTurnState(directory, { unclaim: true })
      await setBusy(directory, false)
      return
    }
    if (decision.action === 'wait') {
      logPoll(`mirrorLatestReply: still waiting for assistant after baseline ${decision.baseline}`)
      return
    }
    if (decision.action === 'slice') {
      candidates = assistantMessages.slice(decision.fromIndex)
    } else if (decision.action === 'all') {
      candidates = assistantMessages
    } else {
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

  // No answer-path narration mid-turn (item d4b8adcb): `message.updated` fires
  // repeatedly while a turn is still running, and can land while `last` still
  // has an in-flight tool part. Posting it now would mirror half-finished
  // work as if it were the model's final answer — the room reads intermediate
  // narration as done. The live trail is built for exactly this progress
  // view; defer to it and let the turn actually finish.
  //
  // `opts.force` (session.idle's flushMirrorNow) always bypasses this: that
  // event is OpenCode's own authoritative "this turn is over" signal, and
  // trusting it unconditionally is what keeps this deadlock-free. Without the
  // bypass, a tool whose status field never updates after session.idle fires
  // would leave the connection stuck at busy:false forever with no answer
  // ever posted and no stall recovery — checkBusyStall only runs while
  // busy:true (see pollAndDeliver's turnActive gate), so nothing would ever
  // re-check `last` again. A non-forced skip here is always safe to retry:
  // either a later message.updated re-triggers the debounced mirror once the
  // tool genuinely finishes, or session.idle forces it through regardless.
  if (!opts.force && messageHasActiveToolWork(last)) {
    logPoll(
      `mirrorLatestReply: skip (active tool work, mid-turn) last.id=${last.info.id} — ` +
        `trail covers this; waiting for quiescence or session.idle`,
    )
    return
  }

  // Connect skill turn (e7ecc1de): never post — would settle unanswered
  // owner dispatches that landed during attach. command.executed ids +
  // post-handshake suppress; not NLP chrome.
  if (
    shouldSkipConnectTurnMirror({
      messageId: last.info.id,
      nonMirrorMessageIds: fresh.nonMirrorMessageIds,
      connectMirrorSuppressed: fresh.connectMirrorSuppressed,
      awaitingRemoteReply: fresh.awaitingRemoteReply,
    })
  ) {
    // Peek at postable text before claiming. A late connect-skill tag on a
    // real answer (banner + "-1") must fall through and post (b156e680).
    const suppressText = assistantTextFromMessage(last)
    const suppressPrepared = suppressText ? prepareMirrorText(suppressText) : null
    if (
      !shouldClaimConnectTurnSuppress({
        awaitingRemoteReply: fresh.awaitingRemoteReply,
        preparedText: suppressPrepared,
      })
    ) {
      if (fresh.awaitingRemoteReply) {
        logPoll(
          `mirrorLatestReply: refuse connect-skip claim while awaiting last.id=${last.info.id}`,
        )
        return
      }
      logPoll(
        `mirrorLatestReply: connect-skip overridden — real answer text last.id=${last.info.id}`,
      )
      logRemoteControlStory({
        phase: 'mirror_decision',
        outcome: 'continue',
        connectionId: fresh.connectionId,
        sessionId: fresh.sessionId,
        agent: AGENT_NAME,
        codename: fresh.codename,
        tool: 'mirrorLatestReply',
        reason: 'connect_suppress_real_answer',
        data: { message_id: last.info.id },
      })
      // Fall through to the normal prepare/post path below.
    } else {
      logPoll(
        `mirrorLatestReply: skip (connect skill / handshake suppress) last.id=${last.info.id} ` +
          `suppressed=${Boolean(fresh.connectMirrorSuppressed)} awaiting=${Boolean(fresh.awaitingRemoteReply)}`,
      )
      logRemoteControlStory({
        phase: 'mirror_decision',
        outcome: 'skip',
        connectionId: fresh.connectionId,
        sessionId: fresh.sessionId,
        agent: AGENT_NAME,
        codename: fresh.codename,
        tool: 'mirrorLatestReply',
        reason: 'connect_turn_suppress',
        data: { message_id: last.info.id },
      })
      alreadyMirrored.add(last.info.id)
      patchState(directory, {
        lastMirroredMessageId: last.info.id,
        mirroredMessageIds: Array.from(alreadyMirrored).slice(-50),
        connectMirrorSuppressed: false,
        // Handshake skip only — awaitingRemoteReply is already false above.
        replyAfterOpenCodeMessageId: null,
        replyBaselineCaptured: undefined,
        currentTurnMessageIds: null,
        manualAnswerPostedThisTurn: false,
      })
      await setBusy(directory, false)
      return
    }
  }

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

  // Item 5f75c2cb: never post empty/whitespace. `prepareMirrorText` already
  // trims and returns null for nothing-postable, so `!preparedText.trim()`
  // should be unreachable in practice — this is explicit defense-in-depth
  // against a future regression there, not a workaround for one today.
  if (!preparedText || !preparedText.trim()) {
    // Claim + treat as a finished (non-)turn so busy clears, but never post.
    logPoll(`mirrorLatestReply: skip (operational chrome) last.id=${last.info.id}`)
    logRemoteControlStory({
      phase: 'mirror_decision',
      outcome: 'skip',
      connectionId: fresh.connectionId,
      sessionId: fresh.sessionId,
      agent: AGENT_NAME,
      codename: fresh.codename,
      tool: 'mirrorLatestReply',
      reason: 'operational_chrome',
      data: { message_id: last.info.id },
    })
    // A live trail bubble opened by this turn would otherwise stream for ever:
    // the answer that closes it is never coming, because there wasn't one. Fail
    // it so the room shows a finished turn that produced no reply, with the work
    // still readable, rather than a permanent "working…". Always attempt — the
    // server owns the open-turn pointer, not local activeTrailMessageId.
    await failOpenTrailTurn(
      auth,
      directory,
      fresh,
      '⚠️ The remote agent finished this turn without an answer — only operational output. The work above is what it did.',
    )
    alreadyMirrored.add(last.info.id)
    patchState(directory, {
      lastMirroredMessageId: last.info.id,
      mirroredMessageIds: Array.from(alreadyMirrored).slice(-50),
      awaitingRemoteReply: false,
      replyAfterOpenCodeMessageId: null,
      replyBaselineCaptured: undefined,
      currentTurnMessageIds: null,
      manualAnswerPostedThisTurn: false,
    })
    await setBusy(directory, false)
    return
  }

  // Mechanical double-post guard (a70cdf78, hardened for 5f75c2cb): if the
  // model already called post_session_message for this turn, claim the
  // OpenCode message id and do NOT post again. Three independent signals,
  // because no single one covers every shape observed live:
  // - content hash: the exact same body was already posted (manual or mirror).
  // - tool-part scan across every post-inject candidate (not just `last`) —
  //   the model may have called post_session_message from an EARLIER
  //   assistant message in this turn and then kept working, ending on a
  //   `last` with no tool part of its own.
  // - `manualAnswerPostedThisTurn`: message-id-independent — set the instant
  //   `tool.execute.after` observes the call (see recordManualPostSessionMessage),
  //   so it also catches a shape neither the hash nor the tool-part scan sees.
  const contentHash = hashPostedContent(preparedText)
  const alreadyPostedByHash = (fresh.recentPostedContentHashes ?? []).includes(contentHash)
  const alreadyPostedByTool = candidates.some((m) => messageHasPostSessionMessageTool(m))
  const alreadyPostedManually = Boolean(fresh.manualAnswerPostedThisTurn)
  if (alreadyPostedByHash || alreadyPostedByTool || alreadyPostedManually) {
    const via = alreadyPostedByTool ? 'tool' : alreadyPostedManually ? 'manual-flag' : 'content-hash'
    logPoll(
      `mirrorLatestReply: skip (already posted via ${via}) ` +
        `last.id=${last.info.id} hash=${contentHash.slice(0, 8)}…`,
    )
    logRemoteControlStory({
      phase: 'mirror_decision',
      outcome: 'skip',
      connectionId: fresh.connectionId,
      sessionId: fresh.sessionId,
      agent: AGENT_NAME,
      codename: fresh.codename,
      tool: 'mirrorLatestReply',
      reason:
        via === 'tool' ? 'already_posted_tool' : via === 'manual-flag' ? 'already_posted_manual_flag' : 'already_posted_hash',
      data: { message_id: last.info.id },
    })
    alreadyMirrored.add(last.info.id)
    patchState(directory, {
      lastMirroredMessageId: last.info.id,
      mirroredMessageIds: Array.from(alreadyMirrored).slice(-50),
      awaitingRemoteReply: false,
      replyAfterOpenCodeMessageId: null,
      replyBaselineCaptured: undefined,
      currentTurnMessageIds: null,
      manualAnswerPostedThisTurn: false,
      recentPostedContentHashes: (fresh.recentPostedContentHashes ?? []).includes(contentHash)
        ? fresh.recentPostedContentHashes
        : [...(fresh.recentPostedContentHashes ?? []), contentHash].slice(-40),
      // The model's own post already closed any open trail turn server-side
      // (a phase-less post takes the answer path) — just drop the local pointer.
      activeTrailMessageId: null,
      lastTrailHash: null,
      lastTrailPostedAt: null,
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
    currentTurnMessageIds: null,
    manualAnswerPostedThisTurn: false,
    // A successful real mirror means the connect handshake is over.
    connectMirrorSuppressed: false,
    // Claim the content hash too so a racing manual post that lands during
    // our network round-trip is remembered, and a second mirror path skips.
    recentPostedContentHashes: [...(fresh.recentPostedContentHashes ?? []), contentHash].slice(-40),
  })
  if (!claimed) return
  // Another writer may have claimed the same id between our check and patch
  // if we lost a race on lastMirrored — re-check isn't perfect without a
  // lock, but the set membership after merge is enough when both use patchState.

  const modelExtract = resolveOpenCodeAssistantModel(last)
  const model = modelExtract.model
  if (!model) {
    // Never silent — DevSpec has no record of which model answered when the
    // stamp is dropped (Obsidian Gecko RCA / Restless Ocelot).
    const shape =
      modelExtract.rawSnippet ??
      summarizeModelShapeSnippet(last.info)
    logPoll(
      `mirrorLatestReply: model stamp missing (${modelExtract.missingReason ?? 'absent'}) ` +
        `last.id=${last.info.id} source=${modelExtract.source} shape=${shape}`,
    )
    logRemoteControlStory({
      phase: 'mirror_post',
      outcome: 'model_missing',
      connectionId: fresh.connectionId,
      sessionId: fresh.sessionId,
      agent: AGENT_NAME,
      codename: fresh.codename,
      tool: 'post_session_message',
      reason: modelExtract.missingReason ?? 'absent',
      data: {
        message_id: last.info.id,
        model_shape: shape,
        source: modelExtract.source,
      },
    })
  }

  // phase:'answer' closes the live work-trail bubble this turn has been growing
  // (item bfca2495) by writing the chrome-filtered answer into the SAME row,
  // instead of leaving it streaming under a second, duplicate message. With no
  // open trail turn the server falls back to the historical insert, so every
  // mirror can take this path unconditionally. complete_turn rides along so the
  // Working dots clear with the bubble rather than one report_complete later.
  let postedDevspecMessageId: string | null = null
  try {
    const result = await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'post_session_message',
      arguments: postMessageArgs(fresh, preparedText, {
        turn_kind: 'agent',
        model,
        phase: 'answer',
        complete_turn: true,
      }),
      timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
    })
    // Item 6990fd9e: "no throw" is not success. Live: mcpToolsCall returned
    // without throwing, we logged posted + claimed the OpenCode id, but no
    // session_messages row existed. Require a DevSpec message_id before keeping
    // the optimistic claim.
    postedDevspecMessageId = extractPostedMessageId(result)
    if (!postedDevspecMessageId) {
      throw new Error(
        'post_session_message returned without message_id — refusing silent mirror success',
      )
    }
  } catch (err) {
    // Roll back the optimistic claim so this reply can be retried.
    const ids = (readState(directory)?.mirroredMessageIds ?? []).filter((id) => id !== last.info.id)
    const hashes = (readState(directory)?.recentPostedContentHashes ?? []).filter((h) => h !== contentHash)
    patchState(directory, {
      lastMirroredMessageId: fresh.lastMirroredMessageId ?? null,
      mirroredMessageIds: ids,
      awaitingRemoteReply: fresh.awaitingRemoteReply ?? false,
      replyAfterOpenCodeMessageId: fresh.replyAfterOpenCodeMessageId ?? null,
      replyBaselineCaptured: fresh.replyBaselineCaptured,
      currentTurnMessageIds: fresh.currentTurnMessageIds ?? null,
      manualAnswerPostedThisTurn: fresh.manualAnswerPostedThisTurn ?? false,
      recentPostedContentHashes: hashes,
    })
    logPoll(`mirrorLatestReply: post_session_message failed for last.id=${last.info.id}: ${err}`)
    logRemoteControlStory({
      phase: 'mirror_post',
      outcome: 'failed',
      connectionId: fresh.connectionId,
      sessionId: fresh.sessionId,
      agent: AGENT_NAME,
      codename: fresh.codename,
      tool: 'post_session_message',
      reason: 'post_failed',
      data: {
        message_id: last.info.id,
        error: err instanceof Error ? err.message : String(err),
        ...modelStoryData(model),
      },
    })
    return
  }

  // Answer landed: the trail turn is closed server-side, so this connection has
  // no open bubble any more. Clearing the pointer is what lets the NEXT turn open
  // a fresh one instead of appending to a turn that already has an answer.
  clearTrailState(directory)

  logPoll(
    `mirrorLatestReply: posted last.id=${last.info.id} via connection_id` +
      ` devspec_message_id=${postedDevspecMessageId}` +
      (model ? ` model=${model.providerID}/${model.modelID}` : ' model=(none)'),
  )
  logRemoteControlStory({
    phase: 'mirror_post',
    outcome: 'posted',
    connectionId: fresh.connectionId,
    sessionId: fresh.sessionId,
    agent: AGENT_NAME,
    codename: fresh.codename,
    tool: 'post_session_message',
    reason: 'plugin_mirror',
    data: {
      message_id: last.info.id,
      devspec_message_id: postedDevspecMessageId,
      ...modelStoryData(model),
      model_stamped: Boolean(model),
    },
  })
  logRemoteControlStory({
    phase: 'done',
    outcome: model ? 'mirrored' : 'mirrored_without_model',
    connectionId: fresh.connectionId,
    sessionId: fresh.sessionId,
    agent: AGENT_NAME,
    codename: fresh.codename,
    tool: 'post_session_message',
    reason: 'plugin_mirror',
    data: {
      message_id: last.info.id,
      devspec_message_id: postedDevspecMessageId,
      ...modelStoryData(model),
      model_stamped: Boolean(model),
    },
  })

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
