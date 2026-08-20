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
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENT_NAME } from './agent-identity.js';
import { McpTimeoutError, mcpToolsCall } from './devspec-client.js';
import { resolveDevspecAuth } from './resolve-devspec-auth.js';
import { freezeCanonicalTurn, parseCanonicalIngress, REMOTE_INGRESS_VERSION, selectCanonicalCommandsForPrompt, } from './remote-ingress.js';
import { HOLD_HTTP_GRACE_MS, createCarryBuffer, buildAttachmentParts, emptyTurnBackoffMs, errorBackoffMs, holdFor, pollTerminalReason, RECOVERABLE_TERMINAL_MAX, renderInjectedTurn, resolveServerAttachment, adoptRequiresNullCursorRepoll, } from './poll-turn.js';
import { collapseOrphanMarkdownFences, isDevspecRemoteControlCommand, shouldDeferInjectDuringConnect, unwrapSingleOuterMarkdownFence, } from './mirror-chrome.js';
import { logRemoteControlStory } from './remote-control-story.js';
import { TRAIL_POST_MIN_GAP_MS, TRAIL_SEED_TEXT, serializeTurnTrail, shouldPostTrail, } from './work-trail.js';
import { controlSlashSuccessMessage, } from './opencode-control-slash.js';
export { collapseOrphanMarkdownFences, isDevspecRemoteControlCommand, shouldDeferInjectDuringConnect, unwrapSingleOuterMarkdownFence, } from './mirror-chrome.js';
// Re-exported so the poll-turn split stays an internal refactor for importers.
export { buildAttachmentParts, isDeliverableCommand, pollTerminalReason, PERMANENT_END_REASONS, renderInjectedTurn, resolveServerAttachment, shouldAdvanceMessageCursor, holdFor, adoptRequiresNullCursorRepoll, } from './poll-turn.js';
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
function pollLogFile() {
    return path.join(os.homedir(), '.devspec', 'opencode-remote-control', 'poll.log');
}
export function logPoll(line) {
    try {
        fs.mkdirSync(path.dirname(pollLogFile()), { recursive: true });
        fs.appendFileSync(pollLogFile(), `${new Date().toISOString()} ${line}\n`, 'utf8');
    }
    catch {
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
    const raw = process.env.DEVSPEC_OPENCODE_STALL_MS;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 120_000;
})();
/**
 * Client ceiling for ordinary (non-long-poll) MCP calls on the pump path.
 * `fetch` has no default timeout — a hung keepalive / heartbeat / notice ahead
 * of the next `poll_connection` freezes `last_seen` while the connection still
 * looks attached, and the server eventually ends it with `idle_timeout`
 * (Climbing Koala / Steady Wolf). Matches Claude poller's activity-verb ceiling.
 */
export const MCP_SHORT_CALL_TIMEOUT_MS = 10_000;
/** Tighter ceiling for heartbeat_connection / detach — same as Claude's teardown heartbeats. */
export const MCP_HEARTBEAT_TIMEOUT_MS = 5_000;
/**
 * Ceiling for OpenCode `session.messages` on the pump / stall / inject-baseline
 * paths. A hung SDK call ahead of the next `poll_connection` freezes `last_seen`
 * the same way hung MCP did (item 875d75b5 — Crimson Osprey / Gentle Weasel).
 */
export const OPENCODE_SESSION_API_TIMEOUT_MS = 5_000;
/** Compact/summarize can run a model turn — don't use the short session API ceiling. */
export const OPENCODE_CONTROL_COMPACT_TIMEOUT_MS = 120_000;
function unwrapSdkData(res) {
    if (res && typeof res === 'object' && 'data' in res) {
        return res.data;
    }
    return res;
}
/**
 * Warn (story `presence_gap`) when this many ms pass without a successful
 * `poll_connection` while the bond is still supposed to look live. Server
 * attached liveness is ~90s — warn before that so Axiom shows the starve.
 */
export const PRESENCE_GAP_WARN_MS = 60_000;
/** Minimum spacing between `presence_gap` stories for one connection. */
export const PRESENCE_GAP_WARN_COOLDOWN_MS = 30_000;
/**
 * How many consecutive `active_tool` slides on the SAME assistant id are allowed
 * before we treat the turn as stalled. Eternal "running" tool parts otherwise
 * reset `busySince` forever and keep hammering keepalive while poll never runs.
 */
export const MAX_SAME_ASSISTANT_ACTIVE_TOOL_SLIDES = 2;
/**
 * After OpenCode emits `permission.asked` (or a tool part is stuck in an ask /
 * permission-wait state), how long we wait before clearing busy. A hung
 * permission prompt is not progress — do not slide the busy timer the way a
 * healthy `active_tool` does (live hang: write tool `running` + external_directory
 * ask → multi-slide then ~6 min empty_assistant_timeout).
 */
export const PERMISSION_ASK_STALL_MS = 15_000;
/**
 * Race a promise against a wall-clock ceiling. Used for OpenCode session API
 * calls that have no built-in timeout.
 */
export function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        t.unref?.();
        promise.then((v) => {
            clearTimeout(t);
            resolve(v);
        }, (err) => {
            clearTimeout(t);
            reject(err);
        });
    });
}
function assertSdkAccepted(result, label) {
    if (!result || typeof result !== 'object')
        return;
    const value = result;
    if (value.error != null) {
        const detail = typeof value.error === 'string'
            ? value.error
            : JSON.stringify(value.error);
        throw new Error(`${label} was rejected: ${detail}`);
    }
    const response = value.response;
    if (response && typeof response === 'object' && 'ok' in response && response.ok === false) {
        throw new Error(`${label} was rejected by the OpenCode server`);
    }
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
async function reportActivity(directory, verb) {
    const auth = resolveDevspecAuth(directory);
    const state = readState();
    if (!auth.ok || !auth.token || !auth.mcp_url || !state)
        return;
    const tool = { pickup: 'report_pickup', keepalive: 'report_keepalive', complete: 'report_complete' }[verb];
    try {
        await mcpToolsCall({
            mcpUrl: auth.mcp_url,
            token: auth.token,
            name: tool,
            arguments: { connection_id: state.connectionId },
            timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
        });
    }
    catch (err) {
        // Best-effort — never break the poll loop over this (incl. client timeout).
        logPoll(`reportActivity(${verb}) failed: ${err}`);
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
export async function setBusy(directory, busy) {
    const auth = resolveDevspecAuth(directory);
    const state = readState();
    if (!auth.ok || !auth.token || !auth.mcp_url || !state)
        return;
    if (!busy)
        clearPromptTransactions(state.connectionId);
    if (state.busy === busy) {
        logPoll(`setBusy(${busy}) skipped — already ${state.busy}`);
        return; // already asserted — avoid a redundant call
    }
    logPoll(`setBusy(${busy}) — was ${state.busy}`);
    try {
        await mcpToolsCall({
            mcpUrl: auth.mcp_url,
            token: auth.token,
            name: 'heartbeat_connection',
            // Re-assert the fixed agent identity on every heartbeat, like the Claude
            // poller — the connection can never mislabel itself from a stale state file.
            arguments: { connection_id: state.connectionId, agent_name: AGENT_NAME, status: 'live', busy },
            timeoutMs: MCP_HEARTBEAT_TIMEOUT_MS,
        });
        // patchState re-reads disk — never spread a stale snapshot here (see
        // patchState's doc: that lost-update duplicated mirrored replies).
        patchState({
            busy,
            busySince: busy ? Date.now() : null,
            stallWarnedAt: busy ? null : state.stallWarnedAt ?? null,
            stallProgressAssistantId: busy ? null : state.stallProgressAssistantId ?? null,
            stallActiveToolSlides: busy ? 0 : null,
            stallReasoningFingerprint: null,
            // Permission wait is turn-scoped — clear on both busy edges so a stale
            // ask cannot poison the next turn or linger after we clear busy.
            permissionAskedPending: false,
            permissionAskedAt: null,
        });
    }
    catch (err) {
        // Best-effort — a failed busy assertion must never crash the poll loop.
        logPoll(`setBusy(${busy}) heartbeat_connection call failed: ${err}`);
        return;
    }
    await reportActivity(directory, busy ? 'pickup' : 'complete');
    if (!busy) {
        const after = readState();
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
            });
        }
    }
}
export function assistantTextFromMessage(message) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    return parts
        .filter((p) => p?.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
        .trim();
}
const MODEL_SHAPE_SNIPPET_MAX = 240;
/**
 * Compact, safe-for-logs preview of an unknown model field — never silent
 * when the stamp guard rejects a shape (Obsidian Gecko / Restless Ocelot).
 */
export function summarizeModelShapeSnippet(raw) {
    if (raw === undefined)
        return 'undefined';
    if (raw === null)
        return 'null';
    if (typeof raw === 'string') {
        return raw.length > MODEL_SHAPE_SNIPPET_MAX
            ? `${raw.slice(0, MODEL_SHAPE_SNIPPET_MAX)}…`
            : raw;
    }
    try {
        const json = JSON.stringify(raw);
        if (json == null)
            return Object.prototype.toString.call(raw);
        return json.length > MODEL_SHAPE_SNIPPET_MAX
            ? `${json.slice(0, MODEL_SHAPE_SNIPPET_MAX)}…`
            : json;
    }
    catch {
        return Object.prototype.toString.call(raw);
    }
}
function pickStringField(obj, keys) {
    for (const key of keys) {
        const v = obj[key];
        if (typeof v === 'string' && v.trim())
            return v.trim();
    }
    return null;
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
export function extractOpenCodeReplyModel(raw) {
    if (raw == null)
        return { missingReason: 'absent' };
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed)
            return { missingReason: 'empty_fields', rawSnippet: summarizeModelShapeSnippet(raw) };
        const slash = trimmed.indexOf('/');
        if (slash > 0 && slash < trimmed.length - 1) {
            return {
                model: {
                    providerID: trimmed.slice(0, slash),
                    modelID: trimmed.slice(slash + 1),
                },
            };
        }
        return { missingReason: 'missing_fields', rawSnippet: summarizeModelShapeSnippet(raw) };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { missingReason: 'non_object', rawSnippet: summarizeModelShapeSnippet(raw) };
    }
    const obj = raw;
    const providerID = pickStringField(obj, ['providerID', 'providerId', 'provider']);
    // `id` is OpenCode Model.Ref's model slug (not message id) when paired with providerID.
    const modelID = pickStringField(obj, ['modelID', 'modelId', 'model', 'id']);
    if (providerID && modelID)
        return { model: { providerID, modelID } };
    if (!providerID && !modelID) {
        return { missingReason: 'missing_fields', rawSnippet: summarizeModelShapeSnippet(raw) };
    }
    return { missingReason: 'empty_fields', rawSnippet: summarizeModelShapeSnippet(raw) };
}
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
export function resolveOpenCodeAssistantModel(message) {
    const info = message?.info;
    if (info == null || typeof info !== 'object' || Array.isArray(info)) {
        return {
            missingReason: 'absent',
            rawSnippet: summarizeModelShapeSnippet(info),
            source: 'absent',
        };
    }
    const infoObj = info;
    // 1. Flat assistant shape — do not pass nested `model` into the extractor
    //    (that key is a different shape on user messages).
    const flatRaw = {
        providerID: infoObj.providerID,
        providerId: infoObj.providerId,
        provider: infoObj.provider,
        modelID: infoObj.modelID,
        modelId: infoObj.modelId,
    };
    const hasFlatHint = Object.values(flatRaw).some((v) => typeof v === 'string' && v.trim());
    if (hasFlatHint) {
        const flat = extractOpenCodeReplyModel(flatRaw);
        if (flat.model)
            return { ...flat, source: 'info.flat' };
    }
    // 2. Nested info.model (user-message / Model.Ref style)
    if ('model' in infoObj && infoObj.model != null) {
        const nested = extractOpenCodeReplyModel(infoObj.model);
        if (nested.model)
            return { ...nested, source: 'info.model' };
        // Prefer reporting the nested failure when that field was present.
        const legacy = resolveLegacyAssistantMetadata(infoObj);
        if (legacy?.model)
            return legacy;
        return {
            missingReason: nested.missingReason ?? 'absent',
            rawSnippet: nested.rawSnippet ?? summarizeModelShapeSnippet(infoObj.model),
            source: 'info.model',
        };
    }
    // 3. Legacy metadata.assistant
    const legacy = resolveLegacyAssistantMetadata(infoObj);
    if (legacy)
        return legacy;
    if (hasFlatHint) {
        const flat = extractOpenCodeReplyModel(flatRaw);
        return {
            missingReason: flat.missingReason ?? 'absent',
            rawSnippet: flat.rawSnippet ?? summarizeModelShapeSnippet(flatRaw),
            source: 'info.flat',
        };
    }
    return {
        missingReason: 'absent',
        rawSnippet: summarizeModelShapeSnippet(infoObj),
        source: 'absent',
    };
}
function resolveLegacyAssistantMetadata(infoObj) {
    const meta = infoObj.metadata;
    if (meta == null || typeof meta !== 'object' || Array.isArray(meta))
        return null;
    const assistant = meta.assistant;
    if (assistant == null)
        return null;
    const legacy = extractOpenCodeReplyModel(assistant);
    if (legacy.model)
        return { ...legacy, source: 'info.metadata.assistant' };
    return {
        missingReason: legacy.missingReason ?? 'absent',
        rawSnippet: legacy.rawSnippet ?? summarizeModelShapeSnippet(assistant),
        source: 'info.metadata.assistant',
    };
}
/** Story `data` fragment when a model stamp is known. */
export function modelStoryData(model) {
    if (!model)
        return {};
    return {
        model: `${model.providerID}/${model.modelID}`,
        providerID: model.providerID,
        modelID: model.modelID,
    };
}
/**
 * True when the latest assistant message still has an in-flight tool
 * (pending / running). Completed tools alone are not progress — the turn
 * may be wedged between steps with an empty completed tool message.
 */
export function messageHasActiveToolWork(message) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const p of parts) {
        if (!p || typeof p !== 'object')
            continue;
        const part = p;
        if (part.type !== 'tool')
            continue;
        const state = part.state;
        if (!state || typeof state !== 'object')
            continue;
        const status = String(state.status ?? '').toLowerCase();
        if (status === 'pending' || status === 'running')
            return true;
    }
    return false;
}
/**
 * Stable fingerprint of assistant reasoning/thinking parts. Used by the
 * busy-stall watchdog so a growing MiniMax-style think stream counts as
 * progress even when there is no reply text and no in-flight tool yet.
 * Returns null when the message has no reasoning content.
 */
export function assistantReasoningFingerprint(message) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    const chunks = [];
    for (const p of parts) {
        if (!p || typeof p !== 'object')
            continue;
        const part = p;
        const type = String(part.type ?? '').toLowerCase();
        if (type !== 'reasoning' && type !== 'thinking' && type !== 'thought')
            continue;
        if (typeof part.text === 'string' && part.text.length > 0) {
            chunks.push(part.text);
            continue;
        }
        if (typeof part.content === 'string' && part.content.length > 0) {
            chunks.push(part.content);
        }
    }
    if (chunks.length === 0)
        return null;
    const joined = chunks.join('\n');
    const hash = crypto.createHash('sha256').update(joined, 'utf8').digest('hex').slice(0, 12);
    return `${joined.length}:${hash}`;
}
/**
 * True when the latest assistant message indicates OpenCode is waiting on a
 * permission prompt (hung `permission.asked`). Defensive across part shapes
 * OpenCode has used: dedicated permission parts, tool state ask/waiting/
 * permission*, and nested permission flags. A "running" tool alone is NOT
 * enough — that still looks like healthy work until an ask is present.
 */
export function messageHasPendingPermissionAsk(message) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const p of parts) {
        if (!p || typeof p !== 'object')
            continue;
        const part = p;
        const type = String(part.type ?? '').toLowerCase();
        if (type === 'permission' ||
            type === 'permission_ask' ||
            type === 'permission-ask' ||
            type === 'permission.asked') {
            return true;
        }
        const topStatus = String(part.status ?? '').toLowerCase();
        if (topStatus === 'ask' ||
            topStatus === 'waiting' ||
            topStatus === 'permission' ||
            topStatus === 'permission_ask' ||
            topStatus === 'awaiting_permission' ||
            topStatus.includes('permission')) {
            return true;
        }
        if (part.permission === true || part.permissionAsk === true || part.needsPermission === true) {
            return true;
        }
        const state = part.state;
        if (state && typeof state === 'object') {
            const st = state;
            const status = String(st.status ?? '').toLowerCase();
            if (status === 'ask' ||
                status === 'waiting' ||
                status === 'permission' ||
                status === 'permission_ask' ||
                status === 'awaiting_permission' ||
                status.includes('permission')) {
                return true;
            }
            if (st.permission === true || st.permissionAsk === true || st.needsPermission === true) {
                return true;
            }
            const nestedPerm = st.permission;
            if (nestedPerm && typeof nestedPerm === 'object') {
                const np = nestedPerm;
                const nestStatus = String(np.status ?? np.state ?? '').toLowerCase();
                if (nestStatus === 'ask' ||
                    nestStatus === 'asked' ||
                    nestStatus === 'pending' ||
                    nestStatus === 'waiting' ||
                    nestStatus.includes('ask')) {
                    return true;
                }
            }
        }
    }
    return false;
}
/**
 * Record that OpenCode asked for permission (plugin `permission.asked` path).
 * Idempotent on the timestamp — keep the first ask time so the early stall
 * clock does not reset if the event repeats.
 */
export function markPermissionAsked(nowMs = Date.now()) {
    const state = readState();
    if (!state)
        return;
    if (state.permissionAskedPending && state.permissionAskedAt != null) {
        logPoll(`markPermissionAsked: already pending since ${state.permissionAskedAt}`);
        return;
    }
    patchState({
        permissionAskedPending: true,
        permissionAskedAt: state.permissionAskedAt ?? nowMs,
    });
    logPoll(`markPermissionAsked: pending permission ask at ${state.permissionAskedAt ?? nowMs}`);
}
/** Clear a pending permission ask (resolved / denied / replied, or busy clear). */
export function clearPermissionAsked() {
    const state = readState();
    if (!state)
        return;
    if (!state.permissionAskedPending && state.permissionAskedAt == null)
        return;
    patchState({
        permissionAskedPending: false,
        permissionAskedAt: null,
    });
    logPoll('clearPermissionAsked: cleared pending permission ask');
}
/** Format OpenCode question.asked properties into a DevSpec-readable prompt. */
export function formatQuestionPrompt(props) {
    const questions = Array.isArray(props.questions) ? props.questions : [];
    if (questions.length === 0)
        return 'OpenCode needs your input.';
    const blocks = questions.map((q, i) => {
        const header = typeof q.header === 'string' && q.header.trim() ? q.header.trim() : null;
        const body = typeof q.question === 'string' && q.question.trim() ? q.question.trim() : 'Question';
        const opts = Array.isArray(q.options)
            ? q.options
                .map((o) => {
                const label = typeof o?.label === 'string' ? o.label.trim() : '';
                if (!label)
                    return null;
                const desc = typeof o?.description === 'string' && o.description.trim() ? ` — ${o.description.trim()}` : '';
                return `- ${label}${desc}`;
            })
                .filter(Boolean)
            : [];
        const title = questions.length > 1 ? `${i + 1}. ${header ? `${header}: ` : ''}${body}` : `${header ? `${header}: ` : ''}${body}`;
        return opts.length > 0 ? `${title}\n${opts.join('\n')}` : title;
    });
    return blocks.join('\n\n');
}
/**
 * Surface an OpenCode question.asked event as DevSpec needs-your-input on the
 * open live trail turn. Idempotent on the same request id.
 */
export async function handleQuestionAsked(directory, props) {
    const requestId = typeof props?.id === 'string' ? props.id.trim() : '';
    if (!requestId) {
        logPoll('handleQuestionAsked: missing request id — ignored');
        return;
    }
    const state = readState();
    if (!state?.connectionId) {
        logPoll(`handleQuestionAsked: no connection for request ${requestId}`);
        return;
    }
    if (state.pendingQuestion?.requestId === requestId) {
        logPoll(`handleQuestionAsked: already pending ${requestId}`);
        return;
    }
    const questions = Array.isArray(props?.questions) ? props.questions : [];
    const prompt = formatQuestionPrompt({ questions: questions });
    const auth = resolveDevspecAuth(directory);
    if (!auth.ok || !auth.token || !auth.mcp_url)
        return;
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
        });
        const messageId = extractPostedMessageId(result);
        patchState({
            pendingQuestion: {
                requestId,
                questionCount: Math.max(1, questions.length),
                postedAt: Date.now(),
            },
            ...(messageId ? { activeTrailMessageId: messageId } : {}),
        });
        logPoll(`handleQuestionAsked: posted needs_input request=${requestId} message=${messageId ?? 'n/a'}`);
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
        });
    }
    catch (err) {
        logPoll(`handleQuestionAsked: post failed: ${err}`);
    }
}
/** Clear a pending question after reply/reject/disconnect. */
export function clearPendingQuestion() {
    const state = readState();
    if (!state?.pendingQuestion)
        return;
    patchState({ pendingQuestion: null });
    logPoll('clearPendingQuestion: cleared');
}
/**
 * Deliver an owner command into a waiting OpenCode question (not a new prompt).
 * Returns true when the reply was sent (caller should not also promptAsync).
 */
export async function replyPendingQuestion(input) {
    const { client, directory, answerText } = input;
    const state = readState();
    const pending = state?.pendingQuestion;
    if (!state || !pending?.requestId)
        return false;
    const text = answerText.trim();
    if (!text) {
        logPoll('replyPendingQuestion: empty answer — not sending');
        return false;
    }
    const answers = Array.from({ length: Math.max(1, pending.questionCount) }, () => [text]);
    try {
        await withTimeout(client.question.reply({
            requestID: pending.requestId,
            answers,
        }), OPENCODE_SESSION_API_TIMEOUT_MS, 'question.reply');
        clearPendingQuestion();
        logPoll(`replyPendingQuestion: replied to ${pending.requestId}`);
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
        });
        return true;
    }
    catch (err) {
        logPoll(`replyPendingQuestion: failed: ${err}`);
        return false;
    }
}
/**
 * Reject a pending OpenCode question (terminal dismiss / disconnect path).
 */
export async function rejectPendingQuestion(input) {
    const { client, directory, reason } = input;
    const state = readState();
    const pending = state?.pendingQuestion;
    if (!state || !pending?.requestId)
        return;
    try {
        await withTimeout(client.question.reject({ requestID: pending.requestId }), OPENCODE_SESSION_API_TIMEOUT_MS, 'question.reject');
    }
    catch (err) {
        logPoll(`rejectPendingQuestion: reject call failed: ${err}`);
    }
    clearPendingQuestion();
    const auth = resolveDevspecAuth(directory);
    if (auth.ok && auth.token && auth.mcp_url) {
        await failOpenTrailTurn(auth, state, reason ?? 'OpenCode question was dismissed before an answer arrived.');
    }
}
/**
 * Pure stall policy (unit-tested). Call only after `elapsedMs >= timeoutMs`
 * except the early `under_timeout` branch used by callers that still gate
 * on wall-clock first — and the permission-ask early path, which can stall
 * before `timeoutMs` once `permissionAskElapsedMs >= permissionAskStallMs`.
 */
export function decideBusyStall(input) {
    const lastId = typeof input.lastAssistant?.info?.id === 'string' && input.lastAssistant.info.id.length > 0
        ? input.lastAssistant.info.id
        : null;
    if (assistantTextFromMessage(input.lastAssistant))
        return { action: 'has_text' };
    const permissionPending = !!input.permissionAskPending || messageHasPendingPermissionAsk(input.lastAssistant);
    const askStallMs = input.permissionAskStallMs ?? PERMISSION_ASK_STALL_MS;
    const askElapsed = input.permissionAskElapsedMs ?? 0;
    if (permissionPending) {
        // Never slide on active_tool while a permission ask is outstanding — the
        // tool looks "running" but nothing can proceed until a human answers.
        if (askElapsed >= askStallMs) {
            return { action: 'stall', assistantId: lastId, reason: 'permission_asked' };
        }
        return { action: 'under_timeout' };
    }
    if (input.elapsedMs < input.timeoutMs)
        return { action: 'under_timeout' };
    if (messageHasActiveToolWork(input.lastAssistant)) {
        const prev = input.previousProgressAssistantId ?? null;
        const slides = input.sameAssistantActiveToolSlides ?? 0;
        const max = input.maxActiveToolSlides ?? MAX_SAME_ASSISTANT_ACTIVE_TOOL_SLIDES;
        // Same stuck "running" tool forever is not progress — cap slides so keepalive
        // cannot starve poll_connection until the server idle_timeouts the bond.
        if (lastId && lastId === prev && slides >= max) {
            return { action: 'stall', assistantId: lastId, reason: 'active_tool_cap' };
        }
        return { action: 'slide', reason: 'active_tool', assistantId: lastId };
    }
    const reasoningFp = assistantReasoningFingerprint(input.lastAssistant);
    const prevReasoning = input.previousReasoningFingerprint ?? null;
    if (reasoningFp && reasoningFp !== prevReasoning) {
        return {
            action: 'slide',
            reason: 'reasoning_growth',
            assistantId: lastId,
            reasoningFingerprint: reasoningFp,
        };
    }
    const prev = input.previousProgressAssistantId ?? null;
    if (lastId && lastId !== prev) {
        return { action: 'slide', reason: 'new_assistant', assistantId: lastId };
    }
    return { action: 'stall', assistantId: lastId, reason: 'empty_assistant_timeout' };
}
/** Normalize reply text before hashing so trivial whitespace drift cannot bypass dedup. */
export function normalizePostedContent(text) {
    return String(text ?? '')
        .replace(/\r\n/g, '\n')
        .trim();
}
/** Stable short hash of a reply body (used for mirror ↔ manual-post dedup). */
export function hashPostedContent(text) {
    return crypto.createHash('sha256').update(normalizePostedContent(text), 'utf8').digest('hex').slice(0, 32);
}
/**
 * True when this OpenCode assistant message already invoked DevSpec's
 * `post_session_message` (any MCP name variant). Mirror must not post again.
 */
export function messageHasPostSessionMessageTool(message) {
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const p of parts) {
        if (!p || typeof p !== 'object')
            continue;
        const part = p;
        const candidates = [part.tool, part.name, part.toolName, part.call]
            .filter((v) => typeof v === 'string')
            .map((v) => v.toLowerCase());
        for (const name of candidates) {
            if (name === 'post_session_message' || name.endsWith('_post_session_message') || name.endsWith('/post_session_message')) {
                return true;
            }
        }
        // Nested tool metadata shapes observed across OpenCode versions.
        const nested = part.tool;
        if (nested && typeof nested === 'object') {
            const nestedName = typeof nested.name === 'string' ? nested.name.toLowerCase() : '';
            if (nestedName === 'post_session_message' ||
                nestedName.endsWith('_post_session_message') ||
                nestedName.endsWith('/post_session_message')) {
                return true;
            }
        }
    }
    return false;
}
function rememberPostedContentHash(hash) {
    const state = readState();
    if (!state)
        return;
    const prev = state.recentPostedContentHashes ?? [];
    if (prev.includes(hash))
        return;
    patchState({
        recentPostedContentHashes: [...prev, hash].slice(-40),
    });
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
export function recordManualPostSessionMessage(toolName, args) {
    const lower = String(toolName ?? '').toLowerCase();
    if (lower !== 'post_session_message' &&
        !lower.endsWith('_post_session_message') &&
        !lower.endsWith('/post_session_message') &&
        lower !== 'devspec_post_session_message') {
        return;
    }
    const argsObj = (args && typeof args === 'object' ? args : {});
    const message = typeof argsObj.message === 'string' ? argsObj.message : null;
    if (!message || !normalizePostedContent(message)) {
        logPoll(`recordManualPostSessionMessage: model called post_session_message with an empty/whitespace ` +
            `message — nothing to dedup, not recording a hash`);
        return;
    }
    const hash = hashPostedContent(message);
    rememberPostedContentHash(hash);
    const state = readState();
    if (state?.awaitingRemoteReply && !state.manualAnswerPostedThisTurn) {
        patchState({ manualAnswerPostedThisTurn: true });
    }
    logPoll(`recordManualPostSessionMessage: remembered hash=${hash.slice(0, 8)}… ` +
        `awaitingRemoteReply=${Boolean(state?.awaitingRemoteReply)}`);
}
/**
 * Spill an oversize attachment to ~/.devspec/opencode-remote-control/attachments/
 * and return a file:// URL OpenCode can open. Used when decoded size exceeds
 * INLINE_DATA_URL_MAX_BYTES but is still under MAX_ATTACHMENT_BYTES.
 */
export function materializeLargeAttachmentToDisk(input) {
    try {
        const dir = path.join(os.homedir(), '.devspec', 'opencode-remote-control', 'attachments');
        fs.mkdirSync(dir, { recursive: true });
        const safe = String(input.filename || 'attachment')
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .slice(0, 80) || 'attachment';
        const filePath = path.join(dir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`);
        fs.writeFileSync(filePath, input.buffer);
        const url = pathToFileURL(filePath).href;
        logPoll(`materializeLargeAttachmentToDisk: wrote ${input.bytes}B → ${filePath} (${input.mime})`);
        return url;
    }
    catch (err) {
        logPoll(`materializeLargeAttachmentToDisk failed: ${err}`);
        return null;
    }
}
/** Prefer connection_id so the server uses the current attachment (reattach-safe). */
function postMessageArgs(state, message, extras) {
    const args = {
        message,
        agent_name: AGENT_NAME,
        ...(extras?.turn_kind ? { turn_kind: extras.turn_kind } : {}),
        ...(extras?.model ? { model: extras.model } : {}),
        ...(extras?.phase ? { phase: extras.phase } : {}),
        ...(extras?.needs_input ? { needs_input: extras.needs_input } : {}),
        ...(extras?.complete_turn ? { complete_turn: true } : {}),
    };
    if (state.connectionId)
        args.connection_id = state.connectionId;
    else if (state.sessionId)
        args.session_id = state.sessionId;
    return args;
}
async function postSessionNotice(auth, state, message) {
    if (!auth.ok || !auth.token || !auth.mcp_url)
        return;
    // Notices still need an attached session; connection_id path rejects sessionless.
    if (!state.sessionId && !state.connectionId)
        return;
    try {
        await mcpToolsCall({
            mcpUrl: auth.mcp_url,
            token: auth.token,
            name: 'post_session_message',
            arguments: postMessageArgs(state, message, { turn_kind: 'agent' }),
            timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
        });
    }
    catch (err) {
        logPoll(`postSessionNotice failed: ${err}`);
    }
}
/**
 * If we've been busy longer than STALL_TIMEOUT_MS with no observable progress
 * (no reply text, no new assistant step, no in-flight tool, no growing
 * reasoning), clear busy and warn in the DevSpec session. Healthy tool-heavy
 * and long-think turns slide `busySince` instead of false-stalling. A pending
 * `permission.asked` is NOT progress — it never slides and stalls after
 * PERMISSION_ASK_STALL_MS. Called every poll while busy.
 */
export async function checkBusyStall(client, directory, sessionId) {
    const auth = resolveDevspecAuth(directory);
    let state = readState();
    if (!auth.ok || !auth.token || !auth.mcp_url || !state?.busy || !state.sessionId)
        return;
    // Waiting on a DevSpec-surfaced OpenCode question is not a stall — the human
    // may answer from phone/web minutes later (item 7b4090e4).
    if (state.pendingQuestion?.requestId) {
        logPoll(`stall check: pending question ${state.pendingQuestion.requestId} — waiting on owner, not stalling`);
        return;
    }
    // Older state files may have busy:true with no busySince — seed now so we
    // don't immediately treat a mid-flight upgrade as already timed out.
    if (!state.busySince) {
        patchState({ busySince: Date.now() });
        logPoll(`stall check: seeded busySince for pre-existing busy=true`);
        return;
    }
    const elapsed = Date.now() - state.busySince;
    const permissionPendingFromState = !!state.permissionAskedPending;
    const permissionAskElapsed = state.permissionAskedAt != null ? Date.now() - state.permissionAskedAt : 0;
    const mayPermissionStallEarly = permissionPendingFromState && permissionAskElapsed >= PERMISSION_ASK_STALL_MS;
    if (!mayPermissionStallEarly && elapsed < STALL_TIMEOUT_MS) {
        logPoll(`stall check: busy ${elapsed}ms (< ${STALL_TIMEOUT_MS}ms)` +
            (permissionPendingFromState
                ? ` permission_ask ${permissionAskElapsed}ms (< ${PERMISSION_ASK_STALL_MS}ms)`
                : '') +
            ' — ok');
        return;
    }
    let messages;
    try {
        const res = await withTimeout(client.session.messages({ path: { id: sessionId } }), OPENCODE_SESSION_API_TIMEOUT_MS, 'session.messages(stall)');
        messages = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    }
    catch (err) {
        logPoll(`stall check: client.session.messages failed: ${err}`);
        return;
    }
    const assistantMessages = messages.filter((m) => m?.info?.role === 'assistant');
    // Item 40279ae0: scope progress to assistants AFTER the pre-inject baseline,
    // not the global last assistant. The old global-last version had a real bug:
    // a freshly-injected turn's stall check could see the PRE-inject assistant's
    // old text — from a completely different, already-answered turn — and report
    // "last assistant has text — not a stall" even though THIS turn had produced
    // nothing at all yet. Mirrors the same correlation `mirrorLatestReply` uses.
    const baselineDecision = decideAwaitingBaseline({
        baseline: state.replyAfterOpenCodeMessageId ?? null,
        baselineCaptured: state.replyBaselineCaptured,
        assistantIds: assistantMessages.map((m) => m?.info?.id).filter(Boolean),
    });
    if (baselineDecision.action === 'clear_abandoned') {
        // The pre-inject baseline id is gone from the current OpenCode session
        // (session rotated under an abandoned turn — 8d0f1726). There is nothing
        // to evaluate progress against; recover immediately instead of waiting
        // out the stall timeout on a cursor that can never resolve.
        clearAbandonedInjectCursor(baselineDecision.baseline);
        clearInjectTurnState({ unclaim: true });
        logPoll(`stall check: abandoned inject cursor (baseline ${baselineDecision.baseline} not in current ` +
            `session) — cleared busy/awaiting immediately`);
        return;
    }
    const scopedAssistants = scopeAssistantsAfterBaseline(assistantMessages, baselineDecision);
    const last = scopedAssistants[scopedAssistants.length - 1];
    const fromMessage = messageHasPendingPermissionAsk(last);
    const permissionAskPending = permissionPendingFromState || fromMessage;
    // Late message-only detection (no event): treat the ask window as already
    // elapsed so we stall instead of sliding active_tool into another 2+ minutes.
    const permissionAskElapsedMs = state.permissionAskedAt != null
        ? Date.now() - state.permissionAskedAt
        : fromMessage && !permissionPendingFromState
            ? PERMISSION_ASK_STALL_MS
            : permissionPendingFromState
                ? permissionAskElapsed
                : 0;
    if (fromMessage && !permissionPendingFromState) {
        patchState({
            permissionAskedPending: true,
            permissionAskedAt: state.permissionAskedAt ?? Date.now() - PERMISSION_ASK_STALL_MS,
        });
        state = readState() ?? state;
    }
    const decision = decideBusyStall({
        elapsedMs: elapsed,
        timeoutMs: STALL_TIMEOUT_MS,
        lastAssistant: last,
        previousProgressAssistantId: state.stallProgressAssistantId,
        sameAssistantActiveToolSlides: state.stallActiveToolSlides ?? 0,
        maxActiveToolSlides: MAX_SAME_ASSISTANT_ACTIVE_TOOL_SLIDES,
        previousReasoningFingerprint: state.stallReasoningFingerprint ?? null,
        permissionAskPending,
        permissionAskElapsedMs,
        permissionAskStallMs: PERMISSION_ASK_STALL_MS,
    });
    if (decision.action === 'has_text') {
        logPoll(`stall check: busy ${elapsed}ms but last assistant (${last?.info?.id}) has text — not a stall`);
        return;
    }
    if (decision.action === 'under_timeout') {
        logPoll(`stall check: under_timeout` +
            (permissionAskPending
                ? ` (permission ask ${permissionAskElapsedMs}ms / ${PERMISSION_ASK_STALL_MS}ms)`
                : ` (busy ${elapsed}ms)`));
        return;
    }
    if (decision.action === 'slide') {
        const now = Date.now();
        const sameAssistant = decision.reason === 'active_tool' &&
            decision.assistantId != null &&
            decision.assistantId === (state.stallProgressAssistantId ?? null);
        const nextSlides = decision.reason === 'active_tool' ? (sameAssistant ? (state.stallActiveToolSlides ?? 0) + 1 : 1) : 0;
        const nextReasoningFp = decision.reason === 'reasoning_growth'
            ? (decision.reasoningFingerprint ?? assistantReasoningFingerprint(last))
            : decision.reason === 'new_assistant'
                ? assistantReasoningFingerprint(last)
                : (state.stallReasoningFingerprint ?? null);
        patchState({
            busySince: now,
            stallProgressAssistantId: decision.assistantId,
            stallActiveToolSlides: nextSlides,
            stallReasoningFingerprint: nextReasoningFp,
        });
        logPoll(`stall check: progress (${decision.reason}) on ${decision.assistantId ?? 'none'} — slid busySince after ${elapsed}ms` +
            (decision.reason === 'active_tool' ? ` (active_tool slides=${nextSlides})` : '') +
            (decision.reason === 'reasoning_growth' ? ` (reasoning=${nextReasoningFp})` : ''));
        return;
    }
    if (decision.action !== 'stall')
        return;
    if (state.stallWarnedAt === state.busySince) {
        logPoll(`stall check: already warned for busySince=${state.busySince} — clearing busy again`);
        await setBusy(directory, false);
        return;
    }
    const lastId = decision.assistantId ?? 'none';
    const stallReason = decision.reason;
    logPoll(`STALL: busy ${elapsed}ms reason=${stallReason} (last.id=${lastId}) — clearing busy and posting warning`);
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
    });
    patchState({ stallWarnedAt: state.busySince });
    const notice = stallReason === 'permission_asked'
        ? `⚠️ OpenCode turn stalled after a hung permission ask ` +
            `(~${Math.round((permissionAskElapsedMs || elapsed) / 1000)}s; assistant \`${lastId}\`). ` +
            `Cleared the busy indicator — approve/deny the permission in the TUI or check ` +
            `~/.devspec/opencode-remote-control/poll.log.`
        : `⚠️ OpenCode turn stalled after ${Math.round(elapsed / 1000)}s with no reply text ` +
            `(assistant message \`${lastId}\`). Cleared the busy indicator — check ` +
            `~/.devspec/opencode-remote-control/poll.log if this keeps happening.`;
    // A stall is exactly the case a live trail bubble cannot survive: the turn is
    // over and no answer is coming, so failing the open bubble (which keeps the
    // trail readable under error chrome) says more than a separate notice under a
    // turn still claiming to stream. Fall back to the notice when none is open.
    const failedTrail = await failOpenTrailTurn(auth, readState() ?? state, notice);
    if (!failedTrail)
        await postSessionNotice(auth, state, notice);
    // Item 40279ae0: this IS the abnormal end — unclaim this turn's command ids
    // from `deliveredMessageIds` so they are eligible to re-inject, breaking the
    // seedKept>0/inject=0 hold loop a stalled-but-never-answered command used to
    // cause. `failOpenTrailTurn` above already cleared the non-unclaiming parts
    // of inject-turn state; this call additionally unclaims.
    clearInjectTurnState({ unclaim: true });
    await setBusy(directory, false);
}
/**
 * Handle OpenCode's `session.error` event: clear busy, post into DevSpec,
 * and log the full event payload. Confirmed live (poll.log) that this event
 * fires on MiniMax connect failures — previously only the type+sessionID
 * were logged and busy was left untouched.
 */
export async function handleSessionError(directory, event) {
    const auth = resolveDevspecAuth(directory);
    const state = readState();
    let detail = '';
    try {
        detail = JSON.stringify(event);
    }
    catch {
        detail = String(event);
    }
    if (detail.length > 2000)
        detail = `${detail.slice(0, 2000)}…`;
    logPoll(`session.error handled: ${detail}`);
    if (state && auth.ok && (state.sessionId || state.connectionId)) {
        const notice = `⚠️ OpenCode reported \`session.error\`. Busy cleared. Detail: ${detail}`;
        // Same reasoning as the stall path: close the open live-trail bubble as
        // failed so it stops streaming, keeping the trail visible; only post a
        // standalone notice when this turn never opened one.
        const failedTrail = await failOpenTrailTurn(auth, state, notice);
        if (!failedTrail)
            await postSessionNotice(auth, state, notice);
    }
    // Item 40279ae0: a session.error is an abnormal end for whatever turn was
    // in flight — unclaim its command ids so they can re-inject instead of
    // being silently swallowed forever by the delivery dedup set.
    clearInjectTurnState({ unclaim: true });
    await setBusy(directory, false);
}
/**
 * Live bonds in this process, keyed by OpenCode session id. The pump iterates
 * this so a second `/devspec.remote` ADDS a bond rather than overwriting a
 * single pin (Ivory Panda idle_timeout when Racing Dolphin attached,
 * 2026-08-07 — item 7a9b7b0f). Multi-bond gets simpler under this key, not
 * harder: two bonded sessions are two entries, not two candidate files
 * reconciled through one global.
 */
const openCodeBonds = new Map();
/**
 * The OpenCode session whose bond the current async context is operating on.
 *
 * This is now the ONLY carrier of bond identity — there is no process-global
 * beneath it and no fallback when the store is empty. Ambient async scoping is
 * the right shape for it (every poll, inject and mirror is already one async
 * operation belonging to exactly one bond), but it must be a hard requirement:
 * `undefined` means "nobody said which bond", and the only safe answer to that
 * is to touch nothing.
 */
const bondAls = new AsyncLocalStorage();
/** The current bond's OpenCode session id, or undefined outside `runWithBond`. */
function currentBondSessionId() {
    return bondAls.getStore();
}
/** Run `fn` with all state reads/writes scoped to `opencodeSessionId`'s bond. */
export function runWithBond(opencodeSessionId, fn) {
    return bondAls.run(opencodeSessionId, fn);
}
export async function runWithBondAsync(opencodeSessionId, fn) {
    return bondAls.run(opencodeSessionId, fn);
}
export function rememberOpenCodeBond(opencodeSessionId, devspecSessionId = null) {
    if (!opencodeSessionId)
        return;
    openCodeBonds.set(opencodeSessionId, { devspecSessionId });
    logPoll(`bond remember opencodeSession=${opencodeSessionId} ` +
        `devspecSession=${devspecSessionId ?? '(sessionless)'} (active=${openCodeBonds.size})`);
}
export function forgetOpenCodeBond(opencodeSessionId) {
    if (!opencodeSessionId)
        return;
    if (!openCodeBonds.delete(opencodeSessionId))
        return;
    logPoll(`bond forget opencodeSession=${opencodeSessionId} (active=${openCodeBonds.size})`);
}
export function listOpenCodeBondSessions() {
    return [...openCodeBonds.keys()];
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
export function shouldAutoAllowRemoteControlPermission() {
    return listOpenCodeBondSessions().length > 0;
}
/** Whether this OpenCode session holds a DevSpec bond. The gate for every side effect. */
export function isBondedOpenCodeSession(opencodeSessionId) {
    return openCodeBonds.has(opencodeSessionId);
}
/** The DevSpec session a bond is attached to, or null/undefined when sessionless/unbonded. */
export function devspecSessionForBond(opencodeSessionId) {
    return openCodeBonds.get(opencodeSessionId)?.devspecSessionId;
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
function hashKey(raw) {
    return crypto.createHash('sha256').update(raw).digest('base64url').slice(0, 32);
}
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
export function bondLocalId(opencodeSessionId) {
    return hashKey(opencodeSessionId);
}
function stateFileForBond(opencodeSessionId) {
    const dir = path.join(os.homedir(), '.devspec', 'opencode-remote-control');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${bondLocalId(opencodeSessionId)}.json`);
}
function readBondState(opencodeSessionId) {
    try {
        return JSON.parse(fs.readFileSync(stateFileForBond(opencodeSessionId), "utf8"));
    }
    catch {
        return null;
    }
}
/** Test helper — drop every bond between cases. */
export function resetBondsForTests() {
    openCodeBonds.clear();
}
/**
 * The current bond's state, or null when there is no bond in scope.
 *
 * Reading outside `runWithBond` returns null rather than guessing. That is the
 * whole point of the rewrite: "no bond in scope" used to fall through to a
 * process-global and a folder-keyed file, which is how one conversation read
 * another's connection.
 */
export function readState() {
    const bond = currentBondSessionId();
    if (!bond)
        return null;
    return readBondState(bond);
}
/**
 * Full replace of the on-disk state file. Only safe for handshake / clear paths
 * that intentionally own the whole snapshot. Mid-tick poll updates MUST use
 * patchState — a stale `writeState({ ...inMemory })` rolls back concurrent
 * mirror claims (live: session f3af591e double-posted msg_fc80605c).
 */
export function writeState(state) {
    const bond = currentBondSessionId();
    if (!bond) {
        // Never write to a guessed location. A caller outside a bond scope is a
        // bug in the caller, and silently picking a file is what this rewrite
        // exists to stop.
        logPoll('writeState called with no bond in scope — refused');
        return;
    }
    fs.writeFileSync(stateFileForBond(bond), JSON.stringify(state, null, 2), { mode: 0o600 });
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
export function patchState(patch) {
    const current = readState();
    if (!current)
        return null;
    const next = { ...current, ...patch };
    writeState(next);
    return next;
}
function clearState() {
    const bond = currentBondSessionId();
    if (!bond)
        return;
    try {
        fs.unlinkSync(stateFileForBond(bond));
    }
    catch {
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
export function recordConnectionEventFromTool(toolName, args, hookOutput, opencodeSessionId) {
    const isRegister = toolName === 'devspec_register_connection' || toolName.endsWith('register_connection');
    const isAttach = toolName === 'devspec_attach_connection' || toolName.endsWith('attach_connection');
    if (!isRegister && !isAttach)
        return;
    // The handshake belongs to the session that performed it, and this hook fires
    // outside any bond scope — so establish one here or there is nowhere to write.
    // Without a session id the result cannot be attributed to any conversation,
    // which is the same reason every other path refuses.
    if (!opencodeSessionId) {
        logPoll(`recordConnectionEventFromTool: ${toolName} carried no OpenCode session id — ignored`);
        return;
    }
    runWithBond(opencodeSessionId, () => recordConnectionEventInBond(isRegister, args, hookOutput, opencodeSessionId));
}
function recordConnectionEventInBond(isRegister, args, hookOutput, opencodeSessionId) {
    const out = (hookOutput && typeof hookOutput === 'object' ? hookOutput : {});
    const mcpContent = Array.isArray(out.content) ? out.content : null;
    const rawText = typeof out.output === 'string'
        ? out.output
        : mcpContent && typeof mcpContent[0]?.text === 'string'
            ? mcpContent[0].text
            : null;
    if (!rawText)
        return;
    let result;
    try {
        result = JSON.parse(rawText);
    }
    catch {
        return;
    }
    const argsObj = (args && typeof args === 'object' ? args : {});
    if (isRegister) {
        // This lands in THIS OpenCode session's own file, both now and after a
        // later attach: the key is the session id and it never changes, so there is
        // no second location for a snapshot to migrate into.
        const existing = readState();
        const connectionId = typeof result?.connection_id === 'string' ? result.connection_id : existing?.connectionId;
        if (!connectionId)
            return;
        if (existing) {
            // Preserve awaiting/busy/baseline — a register that races an inject
            // must not wipe the inject cursor (hand-picked writeState used to).
            patchState({
                connectionId,
                codename: typeof result?.codename === 'string' ? result.codename : existing.codename,
                connectMirrorSuppressed: true,
            });
        }
        else {
            writeState({
                connectionId,
                sessionId: null,
                codename: typeof result?.codename === 'string' ? result.codename : null,
                connectMirrorSuppressed: true,
            });
        }
        // Sessionless bond. The key does not change when this session later
        // attaches — only the recorded devspecSessionId does.
        if (opencodeSessionId) {
            rememberOpenCodeBond(opencodeSessionId, devspecSessionForBond(opencodeSessionId) ?? null);
        }
        return;
    }
    // Attach: connection_id/session_id may come back on the result, or only be
    // present on the call's own args (DevSpec's attach_connection echoes both,
    // but don't assume — fall back to what the model was called with). Prefer
    // the server's full UUID over a short prefix in args (ce0dab86).
    const sessionId = typeof result?.session_id === 'string'
        ? result.session_id
        : typeof argsObj.session_id === 'string'
            ? argsObj.session_id
            : null;
    if (!sessionId)
        return;
    const connectionIdHint = typeof result?.connection_id === 'string'
        ? result.connection_id
        : typeof argsObj.connection_id === 'string'
            ? argsObj.connection_id
            : undefined;
    // Attach records the room on the bond that already exists. Nothing moves:
    // the state key is this OpenCode session and it does not change, so the
    // inject cursor an in-flight turn is holding stays exactly where it is.
    // That is what makes d5efd533's donor migration unnecessary rather than
    // merely deleted — the failure it fixed (awaiting lost across a key flip)
    // cannot occur when there is no key flip.
    const prior = readState();
    const connectionId = connectionIdHint ?? prior?.connectionId;
    if (!connectionId)
        return;
    if (!prior) {
        writeState({
            connectionId,
            sessionId,
            codename: null,
            connectMirrorSuppressed: true,
        });
    }
    else {
        patchState({
            connectionId,
            sessionId,
            // First time this bond learns its room: suppress the connect turn's own
            // assistant message, which is chrome for the terminal, not an answer.
            connectMirrorSuppressed: prior.sessionId ? prior.connectMirrorSuppressed : true,
        });
    }
    if (opencodeSessionId)
        rememberOpenCodeBond(opencodeSessionId, sessionId);
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
export function recordRemoteControlSkillCommand(props) {
    if (!props)
        return;
    if (!isDevspecRemoteControlCommand(props.name))
        return;
    const messageId = typeof props.messageID === 'string' ? props.messageID : null;
    if (!messageId)
        return;
    const existing = readState();
    if (!existing)
        return;
    if (existing.awaitingRemoteReply) {
        logPoll(`recordRemoteControlSkillCommand: ignore id=${messageId} name=${props.name} (awaitingRemoteReply)`);
        return;
    }
    const ids = new Set(existing.nonMirrorMessageIds ?? []);
    if (ids.has(messageId))
        return;
    ids.add(messageId);
    patchState({
        nonMirrorMessageIds: Array.from(ids).slice(-50),
    });
    logPoll(`recordRemoteControlSkillCommand: skip-mirror id=${messageId} name=${props.name}`);
}
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
export async function ensureConnection(directory, opencodeSessionId) {
    const auth = resolveDevspecAuth(directory);
    if (!auth.ok || !auth.token || !auth.mcp_url) {
        return { auth, state: null, error: auth.error };
    }
    if (!opencodeSessionId) {
        return { auth, state: null, error: 'ensureConnection requires the OpenCode session id' };
    }
    return runWithBondAsync(opencodeSessionId, async () => {
        const existing = readState();
        if (existing)
            return { auth, state: existing };
        const result = await mcpToolsCall({
            mcpUrl: auth.mcp_url,
            token: auth.token,
            name: 'register_connection',
            arguments: {
                local_id: bondLocalId(opencodeSessionId),
                agent_name: AGENT_NAME,
                cwd: directory,
            },
            timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
        });
        const state = {
            connectionId: result.connection_id,
            sessionId: null,
            codename: result.codename ?? null,
        };
        writeState(state);
        rememberOpenCodeBond(opencodeSessionId, null);
        return { auth, state };
    });
}
/** Attach this session's connection to a DevSpec session — `/devspec.remote --session <id>`. */
export async function attachSession(directory, opencodeSessionId, sessionId) {
    const { auth, state } = await ensureConnection(directory, opencodeSessionId);
    if (!auth.ok || !auth.token || !auth.mcp_url || !state)
        throw new Error(auth.error || 'DevSpec not configured');
    const result = await mcpToolsCall({
        mcpUrl: auth.mcp_url,
        token: auth.token,
        name: 'attach_connection',
        arguments: { connection_id: state.connectionId, session_id: sessionId },
        timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
    });
    const canonicalSessionId = typeof result?.session_id === 'string' ? result.session_id : sessionId;
    // No key flip, so no migration: the same file gains a room.
    runWithBond(opencodeSessionId, () => {
        patchState({ sessionId: canonicalSessionId, connectMirrorSuppressed: true });
    });
    rememberOpenCodeBond(opencodeSessionId, canonicalSessionId);
}
/** Detach + mark the connection offline — `/devspec.remote-stop`. */
export async function stopConnection(directory, opencodeSessionId) {
    const auth = resolveDevspecAuth(directory);
    const state = runWithBond(opencodeSessionId, () => readState());
    if (!auth.ok || !auth.token || !auth.mcp_url || !state) {
        runWithBond(opencodeSessionId, () => clearState());
        forgetOpenCodeBond(opencodeSessionId);
        return;
    }
    try {
        await mcpToolsCall({
            mcpUrl: auth.mcp_url,
            token: auth.token,
            name: 'detach_connection',
            arguments: { connection_id: state.connectionId },
            timeoutMs: MCP_HEARTBEAT_TIMEOUT_MS,
        });
    }
    finally {
        runWithBond(opencodeSessionId, () => clearState());
        forgetOpenCodeBond(opencodeSessionId);
    }
}
// Dedup key for reportPollError, keyed by directory — avoids spamming DevSpec
// with the same warning every 8s from the interval backstop. Module-level and
// in-memory only (resets on server restart); that's fine, a repeat failure
// re-posting once per minute is still far better than the total silence this
// replaces.
const lastPollErrorReports = new Map();
const POLL_ERROR_REPORT_COOLDOWN_MS = 60_000;
/**
 * How many consecutive poll failures before a recoverable gateway blip is posted
 * into the room. A single MCP HTTP 502 during a Coolify swap is normal and the
 * pump already retries — posting on attempt 1 made owners think the bond died
 * (session b088b9a6 / Brave Osprey, 2026-08-08). Auth and other hard failures
 * still report on the first hit.
 */
export const POLL_ERROR_REPORT_AFTER_TRANSIENT = 3;
/** True for gateway / redeploy-shaped MCP transport errors the pump already retries. */
export function isTransientMcpGatewayError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return /MCP HTTP 50[234]\b/i.test(message) || /\bBad Gateway\b/i.test(message);
}
/**
 * Whether a poll failure should be mirrored into the DevSpec room.
 * Transient 5xx waits until `POLL_ERROR_REPORT_AFTER_TRANSIENT` consecutive
 * failures; everything else reports immediately (still cooldown-deduped).
 */
export function shouldReportPollErrorToRoom(consecutiveErrors, err) {
    if (consecutiveErrors < 1)
        return false;
    if (isTransientMcpGatewayError(err)) {
        return consecutiveErrors >= POLL_ERROR_REPORT_AFTER_TRANSIENT;
    }
    return true;
}
/** Room-facing copy for a poll failure (softer for recoverable gateway blips). */
export function formatPollErrorRoomMessage(stage, err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isTransientMcpGatewayError(err)) {
        return (`DevSpec briefly unreachable at \`${stage}\` (${message}). ` +
            `Usually a redeploy — the bond is still retrying, not ended.`);
    }
    return `⚠️ Remote-control poll failed at \`${stage}\`: ${message}`;
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
async function reportPollError(auth, directory, state, stage, err, consecutiveErrors) {
    if (!auth.ok || !auth.token || !auth.mcp_url || !state?.sessionId)
        return;
    if (!shouldReportPollErrorToRoom(consecutiveErrors, err))
        return;
    const message = err instanceof Error ? err.message : String(err);
    const key = `${directory}:${stage}`;
    const prior = lastPollErrorReports.get(key);
    if (prior && prior.message === message && Date.now() - prior.at < POLL_ERROR_REPORT_COOLDOWN_MS)
        return;
    lastPollErrorReports.set(key, { message, at: Date.now() });
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
    });
}
const pumpStates = new Map();
function clearPromptTransactions(connectionId) {
    pumpStates.get(connectionId)?.promptTransactions.clear();
}
/** Epoch ms of last successful `poll_connection` per connection (presence breadcrumb). */
const lastSuccessfulPollAt = new Map();
/** Cooldown so presence_gap stories do not spam every tick. */
const lastPresenceGapWarnedAt = new Map();
function pumpStateFor(connectionId, persisted) {
    let s = pumpStates.get(connectionId);
    if (!s) {
        s = {
            cursorV2: persisted.cursorV2,
            catchUpCursor: persisted.catchUpCursor,
            dispatchCursor: persisted.dispatchCursor,
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
            acceptingTurn: null,
            acceptingPlaybook: null,
            promptTransactions: new Map(),
        };
        pumpStates.set(connectionId, s);
    }
    return s;
}
/** Drop pump state for a connection (teardown / stop). */
export function forgetPumpState(connectionId) {
    pumpStates.delete(connectionId);
    lastSuccessfulPollAt.delete(connectionId);
    lastPresenceGapWarnedAt.delete(connectionId);
}
/** Test/helpers: last successful poll timestamp for a connection, or null. */
export function getLastSuccessfulPollAt(connectionId) {
    return lastSuccessfulPollAt.get(connectionId) ?? null;
}
export function recordSuccessfulPoll(connectionId, at = Date.now()) {
    lastSuccessfulPollAt.set(connectionId, at);
}
/**
 * Emit a presence_gap story when the pump has gone too long without a successful
 * poll while the bond should still look live. Returns true if a warning was logged.
 */
export function maybeWarnPresenceGap(input) {
    const now = input.now ?? Date.now();
    const last = lastSuccessfulPollAt.get(input.connectionId);
    if (last == null)
        return false;
    const age = now - last;
    const gapMs = input.gapWarnMs ?? PRESENCE_GAP_WARN_MS;
    if (age < gapMs)
        return false;
    const prevWarn = lastPresenceGapWarnedAt.get(input.connectionId) ?? 0;
    if (now - prevWarn < PRESENCE_GAP_WARN_COOLDOWN_MS)
        return false;
    lastPresenceGapWarnedAt.set(input.connectionId, now);
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
    });
    return true;
}
export function logConnectionEndedStory(input) {
    const now = input.now ?? Date.now();
    const last = lastSuccessfulPollAt.get(input.connectionId);
    const lastPollAgeMs = last != null ? now - last : null;
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
    });
}
/**
 * Wake text for a playbook_run dispatch. Must NOT send the agent down the
 * assignment protocol — wrong tools, and a look-only playbook would lose its
 * permission line. Keep in step with Cursor's playbookRunCommandText.
 *
 * Always pass provider on claim (hard match against preferred_provider). Omitting
 * it fails even when this agent is the named one — same habit as claim_work_item.
 */
function playbookRunCommandText(d) {
    const permission = d.permission === 'can_push'
        ? 'You MAY edit, commit and push.'
        : d.permission === 'can_commit'
            ? 'You MAY edit and commit locally, but MUST NOT push.'
            : 'This playbook is LOOK ONLY — investigate and report, do not edit, commit or push anything.';
    const runId = typeof d.run_id === 'string' ? d.run_id : String(d.id ?? '');
    const name = typeof d.playbook_name === 'string' ? d.playbook_name : 'playbook';
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
    ].join('\n');
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
let authFailureLogged = false;
export async function pollAndDeliver(client, directory, sessionId, opts = {}) {
    const auth = resolveDevspecAuth(directory);
    // `state` is intentionally `let`: every writeState below also updates this binding so
    // later writes in the same call compose on top of earlier ones instead of reverting
    // them. A single snapshot spread into several writes is a real bug this file has had
    // twice (delivery bookkeeping erased mid-cycle, causing re-delivery).
    let state = readState();
    if (!auth.ok || !auth.token || !auth.mcp_url || !state) {
        // Not connected yet (no `/devspec.remote` run). Idle cheaply — and note this costs
        // NO network calls, unlike the interval it replaces.
        if (state && (!auth.ok || !auth.token || !auth.mcp_url)) {
            if (!authFailureLogged) {
                authFailureLogged = true;
                logPoll(`poll idle: connection state exists (${state.codename ?? state.connectionId ?? 'unknown'}) ` +
                    `but DevSpec auth is unresolvable — no polls until fixed: ${auth.error ?? 'incomplete config'}`);
            }
        }
        else {
            authFailureLogged = false;
        }
        return { delayMs: 5_000, stop: false };
    }
    authFailureLogged = false;
    const pump = pumpStateFor(state.connectionId, {
        cursorV2: state.remoteIngressCursorV2 ?? null,
        catchUpCursor: state.remoteIngressCatchUpCursor ?? null,
        dispatchCursor: state.remoteDispatchCursor ?? null,
        dispatchIds: state.deliveredAssignmentIds ?? [],
    });
    const turnActive = state.busy === true;
    const hold = holdFor({ attached: !!state.sessionId, turnActive });
    // While a turn genuinely runs, keep the activity lease alive. Stall detection
    // must NOT sit on the critical path ahead of poll_connection — a hung
    // session.messages call there freezes last_seen until idle_timeout (875d75b5).
    if (turnActive) {
        await reportActivity(directory, 'keepalive');
        void checkBusyStall(client, directory, sessionId).catch((err) => {
            logPoll(`checkBusyStall (async) failed: ${err}`);
        });
        maybeWarnPresenceGap({
            connectionId: state.connectionId,
            sessionId: state.sessionId,
            codename: state.codename,
            busy: true,
        });
        state = readState() ?? state;
    }
    else if (state.sessionId) {
        maybeWarnPresenceGap({
            connectionId: state.connectionId,
            sessionId: state.sessionId,
            codename: state.codename,
            busy: false,
        });
    }
    let res;
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
                ...(pump.cursorV2 ? { cursor_v2: pump.cursorV2 } : {}),
                ...(pump.needsSeed ? { catch_up: true } : {}),
                ...(pump.catchUpCursor ? { catch_up_cursor: pump.catchUpCursor } : {}),
                ...(pump.dispatchCursor ? { dispatch_cursor: pump.dispatchCursor } : {}),
                ingress_version: REMOTE_INGRESS_VERSION,
            },
            timeoutMs: hold.waitMs + HOLD_HTTP_GRACE_MS,
            signal: opts.signal,
        });
        pump.consecutiveErrors = 0;
        recordSuccessfulPoll(state.connectionId);
    }
    catch (err) {
        if (err instanceof McpTimeoutError) {
            // The hold outlived its client ceiling. That is not an error — it means nothing
            // arrived — so go straight back in rather than backing off.
            logPoll(`poll_connection hit the client ceiling (${err.timeoutMs}ms) — re-issuing`);
            return { delayMs: 0, stop: false };
        }
        if (opts.signal?.aborted)
            return { delayMs: 0, stop: true, reason: 'host_shutdown' };
        pump.consecutiveErrors++;
        const rateLimited = /rate limit/i.test(err instanceof Error ? err.message : String(err));
        const backoff = errorBackoffMs(pump.consecutiveErrors, { rateLimited });
        // Surface it into the room too: a persistently failing poll means nothing below this
        // line ever runs, which from the owner's side is indistinguishable from "delivered,
        // just slow".
        await reportPollError(auth, directory, state, 'poll_connection', err, pump.consecutiveErrors);
        logPoll(`poll_connection failed (${pump.consecutiveErrors}) — retrying in ${backoff}ms: ${err}`);
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
        });
        return { delayMs: backoff, stop: false };
    }
    // Out-of-band context wipe (archive/delete / attach-nonempty — items 37a7487b /
    // 8a55a89b). Run BEFORE adopt/inject so the SDK scratchpad is blank before the
    // next owner message, and ack immediately so the server waiter unblocks.
    if (res?.pending_context_wipe === true) {
        const reason = typeof res.pending_context_wipe_reason === 'string'
            ? res.pending_context_wipe_reason
            : 'unspecified';
        logPoll(`pending_context_wipe (${reason}) — wiping OpenCode context in place`);
        try {
            await wipeOpenCodeContextInPlace({
                client,
                directory,
                opencodeSessionId: sessionId,
            });
        }
        catch (err) {
            logPoll(`pending_context_wipe failed: ${err}`);
        }
        try {
            await mcpToolsCall({
                mcpUrl: auth.mcp_url,
                token: auth.token,
                name: 'poll_connection',
                arguments: {
                    connection_id: state.connectionId,
                    agent_name: AGENT_NAME,
                    wait_ms: 0,
                    context_wipe_ack: true,
                    busy: false,
                },
                timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
            });
            logPoll('pending_context_wipe acked');
        }
        catch (err) {
            logPoll(`pending_context_wipe ack failed: ${err}`);
        }
        // Bond may have rebound to a new OpenCode session id — stop this pump
        // iteration; the multi-bond loop will pick up the new id next tick.
        return { delayMs: 0, stop: false };
    }
    // Teardown (UI End, /devspec.remote-stop elsewhere, already-ended row). One check now
    // covers what the separate heartbeat used to: the poll IS the heartbeat.
    const terminal = pollTerminalReason(res);
    if (terminal?.recoverable) {
        // The server says gone, but will not attribute it to a person — so we do not
        // treat it as one. This is the redeploy case: during a container swap
        // poll_connection briefly cannot see a row that is perfectly alive, and the old
        // code stopped the pump permanently on the strength of it (brief e691c68a).
        pump.consecutiveRecoverableEnds++;
        const label = terminal.reason ?? 'no reason given';
        if (pump.consecutiveRecoverableEnds < RECOVERABLE_TERMINAL_MAX) {
            const backoff = errorBackoffMs(pump.consecutiveRecoverableEnds);
            logPoll(`${terminal.status} (${label}) — recoverable, not a UI end; retrying in ${backoff}ms ` +
                `(${pump.consecutiveRecoverableEnds}/${RECOVERABLE_TERMINAL_MAX})`);
            return { delayMs: backoff, stop: false };
        }
        // Out of patience. Stand down, but say plainly that this was NOT a UI end, so
        // whoever reads the log knows the bond may simply be re-registered.
        logPoll(`${terminal.status} (${label}) — still gone after ${RECOVERABLE_TERMINAL_MAX} tries; ` +
            `stopping the pump. This was NOT a UI end — re-register the same bond to resume.`);
        logConnectionEndedStory({
            connectionId: state.connectionId,
            sessionId: state.sessionId,
            codename: state.codename,
            endReason: label,
            via: 'recoverable_exhausted',
            busy: state.busy === true,
        });
        await setBusy(directory, false).catch(() => { });
        forgetPumpState(state.connectionId);
        forgetOpenCodeBond(sessionId);
        return { delayMs: 0, stop: true, reason: terminal.reason ?? 'server_ended' };
    }
    if (terminal) {
        // A deliberate human end ('ui' / 'local_stop'). This one must stick.
        const reason = terminal.reason ?? 'ended_from_ui';
        logPoll(`connection ended (${reason}) — dropping this bond; other bonds keep polling`);
        logConnectionEndedStory({
            connectionId: state.connectionId,
            sessionId: state.sessionId,
            codename: state.codename,
            endReason: reason,
            via: 'deliberate_end',
            busy: state.busy === true,
        });
        await setBusy(directory, false).catch(() => { });
        forgetPumpState(state.connectionId);
        forgetOpenCodeBond(sessionId);
        return { delayMs: 0, stop: true, reason };
    }
    // A clean poll clears the recoverable streak — a blip that resolves is over.
    pump.consecutiveRecoverableEnds = 0;
    // Server-authoritative attachment: an attach/detach/redirect from the phone or web
    // changes the room WITHOUT touching this machine's state file, so the response — never
    // local state — decides which room we are in.
    const adopt = resolveServerAttachment(state.sessionId, res);
    if (adopt.changed) {
        logPoll(`server attachment ${state.sessionId ?? '(none)'} → ${adopt.sessionId ?? '(none)'}`);
        // patchState — never writeState a stale full snapshot (mirror claims race).
        state =
            patchState({
                sessionId: adopt.sessionId,
                lastDeliveredMessageId: null,
                remoteIngressCursorV2: null,
                remoteIngressCatchUpCursor: null,
                remoteDispatchCursor: null,
            }) ?? {
                ...state,
                sessionId: adopt.sessionId,
                lastDeliveredMessageId: null,
                remoteIngressCursorV2: null,
                remoteIngressCatchUpCursor: null,
                remoteDispatchCursor: null,
            };
        // Fresh room: drop the cursor and any carried context from the old one, and treat
        // the NEXT poll (cursor:null + catch_up) as the seed. Never consume this hold's
        // package as a completed seed — it was opened under the previous room's cursor,
        // so packaging is a delta against the wrong clock. Fall-through + advisory-only
        // advance locked lastDelivered past a cold-launch dispatch that landed moments
        // later with a backdated paint timestamp (session 23da0643 / item 2411dd5a).
        // Session 1383cbb8 needed the pending command delivered; a null-cursor re-poll
        // gets the catch-up window and does that correctly without the race.
        pump.cursorV2 = null;
        pump.catchUpCursor = null;
        pump.dispatchCursor = null;
        pump.carry.reset();
        pump.needsSeed = true;
        if (adoptRequiresNullCursorRepoll()) {
            logPoll(`adopt → re-poll with cursor:null + catch_up (discarding pre-adopt package; ` +
                `changed=${res?.changed === true})`);
            return { delayMs: 0, stop: false };
        }
    }
    else if (res?.changed !== true) {
        // Idle responses echo all independent cursors. They contain no turn to accept,
        // so applying them cannot skip work.
        if (typeof res?.cursor_v2 === 'string' && res.cursor_v2)
            pump.cursorV2 = res.cursor_v2;
        if (typeof res?.dispatch_cursor === 'string' && res.dispatch_cursor)
            pump.dispatchCursor = res.dispatch_cursor;
        pump.catchUpCursor = null;
        pump.needsSeed = false;
        patchState({
            remoteIngressCursorV2: pump.cursorV2,
            remoteIngressCatchUpCursor: null,
            remoteDispatchCursor: pump.dispatchCursor,
        });
        pump.consecutiveEmpty = 0;
        return { delayMs: 0, stop: false };
    }
    // Explicit playbook dispatch is a separate top-level workflow. Extract and
    // schedule it before canonical parsing so an unsupported conversation envelope
    // cannot block a valid playbook, and never admit action-item assignments.
    const offeredDispatches = Array.isArray(res?.dispatches) ? res.dispatches : [];
    const freshDispatches = offeredDispatches.filter((dispatch) => dispatch && dispatch.kind === 'playbook_run' && typeof dispatch.id === 'string' &&
        !pump.deliveredDispatchIds.has(dispatch.id) &&
        !['completed', 'released'].includes(String(dispatch.state ?? dispatch.status ?? 'pending')));
    const playbookDispatchCursor = typeof res?.dispatch_cursor === 'string' && res.dispatch_cursor
        ? res.dispatch_cursor
        : null;
    const commitPlaybookCursor = () => {
        if (playbookDispatchCursor)
            pump.dispatchCursor = playbookDispatchCursor;
        patchState({ remoteDispatchCursor: pump.dispatchCursor });
    };
    if (freshDispatches.length === 0) {
        commitPlaybookCursor();
    }
    else {
        const dispatchIds = freshDispatches.map((dispatch) => dispatch.id);
        const playbookKey = `playbook:${dispatchIds.join(',')}`;
        if (!pump.acceptingPlaybook) {
            pump.acceptingPlaybook = { key: playbookKey, dispatchIds };
            pump.promptTransactions.set(playbookKey, 'pending');
            const playbookCommands = freshDispatches.map((dispatch) => ({
                id: `dispatch:${dispatch.id}`,
                created_at: typeof dispatch.created_at === 'string' ? dispatch.created_at : new Date().toISOString(),
                addressed_to: res.addressed_to,
                authority: { kind: 'owner', capabilities: ['full'] },
                content: playbookRunCommandText(dispatch),
                dispatch_model: dispatch.dispatch_model,
            }));
            const text = renderInjectedTurn({ commands: playbookCommands, context: null });
            const modelExtract = extractOpenCodeReplyModel(freshDispatches.find((dispatch) => dispatch.dispatch_model)?.dispatch_model);
            const model = modelExtract.model ?? state.remoteControlModel ?? undefined;
            await setBusy(directory, true);
            const injectStateKey = sessionId;
            void runWithBondAsync(injectStateKey, () => deliverInjectedTurn({
                client,
                directory,
                sessionId,
                auth,
                text,
                fileParts: [],
                model,
                thinking: state.remoteControlThinking ?? undefined,
                onAccepted: () => {
                    for (const id of dispatchIds)
                        pump.deliveredDispatchIds.add(id);
                    patchState({ deliveredAssignmentIds: [...pump.deliveredDispatchIds].slice(-50) });
                    commitPlaybookCursor();
                    pump.promptTransactions.set(playbookKey, 'accepted');
                    if (pump.acceptingPlaybook?.key === playbookKey)
                        pump.acceptingPlaybook = null;
                },
                onRejected: () => {
                    pump.promptTransactions.delete(playbookKey);
                    if (pump.acceptingPlaybook?.key === playbookKey)
                        pump.acceptingPlaybook = null;
                },
                shouldCleanupRejectedTurn: () => pump.promptTransactions.size === 0,
            })).catch((err) => logPoll(`playbook prompt delivery failed: ${err}`));
        }
    }
    // ---- Something landed: consume ONLY negotiated canonical ingress -----------------
    // Once v1 is requested, legacy commands/context/dispatch arrays are additive data for
    // unmigrated clients and are never a fallback. Missing, malformed, or unknown ingress
    // therefore fails closed and cannot wake OpenCode.
    const parsedIngress = parseCanonicalIngress(res?.ingress, state.connectionId);
    if (!parsedIngress.ok) {
        pump.consecutiveEmpty++;
        const delayMs = emptyTurnBackoffMs(pump.consecutiveEmpty, hold.waitMs);
        logPoll(`REJECTED canonical ingress: ${parsedIngress.error}; no model wake`);
        return { delayMs, stop: false };
    }
    const ingress = freezeCanonicalTurn(structuredClone(parsedIngress.ingress));
    const contextRows = [];
    for (const [bucket, rows] of Object.entries(ingress.context)) {
        for (const row of rows) {
            contextRows.push({
                id: row.message_id,
                content: row.content,
                created_at: row.order.created_at,
                message_type: row.source_type,
                context_bucket: bucket,
                actor_model: row.actor.model,
                actor_agent_tool: row.actor.agent_tool,
                ingress_sequence: row.order.sequence,
                author: {
                    kind: row.actor.kind,
                    name: row.actor.display_name,
                    ...(row.actor.user_id ? { user_id: row.actor.user_id } : {}),
                    ...(row.actor.agent_tool ? { agent_tool: row.actor.agent_tool } : {}),
                },
            });
        }
    }
    const ownerAmbient = [];
    const roomContext = contextRows.sort((a, b) => (a.ingress_sequence ?? 0) - (b.ingress_sequence ?? 0));
    if (roomContext.length > 0) {
        pump.carry.add(ownerAmbient, roomContext, ingress.window);
        logPoll(`carried canonical advisory: +${roomContext.length} typed actor context (buffer ${pump.carry.size})`);
    }
    const deliveredIds = new Set(state.deliveredMessageIds ?? []);
    const canonicalSelection = selectCanonicalCommandsForPrompt({ ok: true, ingress, executable: parsedIngress.executable }, deliveredIds);
    const unavailable = canonicalSelection.rejectedUnavailable;
    if (unavailable.length > 0) {
        logPoll(`REJECTED canonical command turn: unavailable attachment; holding live cursor`);
    }
    const liveCursorCandidate = typeof res?.cursor_v2 === 'string' && res.cursor_v2 ? res.cursor_v2 : null;
    const catchUpCursorCandidate = ingress.window.has_more ? ingress.window.next_cursor : null;
    const commitConversationCursor = () => {
        if (liveCursorCandidate)
            pump.cursorV2 = liveCursorCandidate;
        pump.catchUpCursor = catchUpCursorCandidate;
        pump.needsSeed = Boolean(catchUpCursorCandidate);
        patchState({
            remoteIngressCursorV2: pump.cursorV2,
            remoteIngressCatchUpCursor: pump.catchUpCursor,
        });
    };
    // Canonical typed controls never come from slash-looking conversation text.
    // Execute once, persist the execution marker, then acknowledge the exact id.
    if (ingress.wake.kind === 'control' && ingress.control) {
        const controlKey = `control:${ingress.control.id}`;
        if (pump.acceptingTurn?.key !== controlKey) {
            if (pump.acceptingTurn)
                return { delayMs: 1000, stop: false };
            pump.acceptingTurn = { key: controlKey, commandIds: [], dispatchIds: [] };
            const injectStateKey = sessionId;
            void runWithBondAsync(injectStateKey, async () => {
                try {
                    const beforeControl = readState() ?? state;
                    const executed = new Set(beforeControl.executedControlIds ?? []);
                    let modelCatalog = beforeControl.pendingControlCatalog?.controlId === ingress.control.id
                        ? beforeControl.pendingControlCatalog.catalog
                        : undefined;
                    if (!executed.has(ingress.control.id)) {
                        modelCatalog = await executeCanonicalControl({
                            client,
                            directory,
                            sessionId,
                            control: ingress.control,
                        });
                        patchState({
                            executedControlIds: [...executed, ingress.control.id].slice(-50),
                            ...(modelCatalog ? { pendingControlCatalog: { controlId: ingress.control.id, catalog: modelCatalog } } : {}),
                        });
                    }
                    await acknowledgeCanonicalControl({ auth, state: readState() ?? state, controlId: ingress.control.id, modelCatalog });
                    patchState({ pendingControlCatalog: null });
                    commitConversationCursor();
                }
                catch (err) {
                    logPoll(`canonical control ${ingress.control.verb} failed; not acknowledged: ${err}`);
                }
                finally {
                    if (pump.acceptingTurn?.key === controlKey)
                        pump.acceptingTurn = null;
                }
            });
            return { delayMs: 0, stop: false };
        }
        return { delayMs: 1000, stop: false };
    }
    // A partial legacy dedupe marker means the immutable envelope was previously
    // accepted as a whole. Normalize all ids and continue; never replay a suffix.
    if (canonicalSelection.alreadyDelivered) {
        for (const command of ingress.commands)
            deliveredIds.add(command.message_id);
        patchState({ deliveredMessageIds: [...deliveredIds].slice(-50) });
        commitConversationCursor();
    }
    const roomCommands = canonicalSelection.commands;
    const pendingCommands = [...roomCommands];
    const deferInject = shouldDeferInjectDuringConnect({
        connectMirrorSuppressed: state.connectMirrorSuppressed,
        awaitingRemoteReply: state.awaitingRemoteReply,
    });
    if ((deferInject || pump.acceptingTurn) && pendingCommands.length > 0) {
        logPoll(`deferring immutable turn until prior host acceptance settles`);
        return { delayMs: 1000, stop: false };
    }
    const commands = pendingCommands;
    // Non-command canonical context/history commits independently.
    if (roomCommands.length === 0 && unavailable.length === 0 && !parsedIngress.executable) {
        commitConversationCursor();
    }
    if (commands.length === 0) {
        pump.consecutiveEmpty = 0;
        if (roomContext.length > 0 || !parsedIngress.executable || unavailable.length > 0 || canonicalSelection.alreadyDelivered) {
            await mirrorNow(client, directory, sessionId);
            return { delayMs: 0, stop: false };
        }
        const floor = emptyTurnBackoffMs(++pump.consecutiveEmpty, hold.waitMs);
        return { delayMs: floor, stop: false };
    }
    pump.consecutiveEmpty = 0;
    const commandIds = roomCommands.map((command) => command.message_id);
    const canonicalTurnId = roomCommands[0].delivery.turn_id;
    const acceptanceKey = `canonical:${canonicalTurnId}`;
    pump.acceptingTurn = { key: acceptanceKey, commandIds, dispatchIds: [] };
    pump.promptTransactions.set(acceptanceKey, 'pending');
    // Needs-your-input round-trip (item 7b4090e4): when OpenCode is blocked on a
    // question, the next owner command answers THAT question — it must not start
    // a fresh promptAsync turn. Advisory chatter never reaches this branch
    // (commands are local_agent_dispatch only).
    if (state.pendingQuestion?.requestId && roomCommands.length > 0) {
        const pendingRequestId = state.pendingQuestion.requestId;
        const answerText = roomCommands
            .map((c) => typeof c?.content === 'string'
            ? c.content
            : typeof c?.content?.body === 'string'
                ? c.content.body
                : typeof c?.text === 'string'
                    ? c.text
                    : '')
            .filter((t) => t.trim())
            .join('\n\n');
        const replied = await replyPendingQuestion({ client, directory, answerText });
        if (replied) {
            for (const id of commandIds)
                deliveredIds.add(id);
            patchState({
                deliveredMessageIds: [...deliveredIds].slice(-50),
                currentTurnMessageIds: Array.from(new Set([...(state.currentTurnMessageIds ?? []), ...commandIds])).slice(-50),
            });
            commitConversationCursor();
            pump.carry.take();
            pump.promptTransactions.set(acceptanceKey, 'accepted');
            pump.acceptingTurn = null;
            logPoll(`needs_input: delivered owner reply to question ${pendingRequestId}`);
            return { delayMs: 0, stop: false };
        }
        pump.promptTransactions.delete(acceptanceKey);
        pump.acceptingTurn = null;
        logPoll('needs_input: question.reply failed — immutable command turn remains uncommitted');
        return { delayMs: 2000, stop: false };
    }
    // Slash-looking conversational bodies remain ordinary human commands. Only
    // ingress.control can enter the deterministic host-control path.
    // ONE prompt for the whole delivered turn: the room context (labelled inert) followed
    // by every command in the delta. Injecting per-command would queue separate OpenCode
    // turns, and only the first would carry the context they all share.
    const context = pump.carry.peek();
    // Attachments ride the same turn as real file parts (item 99165e12). Anything too
    // large to inline is named in the text rather than vanishing.
    const { parts: fileParts, declined: declinedAttachments, references: attachmentReferences, } = buildAttachmentParts(commands, {
        materializeLarge: materializeLargeAttachmentToDisk,
    });
    const text = renderInjectedTurn({
        commands: commands,
        context,
        window: ingress.window,
        deliveryContract: null,
        declinedAttachments,
        attachmentReferences,
    });
    logPoll(`injecting ${commands.length} command(s) with context: ` +
        `${context?.owner_ambient.length ?? 0} owner-ambient, ${context?.room_context.length ?? 0} room-context, ` +
        `${context?.dropped ?? 0} dropped`);
    // Per-message provider/model override — only meaningful for provider-agnostic hosts.
    const rawDispatchModel = commands.find((c) => c?.dispatch_model)?.dispatch_model;
    const dispatchModelExtract = extractOpenCodeReplyModel(rawDispatchModel);
    const model = dispatchModelExtract.model ?? state.remoteControlModel ?? undefined;
    const thinking = state.remoteControlThinking ?? undefined;
    if (rawDispatchModel != null && !dispatchModelExtract.model) {
        logPoll(`inject: dispatch_model shape rejected (${dispatchModelExtract.missingReason}): ` +
            `${dispatchModelExtract.rawSnippet ?? summarizeModelShapeSnippet(rawDispatchModel)}`);
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
        });
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
    });
    // Assert busy BEFORE returning to the pump so the next poll_connection re-asserts
    // busy:true. Inject (baseline + promptAsync + mirror) must NOT block presence —
    // awaiting session.messages / kickoff here was starving last_seen (875d75b5).
    await setBusy(directory, true);
    // Mark awaiting BEFORE fire-and-forget deliverInjectedTurn. Baseline capture
    // used to set this only after session.messages — during that window a late
    // command.executed / connect suppress could poison the answer id (b156e680).
    // Turn-scope the content-hash ring (item 4f9515a4): a prior turn's "7." must
    // not suppress this turn's identical short answer, or the live Working trail
    // stays streaming forever with empty content.
    patchState({
        awaitingRemoteReply: true,
        recentPostedContentHashes: [],
        manualAnswerPostedThisTurn: false,
    });
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
    });
    // Capture this bond's state key so fire-and-forget deliver keeps writing the
    // right file even if the pump moves on to another OpenCode session (7a9b7b0f).
    const injectStateKey = sessionId;
    void runWithBondAsync(injectStateKey, () => deliverInjectedTurn({
        client,
        directory,
        sessionId,
        auth,
        text,
        fileParts,
        model,
        thinking,
        onAccepted: () => {
            const acceptedState = readState() ?? state;
            const acceptedIds = new Set(acceptedState.deliveredMessageIds ?? []);
            for (const id of commandIds)
                acceptedIds.add(id);
            patchState({
                deliveredMessageIds: [...acceptedIds].slice(-50),
                currentTurnMessageIds: Array.from(new Set([...(acceptedState.currentTurnMessageIds ?? []), ...commandIds])).slice(-50),
            });
            commitConversationCursor();
            pump.carry.take();
            pump.promptTransactions.set(acceptanceKey, 'accepted');
            if (pump.acceptingTurn?.key === acceptanceKey)
                pump.acceptingTurn = null;
        },
        onRejected: () => {
            pump.promptTransactions.delete(acceptanceKey);
            if (pump.acceptingTurn?.key === acceptanceKey)
                pump.acceptingTurn = null;
        },
        shouldCleanupRejectedTurn: () => pump.promptTransactions.size === 0,
    })).catch((err) => {
        logPoll(`deliverInjectedTurn failed: ${err}`);
    });
    return { delayMs: 0, stop: false };
}
async function listSessionMessages(client, sessionId) {
    const snap = await withTimeout(client.session.messages({ path: { id: sessionId } }), OPENCODE_SESSION_API_TIMEOUT_MS, 'session.messages(control-slash)');
    const data = unwrapSdkData(snap);
    return Array.isArray(data) ? data : [];
}
async function resolveControlSlashModel(client, sessionId, preferred) {
    if (preferred?.providerID && preferred?.modelID)
        return preferred;
    try {
        const msgs = await listSessionMessages(client, sessionId);
        for (let i = msgs.length - 1; i >= 0; i--) {
            const row = msgs[i];
            if (row?.info?.role !== 'assistant')
                continue;
            const extracted = resolveOpenCodeAssistantModel(row);
            if (extracted.model)
                return extracted.model;
        }
    }
    catch (err) {
        logPoll(`resolveControlSlashModel: messages failed: ${err}`);
    }
    return null;
}
async function postControlSlashAnswer(auth, message) {
    const state = readState();
    if (!state || !auth.ok || !auth.token || !auth.mcp_url)
        return;
    if (!state.sessionId && !state.connectionId)
        return;
    try {
        await mcpToolsCall({
            mcpUrl: auth.mcp_url,
            token: auth.token,
            name: 'post_session_message',
            arguments: postMessageArgs(state, message, {
                turn_kind: 'agent',
                phase: 'answer',
                complete_turn: true,
            }),
            timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
        });
    }
    catch (err) {
        logPoll(`postControlSlashAnswer failed: ${err}`);
    }
}
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
export async function wipeOpenCodeContextInPlace(input) {
    const { client, directory, opencodeSessionId } = input;
    // Read the bond being transferred explicitly rather than relying on the
    // caller's ambient scope: this function is handed the session id, so it does
    // not need to be told twice, and a transfer that read the wrong bond would be
    // the exact class of bug this rewrite removes.
    const before = runWithBond(opencodeSessionId, () => readState());
    const preservedDevspecSessionId = before?.sessionId ?? null;
    const created = await withTimeout(client.session.create({
        body: { title: 'DevSpec remote' },
    }), OPENCODE_SESSION_API_TIMEOUT_MS, 'session.create');
    const session = unwrapSdkData(created);
    const newId = typeof session?.id === 'string' ? session.id : null;
    if (!newId)
        throw new Error('session.create returned no id');
    // The bond MOVES to the fresh OpenCode session, and because the state file
    // is keyed on that id, moving it is a real file transfer. This is the one
    // place a transfer legitimately happens — a deliberate, explicit hand-off of
    // one bond from one conversation to its replacement — as opposed to the
    // ambient donor-scavenging that used to run on every attach and could pick
    // up a stranger's file.
    //
    // The DevSpec room is preserved: the same connection, the same session, now
    // driven from the blank chat.
    const carried = before;
    runWithBond(opencodeSessionId, () => clearState());
    forgetOpenCodeBond(opencodeSessionId);
    rememberOpenCodeBond(newId, preservedDevspecSessionId);
    runWithBond(newId, () => {
        if (carried) {
            writeState({
                ...carried,
                sessionId: preservedDevspecSessionId ?? carried.sessionId ?? null,
                // Clear OpenCode-message-scoped cursors only. Keep DevSpec delivery
                // cursors (`lastDeliveredMessageId`, `deliveredMessageIds`) so the room
                // transcript is not re-injected into the blank chat.
                lastMirroredMessageId: null,
                replyAfterOpenCodeMessageId: null,
                replyBaselineCaptured: undefined,
                awaitingRemoteReply: false,
                pendingQuestion: null,
            });
        }
    });
    logPoll(`wipeOpenCodeContextInPlace: ${opencodeSessionId} → ${newId} ` +
        `(devspecSession=${preservedDevspecSessionId ?? '(none)'}, state moved to the new session's key)`);
    return { newOpenCodeSessionId: newId, preservedDevspecSessionId };
}
export async function executeCanonicalControl(input) {
    const { client, directory, sessionId, control } = input;
    switch (control.verb) {
        case 'abort': {
            const result = await withTimeout(client.session.abort({ path: { id: sessionId } }), OPENCODE_SESSION_API_TIMEOUT_MS, 'canonical-control.abort');
            assertSdkAccepted(result, 'canonical-control.abort');
            await setBusy(directory, false);
            clearInjectTurnState();
            return undefined;
        }
        case 'compact': {
            const preferred = readState()?.remoteControlModel ?? undefined;
            const model = await resolveControlSlashModel(client, sessionId, preferred);
            if (!model)
                throw new Error('No provider/model available to compact this session');
            const result = await withTimeout(client.session.summarize({ path: { id: sessionId }, body: model }), OPENCODE_CONTROL_COMPACT_TIMEOUT_MS, 'canonical-control.compact');
            assertSdkAccepted(result, 'canonical-control.compact');
            return undefined;
        }
        case 'set_model': {
            const parsed = extractOpenCodeReplyModel(control.args?.model);
            if (!parsed.model)
                throw new Error(`Invalid OpenCode model: ${control.args?.model ?? '(missing)'}`);
            patchState({ remoteControlModel: parsed.model });
            return undefined;
        }
        case 'set_thinking':
            patchState({ remoteControlThinking: control.args?.thinking ?? null });
            return undefined;
        case 'reload': {
            // OpenCode's documented instance disposal is its deterministic reload
            // boundary: the next request recreates the project instance and plugins.
            const result = await withTimeout(client.instance.dispose(), OPENCODE_SESSION_API_TIMEOUT_MS, 'canonical-control.reload');
            assertSdkAccepted(result, 'canonical-control.reload');
            return undefined;
        }
        case 'list_models': {
            const raw = await withTimeout(client.config.providers({ query: { directory } }), OPENCODE_SESSION_API_TIMEOUT_MS, 'canonical-control.list_models');
            const data = unwrapSdkData(raw) ?? {};
            const providers = Array.isArray(data.providers) ? data.providers : [];
            const models = providers.flatMap((provider) => Object.entries(provider?.models ?? {}).map(([id, model]) => ({
                provider: String(provider.id),
                id,
                ...(typeof model?.name === 'string' && model.name ? { name: model.name } : {}),
            }))).slice(0, 400);
            const current = readState()?.remoteControlModel;
            return {
                v: 1,
                current: current ? `${current.providerID}/${current.modelID}` : null,
                models,
                at: new Date().toISOString(),
                ...(models.length >= 400 ? { truncated: true } : {}),
            };
        }
    }
}
async function acknowledgeCanonicalControl(input) {
    if (!input.auth.ok || !input.auth.token || !input.auth.mcp_url)
        throw new Error('DevSpec auth unavailable for control acknowledgement');
    await mcpToolsCall({
        mcpUrl: input.auth.mcp_url,
        token: input.auth.token,
        name: 'poll_connection',
        arguments: {
            connection_id: input.state.connectionId,
            agent_name: AGENT_NAME,
            wait_ms: 0,
            busy: input.state.busy ?? false,
            ingress_version: REMOTE_INGRESS_VERSION,
            control_ack: input.controlId,
            ...(input.modelCatalog ? { model_catalog: input.modelCatalog } : {}),
        },
        timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
    });
}
/**
 * Run a native OpenCode control slash via SDK (item b315fe42).
 * Posts a short DevSpec answer for most commands; `/new` is silent (8718be5a).
 * Always clears busy so Working never hangs.
 */
export async function executeOwnerControlSlash(input) {
    const { client, directory, sessionId, auth, command, model } = input;
    const label = command.kind;
    /** `/new` must not append a chat row (acceptance: transcript unchanged). */
    const silentSuccess = command.kind === 'new';
    try {
        switch (command.kind) {
            case 'abort': {
                await withTimeout(client.session.abort({ path: { id: sessionId } }), OPENCODE_SESSION_API_TIMEOUT_MS, 'session.abort');
                break;
            }
            case 'compact': {
                const stamp = await resolveControlSlashModel(client, sessionId, model);
                if (!stamp) {
                    throw new Error('No provider/model available to compact this session');
                }
                await withTimeout(client.session.summarize({
                    path: { id: sessionId },
                    body: { providerID: stamp.providerID, modelID: stamp.modelID },
                }), OPENCODE_CONTROL_COMPACT_TIMEOUT_MS, 'session.summarize');
                break;
            }
            case 'new': {
                await wipeOpenCodeContextInPlace({
                    client,
                    directory,
                    opencodeSessionId: sessionId,
                });
                break;
            }
            case 'undo': {
                const msgs = await listSessionMessages(client, sessionId);
                let messageID = null;
                for (let i = msgs.length - 1; i >= 0; i--) {
                    const info = msgs[i]?.info;
                    if (info?.role === 'user' && typeof info.id === 'string' && info.id) {
                        messageID = info.id;
                        break;
                    }
                }
                if (!messageID)
                    throw new Error('Nothing to undo');
                await withTimeout(client.session.revert({
                    path: { id: sessionId },
                    body: { messageID },
                }), OPENCODE_SESSION_API_TIMEOUT_MS, 'session.revert');
                break;
            }
            case 'redo': {
                await withTimeout(client.session.unrevert({ path: { id: sessionId } }), OPENCODE_SESSION_API_TIMEOUT_MS, 'session.unrevert');
                break;
            }
        }
        if (!silentSuccess) {
            await postControlSlashAnswer(auth, controlSlashSuccessMessage(command));
        }
        logRemoteControlStory({
            phase: 'inject',
            outcome: 'kicked',
            connectionId: readState()?.connectionId ?? null,
            sessionId: readState()?.sessionId ?? null,
            agent: AGENT_NAME,
            codename: readState()?.codename ?? null,
            tool: 'session.control',
            reason: `/${label}`,
            data: { ok: true, silent: silentSuccess },
        });
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logPoll(`control slash /${label} failed: ${reason}`);
        // Failures still surface — silent only applies to a successful /new wipe.
        await postControlSlashAnswer(auth, `⚠️ \`/${label}\` failed: ${reason}`);
        logRemoteControlStory({
            phase: 'inject',
            outcome: 'failed',
            connectionId: readState()?.connectionId ?? null,
            sessionId: readState()?.sessionId ?? null,
            agent: AGENT_NAME,
            codename: readState()?.codename ?? null,
            tool: 'session.control',
            reason: `/${label}`,
            data: { error: reason },
        });
    }
    finally {
        // Abort (and any mid-busy control) must clear Working without waiting for
        // a model reply that will never arrive.
        await setBusy(directory, false);
        clearInjectTurnState();
    }
}
/**
 * Kick off an injected owner turn without blocking the presence pump.
 * Presence (`poll_connection`) must keep updating `last_seen` while this runs.
 */
export async function deliverInjectedTurn(input) {
    const { client, directory, sessionId, auth, text, fileParts, model, thinking, onAccepted, onRejected, shouldCleanupRejectedTurn, } = input;
    let state = readState();
    let promptAccepted = false;
    if (!state) {
        onRejected?.();
        return;
    }
    try {
        // Baseline: only mirror assistant messages that appear AFTER the last one present at
        // inject time. Capture success is tracked separately — a failed snapshot must fail
        // closed at mirror time, never fall back to "newest in history".
        let replyAfter = null;
        let baselineCaptured = false;
        try {
            const snap = await withTimeout(client.session.messages({ path: { id: sessionId } }), OPENCODE_SESSION_API_TIMEOUT_MS, 'session.messages(inject-baseline)');
            const msgs = Array.isArray(snap?.data) ? snap.data : Array.isArray(snap) ? snap : [];
            const assistants = msgs.filter((m) => m?.info?.role === 'assistant');
            replyAfter = assistants[assistants.length - 1]?.info?.id ?? null;
            baselineCaptured = true;
        }
        catch (err) {
            logPoll(`inject: baseline snapshot failed (will fail-closed on mirror): ${err}`);
            baselineCaptured = false;
        }
        // A new turn starts with no bubble of its own: dropping the previous turn's
        // trail pointer here is what stops the first chunk of THIS turn from being
        // appended to the last turn's already-answered row.
        const freshTurnTrail = {
            activeTrailMessageId: null,
            lastTrailHash: null,
            lastTrailPostedAt: null,
        };
        state =
            patchState({
                replyAfterOpenCodeMessageId: replyAfter,
                replyBaselineCaptured: baselineCaptured,
                awaitingRemoteReply: true,
                // Reaffirm turn-scoped hash ring (item 4f9515a4) — inject may have
                // already cleared it; baseline patch must not reintroduce prior hashes.
                recentPostedContentHashes: [],
                manualAnswerPostedThisTurn: false,
                ...freshTurnTrail,
            }) ?? {
                ...state,
                replyAfterOpenCodeMessageId: replyAfter,
                replyBaselineCaptured: baselineCaptured,
                awaitingRemoteReply: true,
                recentPostedContentHashes: [],
                manualAnswerPostedThisTurn: false,
                ...freshTurnTrail,
            };
        const promptResult = await client.session.promptAsync({
            path: { id: sessionId },
            body: {
                parts: [{ type: 'text', text }, ...fileParts],
                ...(model ? { model } : {}),
                ...(thinking ? { variant: thinking } : {}),
            },
        });
        assertSdkAccepted(promptResult, 'promptAsync');
        promptAccepted = true;
        try {
            onAccepted?.();
        }
        catch (err) {
            // OpenCode accepted the entire immutable turn. Never route a local
            // bookkeeping failure through rejection/retry and duplicate the prompt.
            logPoll(`inject acceptance bookkeeping failed after promptAsync accepted: ${err}`);
        }
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
        });
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
            await postWorkTrail(client, directory, sessionId, { force: true, seed: true });
        }
        catch (err) {
            logPoll(`deliverInjectedTurn: eager trail seed failed (non-fatal): ${err}`);
        }
    }
    catch (err) {
        if (!promptAccepted) {
            try {
                onRejected?.();
            }
            catch { /* best-effort local rollback */ }
        }
        const reason = err instanceof Error ? err.message : String(err);
        const freshForNotice = readState() ?? state;
        if (freshForNotice.sessionId && auth.ok && auth.token && auth.mcp_url) {
            await mcpToolsCall({
                mcpUrl: auth.mcp_url,
                token: auth.token,
                name: 'post_session_message',
                arguments: postMessageArgs(freshForNotice, model
                    ? `⚠️ Could not run this message on \`${model.providerID}/${model.modelID}\`: ${reason}`
                    : `⚠️ Could not deliver this message: ${reason}`, { turn_kind: 'agent' }),
                timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
            }).catch(() => { });
        }
        else {
            logPoll(`promptAsync failed (sessionless): ${reason}`);
        }
        // Clear global lifecycle only when no sibling prompt transaction still
        // owns it. A rejected simultaneous enqueue must not erase an accepted
        // sibling's busy state or reply baseline.
        if (shouldCleanupRejectedTurn?.() ?? true) {
            await setBusy(directory, false);
            clearInjectTurnState({ unclaim: true });
        }
        else {
            logPoll('promptAsync rejection preserved busy/reply correlation for a sibling transaction');
        }
        return;
    }
    // Prefer the guarded path — session.idle / message.updated own the real flush;
    // this is a best-effort nudge that must not race a bare concurrent mirror.
    await mirrorNow(client, directory, sessionId);
}
export function decideAwaitingBaseline(opts) {
    if (opts.baselineCaptured === false)
        return { action: 'fail_closed_snapshot' };
    if (opts.baseline) {
        const idx = opts.assistantIds.indexOf(opts.baseline);
        if (idx < 0)
            return { action: 'clear_abandoned', baseline: opts.baseline };
        if (idx === opts.assistantIds.length - 1) {
            return { action: 'wait', baseline: opts.baseline };
        }
        return { action: 'slice', fromIndex: idx + 1 };
    }
    if (opts.baselineCaptured === true)
        return { action: 'all' };
    return { action: 'fail_closed_legacy' };
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
export function scopeAssistantsAfterBaseline(assistants, decision) {
    switch (decision.action) {
        case 'slice':
            return assistants.slice(decision.fromIndex);
        case 'all':
        case 'fail_closed_legacy':
            // Legacy state shape (no baseline info at all) — fall back to the whole
            // history rather than fail closed, which has no safe meaning here the
            // way it does for mirroring.
            return assistants;
        case 'wait':
        case 'fail_closed_snapshot':
        default:
            return [];
    }
}
/**
 * Clear an abandoned inject cursor (vanished baseline after OpenCode session
 * rotate). Returns true when state was cleared.
 */
export function clearAbandonedInjectCursor(baseline) {
    logPoll(`mirrorLatestReply: clearing abandoned inject cursor — baseline ${baseline} not in current OpenCode session`);
    const next = patchState({
        awaitingRemoteReply: false,
        replyAfterOpenCodeMessageId: null,
        replyBaselineCaptured: undefined,
        busy: false,
        busySince: null,
    });
    return Boolean(next);
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
const MIRROR_MIN_GAP_MS = 1_500;
/** Wait after the last message.updated before mirroring — covers tool-call lag. */
export const MIRROR_SETTLE_MS = 2_000;
const mirrorGuards = new Map();
const mirrorSettleTimers = new Map();
/** In-memory debounce/guard key. The OpenCode session id is already unique. */
function mirrorGuardKey(sessionId) {
    return sessionId;
}
export async function mirrorNow(client, directory, sessionId, { force = false } = {}) {
    const bonded = isBondedOpenCodeSession(sessionId);
    const run = async () => {
        const auth = resolveDevspecAuth(directory);
        const state = readState();
        if (!auth.ok || !auth.token || !auth.mcp_url || !state?.sessionId)
            return;
        const key = mirrorGuardKey(sessionId);
        const guard = mirrorGuards.get(key) ?? { at: 0, inFlight: false };
        if (guard.inFlight)
            return;
        if (!force && Date.now() - guard.at < MIRROR_MIN_GAP_MS)
            return;
        guard.inFlight = true;
        guard.at = Date.now();
        mirrorGuards.set(key, guard);
        try {
            await mirrorLatestReply(client, auth, directory, state, sessionId, { force });
        }
        catch (err) {
            logPoll(`mirrorNow failed: ${err}`);
        }
        finally {
            guard.inFlight = false;
            mirrorGuards.set(key, guard);
        }
    };
    if (!bonded) {
        // FAIL CLOSED (item 2a5d212b). `undefined` means this OpenCode session has no
        // bond — an @explore child, a sibling tab, an ordinary interactive chat that
        // never ran /devspec.remote. It used to mean "run against whatever the
        // process-global bind happens to be", and on 2026-08-17 that published an
        // unbonded child's 3,886-token internal handoff into DevSpec session
        // 8fd18ec0 under bonded connection 7695c4dc's identity.
        //
        // A remote identity speaks only from the session bonded to it. There is
        // nothing sensible to fall back to here: the whole question this answers is
        // WHICH room this text belongs in, and an unbonded session has no answer.
        logPoll(`mirrorNow: opencodeSession=${sessionId} has no bond — inert`);
        return;
    }
    await runWithBondAsync(sessionId, run);
}
/**
 * Debounced mirror for `message.updated` — resets on every update so we only
 * run after the turn has gone quiet long enough for a manual post tool to land.
 */
export function scheduleMirrorNow(client, directory, sessionId) {
    const key = mirrorGuardKey(sessionId);
    const prev = mirrorSettleTimers.get(key);
    if (prev)
        clearTimeout(prev);
    const timer = setTimeout(() => {
        mirrorSettleTimers.delete(key);
        void mirrorNow(client, directory, sessionId);
    }, MIRROR_SETTLE_MS);
    // Don't keep the process alive solely for this timer.
    if (typeof timer === 'object' && timer && 'unref' in timer) {
        ;
        timer.unref();
    }
    mirrorSettleTimers.set(key, timer);
}
/** Cancel any pending settle timer and mirror immediately (session.idle path). */
export function flushMirrorNow(client, directory, sessionId) {
    const key = mirrorGuardKey(sessionId);
    const prev = mirrorSettleTimers.get(key);
    if (prev)
        clearTimeout(prev);
    mirrorSettleTimers.delete(key);
    void mirrorNow(client, directory, sessionId, { force: true });
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
const trailGuards = new Map();
const trailTrailingTimers = new Map();
/** Debounced/throttled trail publish for `message.updated`. */
export function scheduleWorkTrailPost(client, directory, sessionId) {
    const key = mirrorGuardKey(sessionId);
    void postWorkTrail(client, directory, sessionId);
    // Whatever arrives during the gap still reaches the room: schedule one trailing
    // publish so the last update before a quiet stretch is never the one dropped.
    if (trailTrailingTimers.has(key))
        return;
    const timer = setTimeout(() => {
        trailTrailingTimers.delete(key);
        void postWorkTrail(client, directory, sessionId);
    }, TRAIL_POST_MIN_GAP_MS);
    if (typeof timer === 'object' && timer && 'unref' in timer) {
        ;
        timer.unref();
    }
    trailTrailingTimers.set(key, timer);
}
/**
 * Serialize and post the current turn's trail, subject to the throttle.
 *
 * Only while a remote turn is actually in flight (`busy` or `awaitingRemoteReply`):
 * a trail posted outside one would open a streaming bubble that nothing is going
 * to close. Best-effort throughout — a failed trail post must never disturb the
 * turn or the mirror that ends it.
 */
export async function postWorkTrail(client, directory, sessionId, { force = false, seed = false } = {}) {
    const bonded = isBondedOpenCodeSession(sessionId);
    const run = async () => {
        const auth = resolveDevspecAuth(directory);
        const state = readState();
        if (!auth.ok || !auth.token || !auth.mcp_url)
            return;
        if (!state?.sessionId || !state.connectionId)
            return;
        if (!state.busy && !state.awaitingRemoteReply)
            return;
        const key = mirrorGuardKey(sessionId);
        const guard = trailGuards.get(key) ?? { inFlight: false, pending: false };
        if (guard.inFlight) {
            // A trailing timer alone is not enough: if it fires while this post is
            // still in flight it no-ops, and with no further message.updated the last
            // chunk of a quiet stretch never leaves the laptop. Mark dirty and flush
            // once the in-flight post clears.
            guard.pending = true;
            trailGuards.set(key, guard);
            return;
        }
        let messages;
        try {
            const res = await withTimeout(client.session.messages({ path: { id: sessionId } }), OPENCODE_SESSION_API_TIMEOUT_MS, 'session.messages(trail)');
            messages = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
        }
        catch (err) {
            logPoll(`postWorkTrail: client.session.messages failed: ${err}`);
            return;
        }
        // Same baseline the mirror correlates on: everything after the pre-inject
        // assistant is this remote turn's work. Without one, only the newest turn.
        const rawTrail = serializeTurnTrail(messages, {
            afterMessageId: state.replyAfterOpenCodeMessageId ?? null,
        });
        // Turn-start seed (item 05a88ed5): only substitute the placeholder when
        // there is genuinely nothing to show yet. Real content always wins, so a
        // seed call racing behind a message.updated-triggered post never clobbers
        // it — "one trail row" holds, never an orphan second bubble.
        const usingSeed = seed && !rawTrail.trim();
        const trail = usingSeed ? TRAIL_SEED_TEXT : rawTrail;
        const trailHash = hashPostedContent(trail);
        if (!shouldPostTrail({
            trail,
            trailHash,
            lastPostedTrailHash: state.lastTrailHash ?? null,
            lastPostedAt: state.lastTrailPostedAt ?? null,
            now: Date.now(),
            force,
            seed,
        })) {
            return;
        }
        guard.inFlight = true;
        guard.pending = false;
        trailGuards.set(key, guard);
        // Claim the throttle window before the round-trip so concurrent updates during
        // it do not queue a second identical post behind this one.
        patchState({ lastTrailHash: trailHash, lastTrailPostedAt: Date.now() });
        try {
            const result = await mcpToolsCall({
                mcpUrl: auth.mcp_url,
                token: auth.token,
                name: 'post_session_message',
                arguments: postMessageArgs(state, trail, { turn_kind: 'agent', phase: 'trail' }),
                timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
            });
            const messageId = extractPostedMessageId(result);
            if (messageId && messageId !== readState()?.activeTrailMessageId) {
                patchState({ activeTrailMessageId: messageId });
                logPoll(`postWorkTrail: opened live trail turn ${messageId}`);
            }
        }
        catch (err) {
            // Roll the hash back so the next update retries rather than assuming this
            // body already landed.
            patchState({ lastTrailHash: state.lastTrailHash ?? null });
            logPoll(`postWorkTrail: post_session_message(phase=trail) failed: ${err}`);
        }
        finally {
            const stillPending = guard.pending;
            guard.inFlight = false;
            guard.pending = false;
            trailGuards.set(key, guard);
            if (stillPending) {
                void postWorkTrail(client, directory, sessionId);
            }
        }
    };
    if (!bonded) {
        // FAIL CLOSED (item 2a5d212b) — same rule as mirrorNow above. An unbonded
        // session's tool calls and reasoning are not a trail of any remote turn, and
        // publishing them under the bonded connection's identity is a leak, not a
        // best effort.
        logPoll(`postWorkTrail: opencodeSession=${sessionId} has no bond — inert`);
        return;
    }
    await runWithBondAsync(sessionId, run);
}
/**
 * DevSpec's `message_id` out of an MCP tool result.
 *
 * `mcpToolsCall` unwraps JSON to `{ message_id, … }`; tests and some call
 * sites still pass the raw MCP envelope. Both shapes are accepted.
 * Mirror answer posts MUST require this id before claiming success (item 6990fd9e).
 */
export function extractPostedMessageId(result) {
    const parsed = parsePostedToolJson(result);
    const id = parsed?.message_id;
    return typeof id === 'string' && id ? id : null;
}
/** Whether `phase:'error'|'answer'` actually closed a server-open trail turn. */
export function extractClosedTrailTurn(result) {
    return parsePostedToolJson(result)?.closed_trail_turn === true;
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
export function parsePostedToolJson(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result))
        return null;
    const obj = result;
    // Unwrapped mcpToolsCall success (the live path).
    if (typeof obj.message_id === 'string' ||
        obj.closed_trail_turn === true ||
        obj.noop === true ||
        typeof obj.session_id === 'string') {
        return obj;
    }
    // Raw MCP envelope.
    const content = obj.content;
    for (const block of Array.isArray(content) ? content : []) {
        const text = block?.text;
        if (typeof text !== 'string')
            continue;
        try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            // Not JSON (a plain error string) — nothing to extract.
        }
    }
    // mcpToolsCall fallback shape when the body was not valid JSON.
    if (typeof obj.raw === 'string') {
        try {
            const parsed = JSON.parse(obj.raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            /* ignore */
        }
    }
    return null;
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
export function clearInjectTurnState(opts = {}) {
    const state = readState();
    if (!state)
        return;
    const patch = {
        awaitingRemoteReply: false,
        replyAfterOpenCodeMessageId: null,
        replyBaselineCaptured: undefined,
        currentTurnMessageIds: null,
        manualAnswerPostedThisTurn: false,
        // Hashes are turn-scoped (item 4f9515a4) — drop them with the rest of the
        // inject-turn correlation so the next remote turn starts clean.
        recentPostedContentHashes: [],
        activeTrailMessageId: null,
        lastTrailHash: null,
        lastTrailPostedAt: null,
    };
    if (opts.unclaim && state.currentTurnMessageIds?.length) {
        const stuck = new Set(state.currentTurnMessageIds);
        patch.deliveredMessageIds = (state.deliveredMessageIds ?? []).filter((id) => !stuck.has(id));
        logPoll(`clearInjectTurnState: unclaiming ${stuck.size} stalled command id(s) from deliveredMessageIds ` +
            `so they can re-inject on the next poll: ${Array.from(stuck).join(', ')}`);
    }
    patchState(patch);
}
/** Forget this turn's trail bookkeeping once the turn has landed. */
function clearTrailState() {
    patchState({
        activeTrailMessageId: null,
        lastTrailHash: null,
        lastTrailPostedAt: null,
    });
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
async function failOpenTrailTurn(auth, state, reason) {
    if (!auth.ok || !auth.token || !auth.mcp_url)
        return false;
    if (!state.connectionId || !state.sessionId)
        return false;
    let result;
    try {
        result = await mcpToolsCall({
            mcpUrl: auth.mcp_url,
            token: auth.token,
            name: 'post_session_message',
            arguments: postMessageArgs(state, reason, { turn_kind: 'agent', phase: 'error' }),
            timeoutMs: MCP_SHORT_CALL_TIMEOUT_MS,
        });
    }
    catch (err) {
        logPoll(`failOpenTrailTurn: post_session_message(phase=error) failed: ${err}`);
        return false;
    }
    const closed = extractClosedTrailTurn(result);
    if (!closed) {
        // Server had no open trail turn — leave the fallback notice path alone.
        // Item 40279ae0: also clear the broader inject-turn state (not just the
        // trail pointers) here — this "abandon" branch still means the turn is
        // over from this connection's point of view. Callers that know the end
        // was ABNORMAL (checkBusyStall, handleSessionError) additionally unclaim
        // this turn's ids at their own call site right after this returns.
        clearInjectTurnState();
        return false;
    }
    const messageId = extractPostedMessageId(result) ?? state.activeTrailMessageId ?? null;
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
    });
    // Item 40279ae0: same reasoning as the abandon branch above — a closed
    // trail turn means this connection's remote turn is over.
    clearInjectTurnState();
    return true;
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
async function mirrorLatestReply(client, auth, directory, state, sessionId, opts = {}) {
    // Sessionless: no room. connection_id without attachment would be rejected server-side.
    if (!auth.ok || !auth.token || !auth.mcp_url || !state.sessionId || !state.connectionId)
        return;
    let messages;
    try {
        const res = await client.session.messages({ path: { id: sessionId } });
        messages = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    }
    catch (err) {
        logPoll(`mirrorLatestReply: client.session.messages failed: ${err}`);
        return;
    }
    const assistantMessages = messages.filter((m) => m?.info?.role === 'assistant');
    // Always re-read disk before the dedup decision — a concurrent setBusy /
    // prior mirror may have advanced the cursor since `state` was snapshotted
    // at the top of pollAndDeliver.
    const fresh = readState() ?? state;
    const alreadyMirrored = new Set(fresh.mirroredMessageIds ?? []);
    const baseline = fresh.replyAfterOpenCodeMessageId ?? null;
    const baselineCaptured = fresh.replyBaselineCaptured;
    // When awaiting a remote reply: correlate to pre-inject baseline. Fail closed
    // if the baseline snapshot failed; clear an abandoned cursor when the
    // baseline id vanished (OpenCode session rotated — 8d0f1726).
    let candidates = assistantMessages;
    if (fresh.awaitingRemoteReply) {
        const decision = decideAwaitingBaseline({
            baseline,
            baselineCaptured,
            assistantIds: assistantMessages.map((m) => m?.info?.id).filter(Boolean),
        });
        if (decision.action === 'fail_closed_snapshot') {
            logPoll('mirrorLatestReply: FAIL CLOSED — awaiting remote reply but baseline snapshot failed at inject');
            return;
        }
        if (decision.action === 'clear_abandoned') {
            clearAbandonedInjectCursor(decision.baseline);
            // Item 40279ae0: an abandoned cursor is an abnormal end for whatever
            // command(s) this turn claimed — unclaim them so they can re-inject
            // against the (now current) OpenCode session instead of being
            // silently swallowed forever by the delivery dedup set.
            clearInjectTurnState({ unclaim: true });
            await setBusy(directory, false);
            return;
        }
        if (decision.action === 'wait') {
            logPoll(`mirrorLatestReply: still waiting for assistant after baseline ${decision.baseline}`);
            return;
        }
        if (decision.action === 'slice') {
            candidates = assistantMessages.slice(decision.fromIndex);
        }
        else if (decision.action === 'all') {
            candidates = assistantMessages;
        }
        else {
            logPoll('mirrorLatestReply: FAIL CLOSED — awaiting remote reply with null baseline and unknown capture status');
            return;
        }
    }
    const last = candidates[candidates.length - 1];
    logPoll(`mirrorLatestReply: ${assistantMessages.length} assistant messages, candidates=${candidates.length}, ` +
        `last.id=${last?.info?.id}, lastMirrored=${fresh.lastMirroredMessageId}, ` +
        `awaiting=${fresh.awaitingRemoteReply} baseline=${baseline} captured=${baselineCaptured}`);
    if (!last?.info?.id || last.info.id === fresh.lastMirroredMessageId || alreadyMirrored.has(last.info.id)) {
        logPoll(`mirrorLatestReply: skip (already mirrored or no last message)`);
        return;
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
        logPoll(`mirrorLatestReply: skip (active tool work, mid-turn) last.id=${last.info.id} — ` +
            `trail covers this; waiting for quiescence or session.idle`);
        return;
    }
    // ---- The only egress gate: what the turn DID, never what it said ---------
    //
    // A turn that performed the DevSpec connect handshake is the plugin's own
    // protocol and produces no room post. That fact is observed from the tool
    // calls the turn made (`tool.execute.after` sees register/attach mid-turn),
    // so there is nothing here to infer from the model's prose and no override
    // to fall through — the previous version peeked at the text, decided "Done."
    // looked like a real answer, and published it into a room the conversation
    // had never chosen.
    //
    // Everything else posts: an answer to a delivered owner command, and an
    // ordinary local turn in an attached chat (the room is a shared transcript).
    // The model's words go through verbatim, exactly as the work trail already
    // does — chrome filtering is what this deletes, not a thing it preserves.
    //
    // `awaitingRemoteReply` exempts a turn that is answering a delivered owner
    // command: a stale handshake flag must never swallow a real answer. That was
    // the structural half of the old check and it is kept — b156e680 needed a
    // text override only because `command.executed` could tag a LATER turn's
    // message id, which marking at tool-call time no longer does.
    const isHandshakeTurn = !fresh.awaitingRemoteReply &&
        (Boolean(fresh.connectMirrorSuppressed) ||
            (fresh.nonMirrorMessageIds ?? []).includes(last.info.id));
    if (isHandshakeTurn) {
        logPoll(`mirrorLatestReply: skip (connect handshake turn) last.id=${last.info.id} — ` +
            `this turn ran the DevSpec handshake, so it has no answer to post`);
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
        });
        alreadyMirrored.add(last.info.id);
        patchState({
            lastMirroredMessageId: last.info.id,
            mirroredMessageIds: Array.from(alreadyMirrored).slice(-50),
            connectMirrorSuppressed: false,
            replyAfterOpenCodeMessageId: null,
            replyBaselineCaptured: undefined,
            currentTurnMessageIds: null,
            manualAnswerPostedThisTurn: false,
        });
        await setBusy(directory, false);
        return;
    }
    const text = assistantTextFromMessage(last);
    if (!text) {
        logPoll(`mirrorLatestReply: last.id=${last.info.id} has no text yet, not persisting — will recheck`);
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
        return;
    }
    // The model's words, verbatim. `prepareMirrorText` used to classify text here
    // — stripping a pasted banner, returning null for anything it judged to be
    // "pure chrome" — because the connect turn had no other channel and its
    // status block would otherwise land in the room as an answer. The handshake
    // turn is now excluded structurally above, so there is nothing left for a
    // classifier to catch, and the work trail already sets the precedent of
    // keeping assistant text exactly as written.
    const preparedText = collapseOrphanMarkdownFences(unwrapSingleOuterMarkdownFence(text.trim()));
    // Nothing to post is not a judgement about content — it is the absence of
    // any. A textless turn (pure tool calls) still has to settle, or the room
    // sits at "working…" for ever.
    if (!preparedText || !preparedText.trim()) {
        logPoll(`mirrorLatestReply: skip (turn produced no text) last.id=${last.info.id}`);
        logRemoteControlStory({
            phase: 'mirror_decision',
            outcome: 'skip',
            connectionId: fresh.connectionId,
            sessionId: fresh.sessionId,
            agent: AGENT_NAME,
            codename: fresh.codename,
            tool: 'mirrorLatestReply',
            reason: 'no_text',
            data: { message_id: last.info.id },
        });
        // A live trail bubble opened by this turn would otherwise stream for ever:
        // the answer that closes it is never coming, because there wasn't one. Fail
        // it so the room shows a finished turn that produced no reply, with the work
        // still readable, rather than a permanent "working…". Always attempt — the
        // server owns the open-turn pointer, not local activeTrailMessageId.
        await failOpenTrailTurn(auth, fresh, '⚠️ The remote agent finished this turn without an answer — only operational output. The work above is what it did.');
        alreadyMirrored.add(last.info.id);
        patchState({
            lastMirroredMessageId: last.info.id,
            mirroredMessageIds: Array.from(alreadyMirrored).slice(-50),
            awaitingRemoteReply: false,
            replyAfterOpenCodeMessageId: null,
            replyBaselineCaptured: undefined,
            currentTurnMessageIds: null,
            manualAnswerPostedThisTurn: false,
        });
        await setBusy(directory, false);
        return;
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
    const contentHash = hashPostedContent(preparedText);
    const alreadyPostedByHash = (fresh.recentPostedContentHashes ?? []).includes(contentHash);
    const alreadyPostedByTool = candidates.some((m) => messageHasPostSessionMessageTool(m));
    const alreadyPostedManually = Boolean(fresh.manualAnswerPostedThisTurn);
    // Hash-only hits must NOT skip while a live trail is still open (item 4f9515a4).
    // Cross-turn identical short answers used to hash-skip here and leave
    // response_status=streaming forever; tool/manual posts already closed the
    // trail server-side, so those skips remain safe.
    const hashSkipWouldOrphanTrail = alreadyPostedByHash &&
        !alreadyPostedByTool &&
        !alreadyPostedManually &&
        Boolean(fresh.activeTrailMessageId);
    if (hashSkipWouldOrphanTrail) {
        logPoll(`mirrorLatestReply: content-hash hit but trail ${fresh.activeTrailMessageId} still open — ` +
            `posting phase=answer anyway (last.id=${last.info.id} hash=${contentHash.slice(0, 8)}…)`);
    }
    if ((alreadyPostedByHash || alreadyPostedByTool || alreadyPostedManually) &&
        !hashSkipWouldOrphanTrail) {
        const via = alreadyPostedByTool ? 'tool' : alreadyPostedManually ? 'manual-flag' : 'content-hash';
        logPoll(`mirrorLatestReply: skip (already posted via ${via}) ` +
            `last.id=${last.info.id} hash=${contentHash.slice(0, 8)}…`);
        logRemoteControlStory({
            phase: 'mirror_decision',
            outcome: 'skip',
            connectionId: fresh.connectionId,
            sessionId: fresh.sessionId,
            agent: AGENT_NAME,
            codename: fresh.codename,
            tool: 'mirrorLatestReply',
            reason: via === 'tool' ? 'already_posted_tool' : via === 'manual-flag' ? 'already_posted_manual_flag' : 'already_posted_hash',
            data: { message_id: last.info.id },
        });
        alreadyMirrored.add(last.info.id);
        patchState({
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
        });
        await setBusy(directory, false);
        return;
    }
    // Optimistic claim BEFORE the network post — closes the race where two
    // concurrent poll/idle paths both pass the dedup check, both post, then
    // both write. Whichever claims second sees the id already in the set and
    // skips. If the post fails we roll the claim back so a later poll can retry.
    alreadyMirrored.add(last.info.id);
    const claimed = patchState({
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
    });
    if (!claimed)
        return;
    // Another writer may have claimed the same id between our check and patch
    // if we lost a race on lastMirrored — re-check isn't perfect without a
    // lock, but the set membership after merge is enough when both use patchState.
    const modelExtract = resolveOpenCodeAssistantModel(last);
    const model = modelExtract.model;
    if (!model) {
        // Never silent — DevSpec has no record of which model answered when the
        // stamp is dropped (Obsidian Gecko RCA / Restless Ocelot).
        const shape = modelExtract.rawSnippet ??
            summarizeModelShapeSnippet(last.info);
        logPoll(`mirrorLatestReply: model stamp missing (${modelExtract.missingReason ?? 'absent'}) ` +
            `last.id=${last.info.id} source=${modelExtract.source} shape=${shape}`);
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
        });
    }
    // phase:'answer' closes the live work-trail bubble this turn has been growing
    // (item bfca2495) by writing the chrome-filtered answer into the SAME row,
    // instead of leaving it streaming under a second, duplicate message. With no
    // open trail turn the server falls back to the historical insert, so every
    // mirror can take this path unconditionally. complete_turn rides along so the
    // Working dots clear with the bubble rather than one report_complete later.
    let postedDevspecMessageId = null;
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
        });
        // Item 6990fd9e: "no throw" is not success. Live: mcpToolsCall returned
        // without throwing, we logged posted + claimed the OpenCode id, but no
        // session_messages row existed. Require a DevSpec message_id before keeping
        // the optimistic claim.
        postedDevspecMessageId = extractPostedMessageId(result);
        if (!postedDevspecMessageId) {
            throw new Error('post_session_message returned without message_id — refusing silent mirror success');
        }
    }
    catch (err) {
        // Roll back the optimistic claim so this reply can be retried.
        const ids = (readState()?.mirroredMessageIds ?? []).filter((id) => id !== last.info.id);
        const hashes = (readState()?.recentPostedContentHashes ?? []).filter((h) => h !== contentHash);
        patchState({
            lastMirroredMessageId: fresh.lastMirroredMessageId ?? null,
            mirroredMessageIds: ids,
            awaitingRemoteReply: fresh.awaitingRemoteReply ?? false,
            replyAfterOpenCodeMessageId: fresh.replyAfterOpenCodeMessageId ?? null,
            replyBaselineCaptured: fresh.replyBaselineCaptured,
            currentTurnMessageIds: fresh.currentTurnMessageIds ?? null,
            manualAnswerPostedThisTurn: fresh.manualAnswerPostedThisTurn ?? false,
            recentPostedContentHashes: hashes,
        });
        logPoll(`mirrorLatestReply: post_session_message failed for last.id=${last.info.id}: ${err}`);
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
        });
        return;
    }
    // Answer landed: the trail turn is closed server-side, so this connection has
    // no open bubble any more. Clearing the pointer is what lets the NEXT turn open
    // a fresh one instead of appending to a turn that already has an answer.
    clearTrailState();
    logPoll(`mirrorLatestReply: posted last.id=${last.info.id} via connection_id` +
        ` devspec_message_id=${postedDevspecMessageId}` +
        (model ? ` model=${model.providerID}/${model.modelID}` : ' model=(none)'));
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
    });
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
    });
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
    await setBusy(directory, false);
}
