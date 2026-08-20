import type { Plugin } from '@opencode-ai/plugin';
import { resolveDevspecAuth } from './resolve-devspec-auth.js';
import { type OpencodeControlSlash } from './opencode-control-slash.js';
export { collapseOrphanMarkdownFences, isDevspecRemoteControlCommand, shouldDeferInjectDuringConnect, unwrapSingleOuterMarkdownFence, } from './mirror-chrome.js';
export { buildAttachmentParts, isDeliverableCommand, pollTerminalReason, PERMANENT_END_REASONS, renderInjectedTurn, resolveServerAttachment, shouldAdvanceMessageCursor, holdFor, adoptRequiresNullCursorRepoll, } from './poll-turn.js';
export declare function logPoll(line: string): void;
/**
 * How long a turn may stay `busy` with no observable progress before we
 * treat it as stalled. Progress means reply text, a new assistant message,
 * or an in-flight tool on the latest assistant — not merely "busy wall-clock
 * with empty text" (Tembo / Racing Heron false stalls: MiniMax tool loops
 * spent minutes with no mirrorable text while still working). Override via
 * DEVSPEC_OPENCODE_STALL_MS (milliseconds).
 */
export declare const STALL_TIMEOUT_MS: number;
/**
 * Client ceiling for ordinary (non-long-poll) MCP calls on the pump path.
 * `fetch` has no default timeout — a hung keepalive / heartbeat / notice ahead
 * of the next `poll_connection` freezes `last_seen` while the connection still
 * looks attached, and the server eventually ends it with `idle_timeout`
 * (Climbing Koala / Steady Wolf). Matches Claude poller's activity-verb ceiling.
 */
export declare const MCP_SHORT_CALL_TIMEOUT_MS = 10000;
/** Tighter ceiling for heartbeat_connection / detach — same as Claude's teardown heartbeats. */
export declare const MCP_HEARTBEAT_TIMEOUT_MS = 5000;
/**
 * Ceiling for OpenCode `session.messages` on the pump / stall / inject-baseline
 * paths. A hung SDK call ahead of the next `poll_connection` freezes `last_seen`
 * the same way hung MCP did (item 875d75b5 — Crimson Osprey / Gentle Weasel).
 */
export declare const OPENCODE_SESSION_API_TIMEOUT_MS = 5000;
/** Compact/summarize can run a model turn — don't use the short session API ceiling. */
export declare const OPENCODE_CONTROL_COMPACT_TIMEOUT_MS = 120000;
/**
 * Warn (story `presence_gap`) when this many ms pass without a successful
 * `poll_connection` while the bond is still supposed to look live. Server
 * attached liveness is ~90s — warn before that so Axiom shows the starve.
 */
export declare const PRESENCE_GAP_WARN_MS = 60000;
/** Minimum spacing between `presence_gap` stories for one connection. */
export declare const PRESENCE_GAP_WARN_COOLDOWN_MS = 30000;
/**
 * How many consecutive `active_tool` slides on the SAME assistant id are allowed
 * before we treat the turn as stalled. Eternal "running" tool parts otherwise
 * reset `busySince` forever and keep hammering keepalive while poll never runs.
 */
export declare const MAX_SAME_ASSISTANT_ACTIVE_TOOL_SLIDES = 2;
/**
 * After OpenCode emits `permission.asked` (or a tool part is stuck in an ask /
 * permission-wait state), how long we wait before clearing busy. A hung
 * permission prompt is not progress — do not slide the busy timer the way a
 * healthy `active_tool` does (live hang: write tool `running` + external_directory
 * ask → multi-slide then ~6 min empty_assistant_timeout).
 */
export declare const PERMISSION_ASK_STALL_MS = 15000;
/**
 * Race a promise against a wall-clock ceiling. Used for OpenCode session API
 * calls that have no built-in timeout.
 */
export declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T>;
interface ConnectionState {
    connectionId: string;
    sessionId: string | null;
    codename: string | null;
    /**
     * Id of the last OpenCode assistant message we mirrored back to DevSpec via
     * post_session_message. Prevents re-posting the same reply on every idle
     * poll — there is no other cursor for "have we already reported this one".
     */
    lastMirroredMessageId?: string | null;
    /**
     * After we inject an owner command, only mirror assistant messages that
     * appear *after* this OpenCode message id (correlation). Null with
     * replyBaselineCaptured=true means the snapshot succeeded and there was no
     * prior assistant (empty history at inject). Null with capture failed must
     * fail closed — never fall back to newest-in-history.
     */
    replyAfterOpenCodeMessageId?: string | null;
    /**
     * Whether the pre-inject assistant baseline snapshot succeeded.
     * false → fail closed on mirror (do not post any assistant for that remote turn).
     * true + null replyAfter → empty history at inject; any later assistant is new.
     */
    replyBaselineCaptured?: boolean;
    /** True while waiting for an assistant reply after injecting an owner command. */
    awaitingRemoteReply?: boolean;
    /**
     * Cursor into the DevSpec transcript (last delivered message id). Without
     * this, every idle poll re-fetched the WHOLE transcript and re-delivered
     * every owner instruction ever posted — a real bug fixed alongside the
     * model-override work, not a hypothetical one.
     */
    lastDeliveredMessageId?: string | null;
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
    deliveredMessageIds?: string[];
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
    currentTurnMessageIds?: string[] | null;
    /** Assignment ids already injected into OpenCode (sessionless + attached). */
    deliveredAssignmentIds?: string[];
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
    busy?: boolean;
    /**
     * Epoch ms when `busy` last flipped to true. Used by the stall detector
     * (see checkBusyStall). Cleared when busy goes false. Absent on older
     * state files — checkBusyStall seeds it on first sight rather than
     * immediately treating the turn as already timed out.
     */
    busySince?: number | null;
    /**
     * Epoch ms of the busySince window we already posted a stall warning for.
     * Prevents re-posting the same stall on every subsequent poll if clearing
     * busy somehow fails.
     */
    stallWarnedAt?: number | null;
    /**
     * Latest OpenCode assistant message id observed while evaluating stall
     * progress. When a newer assistant appears (even tool-only / empty text),
     * checkBusyStall slides `busySince` forward so a healthy multi-step turn
     * does not trip on wall-clock alone.
     */
    stallProgressAssistantId?: string | null;
    /**
     * Consecutive `active_tool` slides already granted for `stallProgressAssistantId`.
     * Reset when busy clears or progress is a new assistant / different reason.
     */
    stallActiveToolSlides?: number | null;
    /**
     * Fingerprint of reasoning/thinking parts on the last progress slide
     * (`length:hash`). Growing reasoning on the same assistant (MiniMax-style
     * long thinks with no tool yet) slides `busySince` — a frozen fingerprint
     * past the timeout is a true stall. Cleared when busy flips.
     */
    stallReasoningFingerprint?: string | null;
    /**
     * True while OpenCode is waiting on a permission prompt (`permission.asked`
     * or equivalent). Cleared when the ask is resolved/denied or busy clears.
     * Stall policy treats this as non-progress — never an `active_tool` slide.
     */
    permissionAskedPending?: boolean;
    /**
     * Epoch ms when we first observed the pending permission ask. Used with
     * `PERMISSION_ASK_STALL_MS` for an early stall (sooner than `STALL_TIMEOUT_MS`).
     */
    permissionAskedAt?: number | null;
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
    mirroredMessageIds?: string[];
    /**
     * Recent content hashes of replies already posted to DevSpec (manual
     * model `post_session_message` OR plugin mirror). Live regression
     * (session 506e2926 / Climbing Zebra): docs told the model not to call
     * `post_session_message`, but it still did — so mirror + model each
     * posted the same answer ~1–2s apart. Hash dedup makes that structurally
     * impossible even when the model ignores the skill wording.
     */
    recentPostedContentHashes?: string[];
    /**
     * True once the model has itself called `post_session_message` during the
     * CURRENT `awaitingRemoteReply` turn (item 5f75c2cb). A message-id-independent
     * double-post guard alongside the hash/tool-part checks in `mirrorLatestReply` —
     * it survives even if the posting assistant message is not (or is no longer)
     * the candidate `mirrorLatestReply` is evaluating. Set by
     * `recordManualPostSessionMessage`; reset to false whenever a turn ends
     * (answer landed, chrome-only, stalled, errored) or a new one is injected.
     */
    manualAnswerPostedThisTurn?: boolean;
    /**
     * OpenCode assistant message ids that must never be mirrored — filled from
     * `command.executed` for `/devspec.remote` / `/devspec.remote-stop` so the
     * connect skill turn cannot settle a pending owner dispatch (e7ecc1de).
     */
    nonMirrorMessageIds?: string[];
    /**
     * This turn is the plugin's OWN protocol (a DevSpec connect handshake), so
     * it produces no room post — item 68cc567c.
     *
     * Set the moment `tool.execute.after` observes `register_connection` /
     * `attach_connection`, which happens DURING the turn, and cleared when that
     * turn settles. It records WHAT THE TURN DID, not what it said.
     *
     * The predecessor was a pair of message-id/flag heuristics with a text-shaped
     * override: suppression was claimed only when the model's output looked like
     * pure chrome, so a connect turn that printed anything else fell through and
     * posted. That is how the word "Done." reached DevSpec session 8fd18ec0 on
     * 2026-08-17, months after c13d846c marked the case fixed. b156e680 and
     * 1f1bafa4 were both patches to the same guess.
     *
     * Marking at tool-call time also removes b156e680's failure mode at the root:
     * it existed because `command.executed` arrives at the END of a turn and could
     * tag a LATER answer turn, which then had to be rescued by inspecting text. A
     * flag that starts and ends with the connect turn cannot tag a later one.
     */
    connectMirrorSuppressed?: boolean;
    /**
     * DevSpec `session_messages.id` of the live work-trail turn currently open for
     * this connection (item bfca2495). Set from the first `phase:'trail'` post of a
     * turn, cleared when the answer or an error closes it. Its real purpose is
     * knowing whether there IS an open bubble to fail: without it a stalled or dead
     * turn leaves a bubble streaming for ever, which is the one outcome the live
     * trail must never produce. The SERVER still resolves which row to write from
     * the connection itself — this is never sent as a target.
     */
    activeTrailMessageId?: string | null;
    /** Hash of the last trail body posted — skips updates that would change nothing. */
    lastTrailHash?: string | null;
    /** Epoch ms of the last trail post (throttle floor, TRAIL_POST_MIN_GAP_MS). */
    lastTrailPostedAt?: number | null;
    /**
     * OpenCode question the turn is blocked on (item 7b4090e4). While set, the next
     * owner `local_agent_dispatch` is delivered via `client.question.reply` instead
     * of `promptAsync`, and busy-stall does not fire — a human may take minutes.
     */
    pendingQuestion?: {
        requestId: string;
        questionCount: number;
        postedAt: number;
    } | null;
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
export declare function setBusy(directory: string, busy: boolean): Promise<void>;
export declare function assistantTextFromMessage(message: {
    parts?: unknown;
} | null | undefined): string;
/** Shape `post_session_message` accepts for reply model attribution. */
export type OpenCodeModelStamp = {
    providerID: string;
    modelID: string;
};
/**
 * Compact, safe-for-logs preview of an unknown model field — never silent
 * when the stamp guard rejects a shape (Obsidian Gecko / Restless Ocelot).
 */
export declare function summarizeModelShapeSnippet(raw: unknown): string;
/**
 * Extract `{ providerID, modelID }` from OpenCode `message.info.model` (or a
 * dispatch_model override). Accepts common aliases; returns why the stamp
 * failed when the raw value is present but unusable — callers must log that
 * path instead of dropping model silently.
 *
 * Model.Ref nested shapes use `id` for the model slug (`{ providerID, id }`);
 * `id` is accepted as a modelID alias.
 */
export declare function extractOpenCodeReplyModel(raw: unknown): {
    model?: OpenCodeModelStamp;
    missingReason?: 'absent' | 'non_object' | 'missing_fields' | 'empty_fields';
    rawSnippet?: string;
};
/** Where `resolveOpenCodeAssistantModel` found (or failed to find) the stamp. */
export type OpenCodeAssistantModelSource = 'info.flat' | 'info.model' | 'info.metadata.assistant' | 'absent';
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
export declare function resolveOpenCodeAssistantModel(message: {
    info?: unknown;
} | null | undefined): {
    model?: OpenCodeModelStamp;
    missingReason?: 'absent' | 'non_object' | 'missing_fields' | 'empty_fields';
    rawSnippet?: string;
    source: OpenCodeAssistantModelSource;
};
/** Story `data` fragment when a model stamp is known. */
export declare function modelStoryData(model: OpenCodeModelStamp | undefined): Record<string, unknown>;
/**
 * True when the latest assistant message still has an in-flight tool
 * (pending / running). Completed tools alone are not progress — the turn
 * may be wedged between steps with an empty completed tool message.
 */
export declare function messageHasActiveToolWork(message: {
    parts?: unknown;
} | null | undefined): boolean;
/**
 * Stable fingerprint of assistant reasoning/thinking parts. Used by the
 * busy-stall watchdog so a growing MiniMax-style think stream counts as
 * progress even when there is no reply text and no in-flight tool yet.
 * Returns null when the message has no reasoning content.
 */
export declare function assistantReasoningFingerprint(message: {
    parts?: unknown;
} | null | undefined): string | null;
/**
 * True when the latest assistant message indicates OpenCode is waiting on a
 * permission prompt (hung `permission.asked`). Defensive across part shapes
 * OpenCode has used: dedicated permission parts, tool state ask/waiting/
 * permission*, and nested permission flags. A "running" tool alone is NOT
 * enough — that still looks like healthy work until an ask is present.
 */
export declare function messageHasPendingPermissionAsk(message: {
    parts?: unknown;
} | null | undefined): boolean;
/**
 * Record that OpenCode asked for permission (plugin `permission.asked` path).
 * Idempotent on the timestamp — keep the first ask time so the early stall
 * clock does not reset if the event repeats.
 */
export declare function markPermissionAsked(nowMs?: number): void;
/** Clear a pending permission ask (resolved / denied / replied, or busy clear). */
export declare function clearPermissionAsked(): void;
/** Format OpenCode question.asked properties into a DevSpec-readable prompt. */
export declare function formatQuestionPrompt(props: {
    questions?: Array<{
        question?: string;
        header?: string;
        options?: Array<{
            label?: string;
            description?: string;
        }>;
    }>;
}): string;
/**
 * Surface an OpenCode question.asked event as DevSpec needs-your-input on the
 * open live trail turn. Idempotent on the same request id.
 */
export declare function handleQuestionAsked(directory: string, props: Record<string, unknown> | null | undefined): Promise<void>;
/** Clear a pending question after reply/reject/disconnect. */
export declare function clearPendingQuestion(): void;
/**
 * Deliver an owner command into a waiting OpenCode question (not a new prompt).
 * Returns true when the reply was sent (caller should not also promptAsync).
 */
export declare function replyPendingQuestion(input: {
    client: Parameters<Plugin>[0]['client'];
    directory: string;
    answerText: string;
}): Promise<boolean>;
/**
 * Reject a pending OpenCode question (terminal dismiss / disconnect path).
 */
export declare function rejectPendingQuestion(input: {
    client: Parameters<Plugin>[0]['client'];
    directory: string;
    reason?: string;
}): Promise<void>;
export type BusyStallDecision = {
    action: 'under_timeout';
} | {
    action: 'has_text';
} | {
    action: 'slide';
    reason: 'active_tool' | 'new_assistant' | 'reasoning_growth';
    assistantId: string | null;
    /** Present on reasoning_growth so callers can persist the new fingerprint. */
    reasoningFingerprint?: string | null;
} | {
    action: 'stall';
    assistantId: string | null;
    reason: 'permission_asked' | 'empty_assistant_timeout' | 'active_tool_cap';
};
/**
 * Pure stall policy (unit-tested). Call only after `elapsedMs >= timeoutMs`
 * except the early `under_timeout` branch used by callers that still gate
 * on wall-clock first — and the permission-ask early path, which can stall
 * before `timeoutMs` once `permissionAskElapsedMs >= permissionAskStallMs`.
 */
export declare function decideBusyStall(input: {
    elapsedMs: number;
    timeoutMs: number;
    lastAssistant: {
        info?: {
            id?: string;
        };
        parts?: unknown;
    } | null | undefined;
    previousProgressAssistantId?: string | null;
    /** Slides already granted for the current `previousProgressAssistantId` via active_tool. */
    sameAssistantActiveToolSlides?: number;
    maxActiveToolSlides?: number;
    /** Prior reasoning fingerprint from state — growth slides; frozen stalls. */
    previousReasoningFingerprint?: string | null;
    /** Hung permission wait — never treated as active_tool progress. */
    permissionAskPending?: boolean;
    /** ms since `permissionAskedAt` (0 if pending but clock unknown). */
    permissionAskElapsedMs?: number;
    permissionAskStallMs?: number;
}): BusyStallDecision;
/** Normalize reply text before hashing so trivial whitespace drift cannot bypass dedup. */
export declare function normalizePostedContent(text: string): string;
/** Stable short hash of a reply body (used for mirror ↔ manual-post dedup). */
export declare function hashPostedContent(text: string): string;
/**
 * True when this OpenCode assistant message already invoked DevSpec's
 * `post_session_message` (any MCP name variant). Mirror must not post again.
 */
export declare function messageHasPostSessionMessageTool(message: {
    parts?: unknown;
} | null | undefined): boolean;
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
export declare function recordManualPostSessionMessage(toolName: string, args: unknown): void;
/**
 * Spill an oversize attachment to ~/.devspec/opencode-remote-control/attachments/
 * and return a file:// URL OpenCode can open. Used when decoded size exceeds
 * INLINE_DATA_URL_MAX_BYTES but is still under MAX_ATTACHMENT_BYTES.
 */
export declare function materializeLargeAttachmentToDisk(input: {
    filename: string;
    mime: string;
    bytes: number;
    buffer: Buffer;
}): string | null;
/**
 * If we've been busy longer than STALL_TIMEOUT_MS with no observable progress
 * (no reply text, no new assistant step, no in-flight tool, no growing
 * reasoning), clear busy and warn in the DevSpec session. Healthy tool-heavy
 * and long-think turns slide `busySince` instead of false-stalling. A pending
 * `permission.asked` is NOT progress — it never slides and stalls after
 * PERMISSION_ASK_STALL_MS. Called every poll while busy.
 */
export declare function checkBusyStall(client: Parameters<Plugin>[0]['client'], directory: string, sessionId: string): Promise<void>;
/**
 * Handle OpenCode's `session.error` event: clear busy, post into DevSpec,
 * and log the full event payload. Confirmed live (poll.log) that this event
 * fires on MiniMax connect failures — previously only the type+sessionID
 * were logged and busy was left untouched.
 */
export declare function handleSessionError(directory: string, event: unknown): Promise<void>;
/** Run `fn` with all state reads/writes scoped to `opencodeSessionId`'s bond. */
export declare function runWithBond<T>(opencodeSessionId: string, fn: () => T): T;
export declare function runWithBondAsync<T>(opencodeSessionId: string, fn: () => Promise<T>): Promise<T>;
export declare function rememberOpenCodeBond(opencodeSessionId: string, devspecSessionId?: string | null): void;
export declare function forgetOpenCodeBond(opencodeSessionId: string): void;
export declare function listOpenCodeBondSessions(): string[];
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
export declare function shouldAutoAllowRemoteControlPermission(): boolean;
/** Whether this OpenCode session holds a DevSpec bond. The gate for every side effect. */
export declare function isBondedOpenCodeSession(opencodeSessionId: string): boolean;
/** The DevSpec session a bond is attached to, or null/undefined when sessionless/unbonded. */
export declare function devspecSessionForBond(opencodeSessionId: string): string | null | undefined;
/**
 * The bond's state file. One input: the OpenCode session id.
 *
 * This is also the value passed to `register_connection` as `local_id`, so the
 * local file and the server-side connection identity are the same fact stated
 * twice. That symmetry is load-bearing: bond succession (`78a117ab`) revives
 * the `(owner, local_id)` connection within a reconnect window, so a local_id
 * derived from the FOLDER meant a brand-new conversation was handed back the
 * previous one's connection and codename — the server half of the same bug the
 * state key had.
 */
export declare function bondLocalId(opencodeSessionId: string): string;
/** Test helper — drop every bond between cases. */
export declare function resetBondsForTests(): void;
/**
 * The current bond's state, or null when there is no bond in scope.
 *
 * Reading outside `runWithBond` returns null rather than guessing. That is the
 * whole point of the rewrite: "no bond in scope" used to fall through to a
 * process-global and a folder-keyed file, which is how one conversation read
 * another's connection.
 */
export declare function readState(): ConnectionState | null;
/**
 * Full replace of the on-disk state file. Only safe for handshake / clear paths
 * that intentionally own the whole snapshot. Mid-tick poll updates MUST use
 * patchState — a stale `writeState({ ...inMemory })` rolls back concurrent
 * mirror claims (live: session f3af591e double-posted msg_fc80605c).
 */
export declare function writeState(state: ConnectionState): void;
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
export declare function patchState(patch: Partial<ConnectionState>): ConnectionState | null;
/**
 * Bridge between the `/devspec.remote` MARKDOWN command (which has the model
 * call `register_connection`/`attach_connection` directly as raw MCP tool
 * calls) and this file's own local state, which `pollAndDeliver` depends on
 * to know a connection exists at all.
 *
 * Real gap found live-testing: the command completes a genuine connect
 * handshake with DevSpec's server, but never went through `ensureConnection`/
 * `attachSession` above — so no local state file was ever written, and
 * `pollAndDeliver` (gated on `readState()` being non-null) silently
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
export declare function recordConnectionEventFromTool(toolName: string, args: unknown, hookOutput: unknown, opencodeSessionId?: string | null): void;
/**
 * Record an OpenCode `command.executed` for `/devspec.remote` /
 * `/devspec.remote-stop` so mirrorLatestReply never posts that assistant turn.
 *
 * While `awaitingRemoteReply` is set, ignore the event: OpenCode has been
 * observed to fire a late `devspec.remote` command.executed against the
 * *post-inject answer* message id (session 8a97effc). Recording that id would
 * poison nonMirrorMessageIds and skip-mirror the real reply.
 */
export declare function recordRemoteControlSkillCommand(props: Record<string, unknown> | null | undefined): void;
/**
 * Register (or resume) THIS OpenCode session as a DevSpec connection.
 *
 * Idempotent per OpenCode session and nothing else. The old signature took an
 * optional DevSpec session id and used it to pick between candidate state
 * files; that is what let a bare connect resume a stranger's connection. The
 * DevSpec session is not an input to identity here — it is something a bond
 * acquires later, at attach.
 *
 * `local_id` is the hash of the OpenCode session id, so the server's bond
 * succession (`78a117ab`) revives THIS conversation's connection on a reload
 * and nobody else's. A new conversation is a new session id, therefore a new
 * local_id, therefore a genuinely new connection with its own codename.
 */
export declare function ensureConnection(directory: string, opencodeSessionId: string): Promise<{
    auth: ReturnType<typeof resolveDevspecAuth>;
    state: ConnectionState | null;
    error?: string;
}>;
/** Attach this session's connection to a DevSpec session — `/devspec.remote --session <id>`. */
export declare function attachSession(directory: string, opencodeSessionId: string, sessionId: string): Promise<void>;
/** Detach + mark the connection offline — `/devspec.remote-stop`. */
export declare function stopConnection(directory: string, opencodeSessionId: string): Promise<void>;
/**
 * How many consecutive poll failures before a recoverable gateway blip is posted
 * into the room. A single MCP HTTP 502 during a Coolify swap is normal and the
 * pump already retries — posting on attempt 1 made owners think the bond died
 * (session b088b9a6 / Brave Osprey, 2026-08-08). Auth and other hard failures
 * still report on the first hit.
 */
export declare const POLL_ERROR_REPORT_AFTER_TRANSIENT = 3;
/** True for gateway / redeploy-shaped MCP transport errors the pump already retries. */
export declare function isTransientMcpGatewayError(err: unknown): boolean;
/**
 * Whether a poll failure should be mirrored into the DevSpec room.
 * Transient 5xx waits until `POLL_ERROR_REPORT_AFTER_TRANSIENT` consecutive
 * failures; everything else reports immediately (still cooldown-deduped).
 */
export declare function shouldReportPollErrorToRoom(consecutiveErrors: number, err: unknown): boolean;
/** Room-facing copy for a poll failure (softer for recoverable gateway blips). */
export declare function formatPollErrorRoomMessage(stage: string, err: unknown): string;
/** Drop pump state for a connection (teardown / stop). */
export declare function forgetPumpState(connectionId: string): void;
/** Test/helpers: last successful poll timestamp for a connection, or null. */
export declare function getLastSuccessfulPollAt(connectionId: string): number | null;
export declare function recordSuccessfulPoll(connectionId: string, at?: number): void;
/**
 * Emit a presence_gap story when the pump has gone too long without a successful
 * poll while the bond should still look live. Returns true if a warning was logged.
 */
export declare function maybeWarnPresenceGap(input: {
    connectionId: string;
    sessionId?: string | null;
    codename?: string | null;
    busy?: boolean;
    now?: number;
    gapWarnMs?: number;
}): boolean;
export declare function logConnectionEndedStory(input: {
    connectionId: string;
    sessionId?: string | null;
    codename?: string | null;
    endReason: string;
    via: string;
    busy?: boolean;
    now?: number;
}): void;
/**
 * What the pump should do after one poll. `delayMs: 0` is the normal answer — the
 * server HELD the request, so the wait already happened and we go straight back in.
 */
export interface PollOutcome {
    delayMs: number;
    /** The connection is gone server-side: stop pumping and do NOT restart. */
    stop: boolean;
    /** Terminal reason, when stop is true. */
    reason?: string;
}
export declare function pollAndDeliver(client: Parameters<Plugin>[0]['client'], directory: string, sessionId: string, opts?: {
    signal?: AbortSignal;
}): Promise<PollOutcome>;
/**
 * Reset OpenCode LLM context in place (item 8718be5a + siblings 37a7487b / 8a55a89b).
 *
 * Creates a fresh OpenCode SDK session and rebinds the remote-control bond so
 * the pump injects into the blank chat — WITHOUT changing the DevSpec room
 * (`ConnectionState.sessionId`), calling `create_session` / `attach_connection`,
 * or posting chrome into the DevSpec transcript.
 *
 * The state file follows the bond to the new OpenCode session (that IS the key
 * now — item a72a4e22), while `state.sessionId` keeps naming the same DevSpec
 * room. An earlier version conflated those two and briefly rewrote the room id,
 * which looked like a new DevSpec session and could trip server-attachment
 * adopt / re-delivery.
 */
export declare function wipeOpenCodeContextInPlace(input: {
    client: Parameters<Plugin>[0]['client'];
    directory: string;
    /** Current OpenCode session id (the one the bond / pump is on). */
    opencodeSessionId: string;
}): Promise<{
    newOpenCodeSessionId: string;
    preservedDevspecSessionId: string | null;
}>;
/**
 * Run a native OpenCode control slash via SDK (item b315fe42).
 * Posts a short DevSpec answer for most commands; `/new` is silent (8718be5a).
 * Always clears busy so Working never hangs.
 */
export declare function executeOwnerControlSlash(input: {
    client: Parameters<Plugin>[0]['client'];
    directory: string;
    sessionId: string;
    auth: {
        ok: boolean;
        token?: string;
        mcp_url?: string;
    };
    command: OpencodeControlSlash;
    model?: OpenCodeModelStamp;
}): Promise<void>;
/**
 * Kick off an injected owner turn without blocking the presence pump.
 * Presence (`poll_connection`) must keep updating `last_seen` while this runs.
 */
export declare function deliverInjectedTurn(input: {
    client: Parameters<Plugin>[0]['client'];
    directory: string;
    sessionId: string;
    auth: {
        ok: boolean;
        token?: string;
        mcp_url?: string;
    };
    text: string;
    fileParts: unknown[];
    model?: {
        providerID: string;
        modelID: string;
    };
}): Promise<void>;
/**
 * Decide how to correlate assistants while awaiting a remote inject reply.
 *
 * Live (8d0f1726): a concrete baseline id that is *gone* from the current
 * OpenCode session means the serve process rotated under an abandoned inject
 * cursor — clear it instead of fail-closing forever. A failed snapshot at
 * inject time (`baselineCaptured === false`) still fails closed.
 */
export type AwaitingBaselineDecision = {
    action: 'fail_closed_snapshot';
} | {
    action: 'clear_abandoned';
    baseline: string;
} | {
    action: 'wait';
    baseline: string;
} | {
    action: 'slice';
    fromIndex: number;
} | {
    action: 'all';
} | {
    action: 'fail_closed_legacy';
};
export declare function decideAwaitingBaseline(opts: {
    baseline: string | null;
    baselineCaptured: boolean | undefined;
    assistantIds: string[];
}): AwaitingBaselineDecision;
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
export declare function scopeAssistantsAfterBaseline<T extends {
    info?: {
        id?: string;
    };
}>(assistants: T[], decision: AwaitingBaselineDecision): T[];
/**
 * Clear an abandoned inject cursor (vanished baseline after OpenCode session
 * rotate). Returns true when state was cleared.
 */
export declare function clearAbandonedInjectCursor(baseline: string): boolean;
/** Wait after the last message.updated before mirroring — covers tool-call lag. */
export declare const MIRROR_SETTLE_MS = 2000;
export declare function mirrorNow(client: Parameters<Plugin>[0]['client'], directory: string, sessionId: string, { force }?: {
    force?: boolean;
}): Promise<void>;
/**
 * Debounced mirror for `message.updated` — resets on every update so we only
 * run after the turn has gone quiet long enough for a manual post tool to land.
 */
export declare function scheduleMirrorNow(client: Parameters<Plugin>[0]['client'], directory: string, sessionId: string): void;
/** Cancel any pending settle timer and mirror immediately (session.idle path). */
export declare function flushMirrorNow(client: Parameters<Plugin>[0]['client'], directory: string, sessionId: string): void;
/** Debounced/throttled trail publish for `message.updated`. */
export declare function scheduleWorkTrailPost(client: Parameters<Plugin>[0]['client'], directory: string, sessionId: string): void;
/**
 * Serialize and post the current turn's trail, subject to the throttle.
 *
 * Only while a remote turn is actually in flight (`busy` or `awaitingRemoteReply`):
 * a trail posted outside one would open a streaming bubble that nothing is going
 * to close. Best-effort throughout — a failed trail post must never disturb the
 * turn or the mirror that ends it.
 */
export declare function postWorkTrail(client: Parameters<Plugin>[0]['client'], directory: string, sessionId: string, { force, seed }?: {
    force?: boolean;
    seed?: boolean;
}): Promise<void>;
/**
 * DevSpec's `message_id` out of an MCP tool result.
 *
 * `mcpToolsCall` unwraps JSON to `{ message_id, … }`; tests and some call
 * sites still pass the raw MCP envelope. Both shapes are accepted.
 * Mirror answer posts MUST require this id before claiming success (item 6990fd9e).
 */
export declare function extractPostedMessageId(result: unknown): string | null;
/** Whether `phase:'error'|'answer'` actually closed a server-open trail turn. */
export declare function extractClosedTrailTurn(result: unknown): boolean;
/**
 * Parse `post_session_message` (and similar) MCP tool results.
 *
 * `mcpToolsCall` unwraps the JSON body and returns `{ message_id, … }` directly.
 * Some call sites / tests still pass the raw MCP envelope
 * `{ content: [{ type: 'text', text: '<json>' }] }`. Accept both — otherwise a
 * success check on `message_id` always misses and falsely rolls back (or, before
 * the verify fix, never verified at all).
 */
export declare function parsePostedToolJson(result: unknown): Record<string, unknown> | null;
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
export declare function clearInjectTurnState(opts?: {
    unclaim?: boolean;
}): void;
