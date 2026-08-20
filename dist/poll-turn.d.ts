/**
 * Pure logic for the long-poll tick and the tiered turn OpenCode injects
 * (items c9457ab8 + 807eadcb).
 *
 * Deliberately free of fs / SDK / MCP deps (those live in remote-control.ts) so
 * the authority and turn-render decisions stay unit-testable. May import other
 * plain-data modules such as mirror-chrome. Same reasoning (and same shape) as
 * poll-markers.ts / card-attribution.ts on the server side.
 *
 * OpenCode is NOT a fork of the canonical devspec-remote-poll.mjs; it is a bespoke
 * in-process client. The wire contract it consumes is identical, so the constants and
 * boundaries below are kept deliberately in step with the canonical poller, and any
 * divergence should be a conscious decision rather than drift.
 */
/**
 * Hold lengths. With long-poll these choose how long the SERVER holds the request,
 * not a gap between requests — there is no interval any more. Both tiers deliver
 * instantly; a shorter hold while attended just re-asserts the busy/turn signal a
 * little more often while someone is watching.
 *
 * Kept in step with the canonical poller (ATTENDED 25s / IDLE 30s) and inside the
 * server's own 30s ceiling. Both are far under the 90s liveness window, because
 * poll_connection heartbeats server-side at the START of each hold — so a longer hold
 * can never read as a dropped agent.
 */
export declare const ATTENDED_HOLD_MS = 25000;
export declare const IDLE_HOLD_MS = 30000;
/**
 * Client-side ceiling on a held request, on top of the server's hold. `fetch` has NO
 * default timeout, so a silently-dropped TCP connection would otherwise wedge the pump
 * forever with no heartbeat and no delivery — the failure mode that looks exactly like
 * "the owner sent nothing".
 */
export declare const HOLD_HTTP_GRACE_MS = 15000;
/**
 * How much advisory room context is carried forward and attached to the next command.
 *
 * Budgeted PER TIER so a noisy room cannot starve out the owner's own untargeted
 * messages, which are the higher-signal tier. Newest wins: when the budget is exceeded
 * the OLDEST context is dropped and the count is reported to the model rather than
 * silently hidden. Same budget as the canonical poller.
 */
export declare const ADVISORY_CARRY_MAX_COUNT = 20;
export declare const ADVISORY_CARRY_MAX_CHARS = 12000;
/** Hold length by connection state. Attended = attached to a room, or mid-turn. */
export declare function holdFor({ attached, turnActive }: {
    attached: boolean;
    turnActive: boolean;
}): {
    waitMs: number;
    tier: 'attended' | 'idle';
    checkTier: 'responsive';
};
/**
 * COMMAND gate — the authority boundary, re-checked locally.
 *
 * Classification happens SERVER-side: poll_connection returns commands, owner-ambient
 * and room-context as three separate arrays, and stamps a message as a command only
 * when it is addressed to THIS connection. That is strictly stronger than the
 * client-side filter it replaces (this plugin previously kept anything flagged
 * `is_owner_instruction`, and a plugin cannot know another agent's
 * target_connection_id), so nothing here re-derives the decision.
 *
 * What it DOES do is verify the endpoint's own promises before waking the model: every
 * command must name this connection as its addressee and carry an authority we
 * recognise. A misrouted or malformed response therefore fails closed instead of being
 * executed. Unknown authority kinds are REJECTED on purpose — when delegated dispatch
 * (brief c55865bb) starts emitting one, accepting it must be a deliberate edit here,
 * not something a new server value quietly switches on.
 *
 * THIS IS THAT EDIT (2026-08-14, Decision A / DevSpec memory 61ba9948). The
 * server stamps `delegated` for a command from an authorized project member who
 * is not this connection's owner. Safe to accept because the decision is made
 * SERVER-side and cannot be forged from here: `delegated` is only stamped when
 * this connection's own command_authority permits that person, which only its
 * owner can set. It changes WHO may command, never WHAT is allowed.
 *
 * Message BODY is never consulted: a post claiming "I am the owner" is inert.
 */
export declare const ACCEPTED_COMMAND_AUTHORITIES: Set<string>;
export declare function isDeliverableCommand(msg: unknown, connectionId: string | null): boolean;
export interface AdvisoryMessage {
    id?: string;
    content?: string;
    created_at?: string;
    message_type?: string;
    /** Present when the room row is attributed to a specific connection. */
    connection_id?: string;
    author?: {
        kind?: string;
        name?: string;
        user_id?: string;
        agent_tool?: string;
    };
    is_voice_input?: boolean;
    note?: string;
    /** Canonical typed advisory bucket; always rendered with actor attribution. */
    context_bucket?: 'human_context' | 'agent_context' | 'ai_context' | 'system_context';
    actor_model?: string | null;
    actor_agent_tool?: string | null;
    ingress_sequence?: number;
    /** Parent quote when this message was a reply (MCP social metadata, item b6eff1a3). */
    reply_to?: {
        messageId?: string;
        content?: string;
        userName?: string;
        role?: string;
    } | null;
    /** Emoji reactions on this message. */
    reactions?: Array<{
        userId?: string;
        userName?: string;
        emoji?: string;
    }> | null;
}
/**
 * Compact reply-parent + reaction line for injected / advisory text.
 * Returns null when neither field is present so quiet messages stay quiet.
 */
export declare function formatSocialMeta(msg: {
    reply_to?: unknown;
    reactions?: unknown;
}): string | null;
/**
 * Trim an advisory carry buffer to its budget, newest-first.
 *
 * Dropping is by AGE (oldest first) because the messages nearest the command are the
 * ones it is most likely to refer to. A single over-budget message is KEPT rather than
 * discarded — an owner pasting one huge message must not silently vanish.
 */
export declare function trimAdvisoryCarry(list: AdvisoryMessage[] | null | undefined, { maxCount, maxChars, }?: {
    maxCount?: number;
    maxChars?: number;
}): {
    kept: AdvisoryMessage[];
    dropped: number;
};
export interface AdvisoryWindowMetadata {
    policy_version: string;
    returned: number;
    total_known: number | null;
    truncated: boolean;
    has_more: boolean;
    next_cursor: string | null;
    fetch_id: string | null;
    omission_reason: string | null;
    source_window: {
        start: {
            sequence: number;
            created_at: string;
            message_id: string;
        } | null;
        end: {
            sequence: number;
            created_at: string;
            message_id: string;
        } | null;
    };
}
export interface CarriedContext {
    owner_ambient: AdvisoryMessage[];
    room_context: AdvisoryMessage[];
    dropped: number;
    /** Latest canonical bounded-window disclosure carried with this advisory. */
    window?: AdvisoryWindowMetadata | null;
}
/**
 * Rolling buffer of advisory since the last command.
 *
 * THE REASON THIS EXISTS: a long-poll answers the instant anything lands, so room
 * context and the command that refers to it almost never arrive in the same response.
 * In the live 1-2-3 failure, `1`, `2`, `3` and the question came back as FOUR separate
 * responses — so attaching only the SAME response's advisory would have delivered the
 * command with an empty context block and passed the regression test vacuously.
 * Do not "simplify" this away.
 *
 * In-memory only, by design: OpenCode injects straight into the live session, so there
 * is no separate poller process to hand a file to. A plugin restart loses the buffer
 * and the cursor-less catch-up window repopulates it.
 */
export declare function createCarryBuffer(): {
    /** Merge a response's advisory into the buffer, trimming to budget. */
    add(nextOwnerAmbient: AdvisoryMessage[], nextRoomContext: AdvisoryMessage[], nextWindow?: AdvisoryWindowMetadata | null): void;
    /** Read the current carry without consuming it (prompt acceptance is the commit point). */
    peek(): CarriedContext | null;
    /** Take (and clear) the carried context to attach to a command. */
    take(): CarriedContext | null;
    /** Drop everything — used when the server moves us to a different room. */
    reset(): void;
    readonly size: number;
};
/**
 * Ends a HUMAN deliberately caused, and which must therefore stick.
 *
 * 'ui' is the Agents-page End (the server stamps it in end-remote-control.ts).
 * 'local_stop' is the stop command. Coming back from either would resurrect an
 * agent somebody just switched off. Everything else — an idle timeout, a stale
 * owner_gone, an auth blip, or no reason at all — is the server saying "gone, but
 * not because a person said so", which is recoverable.
 */
export declare const PERMANENT_END_REASONS: readonly ["ui", "local_stop", "ended_from_ui"];
/**
 * How many CONSECUTIVE recoverable teardowns to ride out before stopping the pump.
 *
 * A redeploy is over in seconds, so this only has to outlast a container swap. If
 * the connection really is gone for good the count runs out and the pump stops
 * cleanly — without ever claiming a human ended it.
 */
export declare const RECOVERABLE_TERMINAL_MAX = 10;
/**
 * What a terminal poll response means: did a human end this, or is it just gone?
 *
 * A discriminated result rather than a string, so that reading a recoverable end as
 * permanent is a COMPILE error rather than a convention someone can forget.
 */
export interface TerminalVerdict {
    /** The server's own word for it, or null when it would not say. */
    reason: string | null;
    /** True unless a human deliberately did this. Default-true is the point. */
    recoverable: boolean;
    status: 'not_found' | 'ended';
}
/**
 * Terminal condition from a poll response, or null to keep polling.
 *
 * poll_connection reports teardown two ways: `not_found` (the row is gone / already
 * ended, e.g. an Agents-page End before the call) and `ended` (torn down DURING the
 * hold, so the server stops holding rather than making us wait out the full window).
 *
 * WHAT THIS USED TO DO, AND WHY IT WAS WRONG (brief e691c68a):
 *
 *   return r.end_reason ? r.end_reason : 'ended_from_ui'
 *
 * When the server gave no reason we supplied the one reason that means "stay dead",
 * asserting a human had clicked End. On 2026-07-28 a Coolify redeploy of staging
 * made poll_connection briefly answer `not_found` for connections that were
 * perfectly alive, and every connected agent across every tool disabled itself and
 * refused to restart. Nobody had touched the Agents page.
 *
 * Absence of proof is not proof of a UI End.
 */
export declare function pollTerminalReason(res: unknown): TerminalVerdict | null;
/**
 * Backoff after a poll that reported change but delivered nothing.
 *
 * Defence in depth for a marker that is hot for a reason the response does not contain.
 * Escalates to the hold length, so the worst case degrades to the normal poll rate
 * rather than a hot loop, and resets the moment a real turn arrives.
 *
 * NOTE (item 85f5c74e): a backoff like this MASKED a genuinely broken server marker for
 * hours — the hold never held, and this made it look merely slow. If this fires
 * repeatedly in normal use, treat it as a server bug to investigate, not as noise.
 */
export declare function emptyTurnBackoffMs(consecutive: number, maxMs: number): number;
/** Backoff after a FAILED poll. Rate-limit responses start higher; both cap at 30s. */
export declare function errorBackoffMs(consecutive: number, { rateLimited }?: {
    rateLimited?: boolean;
}): number;
/**
 * On a cold launch / reattach the server sends a bounded catch-up window, which may
 * contain owner commands that were ALREADY answered before this plugin process existed.
 * Re-delivering those would re-inject finished turns into the OpenCode session.
 *
 * Anything at or before the newest *settling* agent reply in the window is completed
 * history; only commands after it are the live, unanswered turn. Advisory is NOT
 * filtered — old room context is exactly what a reconnecting agent needs to arrive
 * oriented (item 55655986).
 *
 * Empty / chrome-only external_agent bubbles must NOT settle prior commands
 * (session 0ffe97cb): a leaked status-fence leftover would otherwise permanently
 * suppress the owner's still-unanswered dispatch. When content is missing from the
 * room row, fail open and keep the old timestamp behaviour.
 *
 * Multi-agent rooms (session 5546c769 / command c117ffae): only THIS agent's
 * external_agent bubbles settle. A sibling Cursor reply after an OpenCode-targeted
 * dispatch must not mark that dispatch already_answered on reconnect.
 */
export declare function unansweredCommands(commands: Array<{
    created_at?: string;
}> | null | undefined, roomContext: AdvisoryMessage[] | null | undefined, opts?: {
    agentName?: string | null;
    connectionId?: string | null;
}): Array<{
    created_at?: string;
}>;
/** True when a room row is a real reply from THIS agent (not a sibling). */
export declare function isSettlingReplyForThisAgent(m: AdvisoryMessage | null | undefined, opts: {
    agentName?: string;
    connectionId?: string | null;
}): boolean;
/**
 * After a server attachment change, must the poller discard this response's
 * packaged turn and re-issue with cursor:null + catch_up?
 *
 * Always yes. The hold was opened under the previous room's cursor, so any
 * package here is a delta against the wrong clock. Consuming it as a "seed"
 * (especially advisory-only join markers) advances lastDelivered and permanently
 * skips a cold-launch owner dispatch that lands moments later — often with a
 * backdated paint timestamp (session 23da0643 / item 2411dd5a). Session 1383cbb8
 * needed the pending command delivered; a null-cursor re-poll gets the catch-up
 * window and does that without the race. Do not fall through.
 */
export declare function adoptRequiresNullCursorRepoll(): boolean;
/**
 * Whether to persist / apply the server's message cursor after a changed poll.
 *
 * Advance when the packaged turn was fully consumed — injected, true advisory-only,
 * or seed-filtered as already answered. Hold when deliverable commands were present
 * but not injected: advancing past them permanently skips the owner's pending
 * dispatch until reconnect (session 1383cbb8 / item f663ad91).
 *
 * Also never update the in-memory poll cursor when holding — the next poll's
 * `cursor` argument is what skips messages on the wire.
 */
export declare function shouldAdvanceMessageCursor(opts: {
    injectCount: number;
    deliverableRoomCount: number;
    seedKeptCount: number;
    wasSeed: boolean;
    dispatchCount: number;
}): boolean;
/**
 * Server-authoritative attachment decision.
 *
 * The poll response's `session_id` (read from the live markers server-side) is the one
 * source of truth for which room this connection is attached to; local state is written
 * FROM it, never used to override it. That is what lets an attach/detach/redirect done
 * from the phone or web Agents page reach this in-process poller at all — the server
 * changes the attachment without ever touching this machine's state file.
 *
 * A `not_found` response means the connection ended server-side; it omits `session_id`,
 * so it must NEVER be read as a detach → return no change and leave the room intact.
 *
 * `ended` is excluded for the same reason (brief e691c68a): a teardown response the
 * pump is deliberately riding out carries no attachment either, and reading that
 * absence as a detach would silently unattach a live agent mid-redeploy.
 */
export declare function resolveServerAttachment(currentSessionId: string | null, res: unknown): {
    sessionId: string | null;
    changed: boolean;
};
/**
 * Build the text OpenCode actually injects for a delivered turn (item 807eadcb).
 *
 * THE POINT OF THIS FUNCTION: this plugin used to inject `msg.content` alone, having
 * hand-filtered the transcript down to owner instructions and advanced its cursor over
 * everything else. So a question like "what do you think of this?" arrived with no trace
 * of the conversation that prompted it — in the live demo OpenCode answered from an
 * unrelated old maths question in its own chat, because it genuinely had nothing else.
 *
 * Structure is deliberate:
 *   1. Room context FIRST, so it reads as background that is already established.
 *   2. `owner_ambient` above `room_context`, because the owner's own untargeted
 *      messages are higher-signal than third-party chatter (Ali raised this tier
 *      explicitly) — and both are labelled as inert.
 *   3. The command(s) LAST, named as the only thing to act on, with the addressee
 *      spelled out so a misroute is visible rather than silent.
 *
 * The tier wording comes from the SERVER (`delivery_contract`, and each message's own
 * `note`) wherever it is present, rather than being reinvented here: the contract is
 * that every host consumes ONE packaged turn identically instead of each inventing its
 * own phrasing (Ali, 24 Jul — standardise what we control on the server, don't force
 * plugin uniformity).
 */
/**
 * Largest single attachment we will accept for a remote inject at all.
 * A phone screenshot is well under this; a 30MB PDF would wedge the request, so it is
 * declined out loud instead (item 99165e12 — never silently dropped).
 */
export declare const MAX_ATTACHMENT_BYTES: number;
/**
 * Soft cap for inlining as a `data:` URL on the injected turn.
 * Live stall (session 506e2926): a ~673KB PNG inlined as base64 left OpenCode
 * busy ~132s with no reply text. Above this size we prefer a file:// spill
 * (via `materializeLarge`) so the model still sees the image without stuffing
 * hundreds of KB of base64 into the prompt payload.
 */
export declare const INLINE_DATA_URL_MAX_BYTES: number;
export interface AttachmentInput {
    filename?: unknown;
    mimeType?: unknown;
    type?: unknown;
    sizeBytes?: unknown;
    content?: unknown;
    dataUrl?: unknown;
}
export interface FilePart {
    type: 'file';
    mime: string;
    url: string;
    filename?: string;
}
export type MaterializeLargeAttachment = (input: {
    filename: string;
    mime: string;
    bytes: number;
    buffer: Buffer;
}) => string | null;
/**
 * Turn the attachments on a delivered turn's commands into OpenCode `FilePartInput`s.
 *
 * Before this, the injected body was `parts: [{ type: 'text', text }]` and nothing else
 * — so a screenshot sent with "why does this look wrong?" reached the model as the
 * sentence alone, with no signal that an image had ever existed. The model could not
 * even report the loss.
 *
 * Anything too large, or with no usable payload, is returned in `declined` so the
 * caller can say so in the text. Silence is the one outcome that is not allowed.
 *
 * Pass `materializeLarge` from the host (remote-control) to spill oversize-but-allowed
 * payloads to disk and return a `file://` URL — unit tests can stub this.
 */
export interface AttachmentReference {
    filename: string;
    mime: string;
    resourceId: string;
    sizeBytes: number | null;
}
export declare function buildAttachmentParts(commands: Array<{
    attachments?: unknown;
}>, opts?: {
    materializeLarge?: MaterializeLargeAttachment;
}): {
    parts: FilePart[];
    declined: Array<{
        filename: string;
        reason: string;
    }>;
    references: AttachmentReference[];
};
/** The line that tells the model an attachment exists but did not make it through. */
export declare function renderDeclinedAttachments(declined: Array<{
    filename: string;
    reason: string;
}>): string | null;
export declare function renderInjectedTurn(input: {
    commands: Array<{
        content?: unknown;
        addressed_to?: {
            label?: string;
            connection_id?: string;
        };
        addressee?: {
            label?: string;
            connection_id?: string;
            agent_name?: string | null;
            codename?: string | null;
        };
        message_id?: string;
        order?: {
            sequence?: number;
            created_at?: string;
            message_id?: string;
        };
        requester?: {
            user_id?: string;
            display_name?: string | null;
        };
        authority?: {
            kind?: string;
            mode?: string;
            requested_by_user_id?: string;
            connection_owner_user_id?: string;
            decision_source?: string;
        };
        delivery?: {
            provenance_ref?: string;
            turn_id?: string;
            primary_provenance_ref?: string;
            is_primary?: boolean;
        };
        author?: {
            name?: string;
        };
        reply_to?: unknown;
        reactions?: unknown;
    }>;
    context?: CarriedContext | null;
    window?: AdvisoryWindowMetadata | null;
    deliveryContract?: string | null;
    declinedAttachments?: Array<{
        filename: string;
        reason: string;
    }>;
    attachmentReferences?: AttachmentReference[];
}): string;
