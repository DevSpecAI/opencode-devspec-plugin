/**
 * Strict local consumer for the negotiated remote-ingress wire contract.
 * Operational policy and the authoritative schema live at
 * devspec://product/remote-ingress-contract.
 */
export const REMOTE_INGRESS_VERSION = 1;
export const DELEGATED_SCOPE_VERSION = 1;
export const ACTIVE_PLAN_PROJECTION_VERSION = 1;
export const DELEGATED_PROJECT_POLICY_ID = 'delegated_project_v1';
const ACTIVE_PLAN_CONTRACT_VERSION = '1.3.0';
const ACTIVE_PLAN_POLICY_VERSION = '2026-08-21.1';
const SCOPED_CONTRACT_VERSION = '1.2.0';
const SCOPED_POLICY_VERSION = '2026-08-19.3';
export const ACTIVE_SESSION_PLAN_AUTHORITY_NOTE = 'Advisory read-awareness only. Presence does not authorize execution or mutation; manage_plan still requires a capability-authenticated caller identity, explicit plan_id for cross-plan work, and expected_revision.';
const ACTIVE_SESSION_PLAN_MAX_PLANS = 64;
const ACTIVE_SESSION_PLAN_MAX_STEPS = 64;
const ACTIVE_SESSION_PLAN_MAX_TITLE_CHARS = 300;
const ACTIVE_SESSION_PLAN_MAX_FAILURE_REASON_CHARS = 4096;
const ACTIVE_SESSION_PLAN_MAX_IDENTITY_CHARS = 300;
const ACTIVE_SESSION_PLAN_MAX_TOTAL_TEXT_CHARS = 131_072;
const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)$/i;
const OFFSET_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/;
function validOffsetDateTime(value) {
    if (typeof value !== 'string')
        return false;
    const match = OFFSET_DATETIME.exec(value);
    if (!match)
        return false;
    const [, year, month, day, hour, minute, second, zone, , offsetHour, offsetMinute] = match;
    const parts = [year, month, day, hour, minute, second].map(Number);
    const [y, mo, d, h, mi, s] = parts;
    if (h > 23 || mi > 59 || s > 59 || (zone !== 'Z' && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)))
        return false;
    const calendar = new Date(Date.UTC(y, mo - 1, d));
    return calendar.getUTCFullYear() === y && calendar.getUTCMonth() === mo - 1 && calendar.getUTCDate() === d && !Number.isNaN(Date.parse(value));
}
const record = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function exact(v, keys, at) {
    if (!record(v))
        throw new Error(`${at} must be an object`);
    const actual = Object.keys(v).sort();
    const wanted = [...keys].sort();
    if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i]))
        throw new Error(`${at} has missing or unknown fields`);
}
function str(v, at, nullable = false) {
    if (nullable && v === null)
        return;
    if (typeof v !== 'string' || v.length === 0)
        throw new Error(`${at} must be a non-empty string`);
}
function uuid(v, at, nullable = false) {
    if (nullable && v === null)
        return;
    if (typeof v !== 'string' || !UUID.test(v))
        throw new Error(`${at} must be a UUID`);
}
function oneOf(v, values, at) {
    if (typeof v !== 'string' || !values.includes(v))
        throw new Error(`${at} is unknown`);
}
function projectScope(v, at) {
    exact(v, ['kind', 'policy_id', 'project_id', 'instruction'], at);
    if (v.kind !== 'devspec_project')
        throw new Error(`${at}.kind is unknown`);
    if (v.policy_id !== DELEGATED_PROJECT_POLICY_ID)
        throw new Error(`${at}.policy_id is unknown`);
    uuid(v.project_id, `${at}.project_id`);
    if (typeof v.instruction !== 'string' || v.instruction.trim().length === 0)
        throw new Error(`${at}.instruction must be non-empty server text`);
}
export function isCanonicalProjectScope(v) {
    try {
        projectScope(v, 'project_scope');
        return true;
    }
    catch {
        return false;
    }
}
function order(v, at) {
    exact(v, ['sequence', 'created_at', 'message_id'], at);
    if (!Number.isSafeInteger(v.sequence) || v.sequence <= 0)
        throw new Error(`${at}.sequence is invalid`);
    if (!validOffsetDateTime(v.created_at))
        throw new Error(`${at}.created_at is invalid`);
    uuid(v.message_id, `${at}.message_id`);
}
function connection(v, at) {
    exact(v, ['connection_id', 'agent_name', 'codename', 'label'], at);
    uuid(v.connection_id, `${at}.connection_id`);
    str(v.agent_name, `${at}.agent_name`, true);
    str(v.codename, `${at}.codename`, true);
    str(v.label, `${at}.label`);
}
function attachment(v, at) {
    if (!record(v))
        throw new Error(`${at} must be an object`);
    if (v.materialization === 'metadata') {
        exact(v, ['materialization', 'filename', 'mime_type', 'type', 'size_bytes', 'resource_id'], at);
        uuid(v.resource_id, `${at}.resource_id`);
    }
    else if (v.materialization === 'unavailable') {
        exact(v, ['materialization', 'filename', 'mime_type', 'type', 'size_bytes', 'resource_id', 'reason'], at);
        if (v.resource_id !== null)
            throw new Error(`${at}.resource_id must be null`);
        oneOf(v.reason, ['missing_resource', 'legacy_inline_payload', 'access_denied'], `${at}.reason`);
    }
    else
        throw new Error(`${at}.materialization is unknown`);
    str(v.filename, `${at}.filename`);
    str(v.mime_type, `${at}.mime_type`);
    str(v.type, `${at}.type`);
    if (v.size_bytes !== null && (!Number.isSafeInteger(v.size_bytes) || v.size_bytes < 0))
        throw new Error(`${at}.size_bytes is invalid`);
}
function command(v, at) {
    exact(v, ['message_id', 'order', 'content', 'attachments', 'requester', 'authority', 'project_scope', 'addressee', 'delivery'], at);
    uuid(v.message_id, `${at}.message_id`);
    order(v.order, `${at}.order`);
    if (v.message_id !== v.order.message_id)
        throw new Error(`${at} identity mismatch`);
    exact(v.content, ['mode', 'body', 'complete'], `${at}.content`);
    if (v.content.mode !== 'full' || v.content.complete !== true || typeof v.content.body !== 'string')
        throw new Error(`${at}.content must be complete full content`);
    if (!Array.isArray(v.attachments))
        throw new Error(`${at}.attachments must be an array`);
    v.attachments.forEach((a, i) => attachment(a, `${at}.attachments[${i}]`));
    exact(v.requester, ['user_id', 'display_name'], `${at}.requester`);
    uuid(v.requester.user_id, `${at}.requester.user_id`);
    str(v.requester.display_name, `${at}.requester.display_name`, true);
    exact(v.authority, ['kind', 'mode', 'requested_by_user_id', 'connection_owner_user_id', 'decision_source'], `${at}.authority`);
    oneOf(v.authority.kind, ['owner', 'delegated'], `${at}.authority.kind`);
    oneOf(v.authority.mode, ['owner', 'project', 'allowlist'], `${at}.authority.mode`);
    uuid(v.authority.requested_by_user_id, `${at}.authority.requested_by_user_id`);
    uuid(v.authority.connection_owner_user_id, `${at}.authority.connection_owner_user_id`);
    if (v.authority.decision_source !== 'server' || v.requester.user_id !== v.authority.requested_by_user_id)
        throw new Error(`${at}.authority is inconsistent`);
    const owner = v.authority.requested_by_user_id === v.authority.connection_owner_user_id;
    if ((v.authority.kind === 'owner') !== owner || (v.authority.mode === 'owner' && v.authority.kind !== 'owner'))
        throw new Error(`${at}.authority contradicts requester`);
    if (v.authority.kind === 'owner') {
        if (v.project_scope !== null)
            throw new Error(`${at}.project_scope must be null for owner authority`);
    }
    else {
        projectScope(v.project_scope, `${at}.project_scope`);
    }
    connection(v.addressee, `${at}.addressee`);
    exact(v.delivery, ['provenance_ref', 'turn_id', 'primary_provenance_ref', 'is_primary'], `${at}.delivery`);
    uuid(v.delivery.provenance_ref, `${at}.delivery.provenance_ref`);
    uuid(v.delivery.turn_id, `${at}.delivery.turn_id`);
    uuid(v.delivery.primary_provenance_ref, `${at}.delivery.primary_provenance_ref`);
    if (typeof v.delivery.is_primary !== 'boolean')
        throw new Error(`${at}.delivery.is_primary is invalid`);
}
function contextEntry(v, kind, at) {
    exact(v, ['message_id', 'order', 'actor', 'source_type', 'relationship', 'content', 'advisory'], at);
    uuid(v.message_id, `${at}.message_id`);
    order(v.order, `${at}.order`);
    if (v.message_id !== v.order.message_id)
        throw new Error(`${at} identity mismatch`);
    exact(v.actor, ['kind', 'user_id', 'display_name', 'agent_tool', 'model'], `${at}.actor`);
    oneOf(v.actor.kind, ['human', 'agent', 'ai', 'system'], `${at}.actor.kind`);
    if (v.actor.kind !== kind)
        throw new Error(`${at}.actor kind mismatch`);
    uuid(v.actor.user_id, `${at}.actor.user_id`, true);
    str(v.actor.display_name, `${at}.actor.display_name`);
    str(v.actor.agent_tool, `${at}.actor.agent_tool`, true);
    str(v.actor.model, `${at}.actor.model`, true);
    str(v.source_type, `${at}.source_type`);
    oneOf(v.relationship, ['before_window', 'within_window', 'after_command'], `${at}.relationship`);
    if (typeof v.content !== 'string' || v.advisory !== true)
        throw new Error(`${at} must be advisory content`);
}
function planIdentity(v, at) {
    exact(v, ['kind', 'connection_id', 'agent_name', 'codename'], at);
    oneOf(v.kind, ['dev', 'connection'], `${at}.kind`);
    str(v.agent_name, `${at}.agent_name`);
    str(v.codename, `${at}.codename`, true);
    if (v.agent_name.length > ACTIVE_SESSION_PLAN_MAX_IDENTITY_CHARS ||
        (typeof v.codename === 'string' && v.codename.length > ACTIVE_SESSION_PLAN_MAX_IDENTITY_CHARS)) {
        throw new Error(`${at} identity text is too large`);
    }
    if (v.kind === 'dev') {
        if (v.connection_id !== null)
            throw new Error(`${at}.connection_id must be null for Dev`);
    }
    else {
        uuid(v.connection_id, `${at}.connection_id`);
    }
}
function planStep(v, at) {
    if (!record(v))
        throw new Error(`${at} must be an object`);
    const failed = v.status === 'failed';
    exact(v, [
        'id', 'position', 'title', 'status',
        ...(failed && v.failure_reason !== undefined ? ['failure_reason'] : []),
        ...(failed && v.retryable !== undefined ? ['retryable'] : []),
    ], at);
    uuid(v.id, `${at}.id`);
    if (!Number.isSafeInteger(v.position))
        throw new Error(`${at}.position is invalid`);
    str(v.title, `${at}.title`);
    if (v.title.length > ACTIVE_SESSION_PLAN_MAX_TITLE_CHARS)
        throw new Error(`${at}.title is too large`);
    oneOf(v.status, ['pending', 'in_progress', 'completed', 'failed', 'skipped'], `${at}.status`);
    if (v.status === 'failed') {
        if (v.failure_reason !== undefined) {
            str(v.failure_reason, `${at}.failure_reason`);
            if (v.failure_reason.length > ACTIVE_SESSION_PLAN_MAX_FAILURE_REASON_CHARS)
                throw new Error(`${at}.failure_reason is too large`);
        }
        if (typeof v.retryable !== 'boolean')
            throw new Error(`${at}.retryable is required for a failed step`);
    }
}
function activePlans(v, at) {
    exact(v, ['version', 'advisory', 'authority_note', 'inventory', 'plans'], at);
    if (v.version !== ACTIVE_PLAN_PROJECTION_VERSION || v.advisory !== true ||
        v.authority_note !== ACTIVE_SESSION_PLAN_AUTHORITY_NOTE)
        throw new Error(`${at} version/authority is unsupported`);
    exact(v.inventory, ['returned', 'total_known', 'truncated'], `${at}.inventory`);
    if (!Array.isArray(v.plans) || v.plans.length < 1 || v.plans.length > ACTIVE_SESSION_PLAN_MAX_PLANS)
        throw new Error(`${at}.plans count is invalid`);
    if (v.inventory.returned !== v.plans.length || v.inventory.total_known !== v.plans.length || v.inventory.truncated !== false)
        throw new Error(`${at}.inventory must describe a complete projection`);
    let totalText = 0;
    v.plans.forEach((rawPlan, index) => {
        const planAt = `${at}.plans[${index}]`;
        exact(rawPlan, ['id', 'title', 'revision', 'status', 'created_at', 'origin', 'steward', 'owner', 'orphaned', 'progress', 'steps'], planAt);
        uuid(rawPlan.id, `${planAt}.id`);
        str(rawPlan.title, `${planAt}.title`);
        if (rawPlan.title.length > ACTIVE_SESSION_PLAN_MAX_TITLE_CHARS)
            throw new Error(`${planAt}.title is too large`);
        if (!Number.isSafeInteger(rawPlan.revision) || rawPlan.revision < 1 || rawPlan.status !== 'active' || !validOffsetDateTime(rawPlan.created_at))
            throw new Error(`${planAt} revision/status/time is invalid`);
        planIdentity(rawPlan.origin, `${planAt}.origin`);
        planIdentity(rawPlan.steward, `${planAt}.steward`);
        exact(rawPlan.owner, ['user_id', 'display_name'], `${planAt}.owner`);
        uuid(rawPlan.owner.user_id, `${planAt}.owner.user_id`);
        str(rawPlan.owner.display_name, `${planAt}.owner.display_name`);
        if (rawPlan.owner.display_name.length > ACTIVE_SESSION_PLAN_MAX_IDENTITY_CHARS)
            throw new Error(`${planAt}.owner.display_name is too large`);
        if (typeof rawPlan.orphaned !== 'boolean')
            throw new Error(`${planAt}.orphaned is invalid`);
        exact(rawPlan.progress, ['terminal', 'total', 'completed', 'skipped'], `${planAt}.progress`);
        for (const key of ['terminal', 'total', 'completed', 'skipped']) {
            if (!Number.isSafeInteger(rawPlan.progress[key]) || rawPlan.progress[key] < 0)
                throw new Error(`${planAt}.progress.${key} is invalid`);
        }
        if (!Array.isArray(rawPlan.steps) || rawPlan.steps.length > ACTIVE_SESSION_PLAN_MAX_STEPS)
            throw new Error(`${planAt}.steps count is invalid`);
        rawPlan.steps.forEach((step, stepIndex) => planStep(step, `${planAt}.steps[${stepIndex}]`));
        const completed = rawPlan.steps.filter((step) => step.status === 'completed').length;
        const skipped = rawPlan.steps.filter((step) => step.status === 'skipped').length;
        if (rawPlan.progress.total !== rawPlan.steps.length || rawPlan.progress.completed !== completed ||
            rawPlan.progress.skipped !== skipped || rawPlan.progress.terminal !== completed + skipped) {
            throw new Error(`${planAt}.progress does not match steps`);
        }
        totalText += rawPlan.title.length + rawPlan.origin.agent_name.length + (rawPlan.origin.codename?.length ?? 0) +
            rawPlan.steward.agent_name.length + (rawPlan.steward.codename?.length ?? 0) + rawPlan.owner.display_name.length +
            rawPlan.steps.reduce((sum, step) => sum + step.title.length + (step.failure_reason?.length ?? 0), 0);
    });
    if (totalText > ACTIVE_SESSION_PLAN_MAX_TOTAL_TEXT_CHARS)
        throw new Error(`${at} text is too large`);
}
function bounded(v, at, policyVersion) {
    exact(v, ['policy_version', 'returned', 'total_known', 'source_window', 'truncated', 'has_more', 'next_cursor', 'fetch_id', 'omission_reason'], at);
    if (v.policy_version !== policyVersion || !Number.isSafeInteger(v.returned) || v.returned < 0)
        throw new Error(`${at} version/count is invalid`);
    if (v.total_known !== null && (!Number.isSafeInteger(v.total_known) || v.total_known < v.returned))
        throw new Error(`${at}.total_known is invalid`);
    exact(v.source_window, ['start', 'end'], `${at}.source_window`);
    if (v.source_window.start !== null)
        order(v.source_window.start, `${at}.source_window.start`);
    if (v.source_window.end !== null)
        order(v.source_window.end, `${at}.source_window.end`);
    if ((v.source_window.start === null) !== (v.source_window.end === null) || (v.source_window.start && v.source_window.end && v.source_window.start.sequence > v.source_window.end.sequence))
        throw new Error(`${at}.source_window is invalid`);
    if (typeof v.truncated !== 'boolean' || typeof v.has_more !== 'boolean')
        throw new Error(`${at} flags are invalid`);
    str(v.next_cursor, `${at}.next_cursor`, true);
    str(v.fetch_id, `${at}.fetch_id`, true);
    if (v.omission_reason !== null)
        oneOf(v.omission_reason, ['policy_limit', 'model_budget', 'transport_budget', 'filter', 'history_before_window', 'delivery_retry'], `${at}.omission_reason`);
    if (v.has_more && !v.next_cursor)
        throw new Error(`${at}.has_more requires next_cursor`);
    if (v.truncated && (!v.fetch_id || !v.omission_reason))
        throw new Error(`${at}.truncated requires omission metadata`);
}
function sameConnection(a, b) { return a.connection_id === b.connection_id && a.agent_name === b.agent_name && a.codename === b.codename && a.label === b.label; }
function strictlyOrdered(rows) { return rows.every((r, i) => i === 0 || rows[i - 1].order.sequence < r.order.sequence); }
/** Parse a changed negotiated poll response. Missing ingress is therefore an error. */
export function parseCanonicalIngress(input, expectedConnectionId) {
    try {
        if (!record(input))
            throw new Error('ingress must be an object');
        const enhanced = input.contract_version === ACTIVE_PLAN_CONTRACT_VERSION && input.policy_version === ACTIVE_PLAN_POLICY_VERSION;
        const scoped = input.contract_version === SCOPED_CONTRACT_VERSION && input.policy_version === SCOPED_POLICY_VERSION;
        if (!enhanced && !scoped)
            throw new Error('ingress contract/policy pair is unsupported');
        const hasActivePlans = Object.prototype.hasOwnProperty.call(input, 'active_session_plans');
        exact(input, [
            'kind', 'schema_version', 'contract_version', 'policy_version', 'envelope_id', 'connection',
            'wake', 'delivery_state', 'command_message_ids', 'commands', 'control', 'context',
            ...(enhanced && hasActivePlans ? ['active_session_plans'] : []),
            'window',
        ], 'ingress');
        if (input.kind !== 'devspec.remote_ingress' || input.schema_version !== 1)
            throw new Error('ingress discriminator is unsupported');
        if (enhanced && hasActivePlans)
            activePlans(input.active_session_plans, 'ingress.active_session_plans');
        uuid(input.envelope_id, 'ingress.envelope_id');
        connection(input.connection, 'ingress.connection');
        if (input.connection.connection_id !== expectedConnectionId)
            throw new Error('ingress connection mismatch');
        exact(input.wake, ['kind', 'active', 'reason_id'], 'ingress.wake');
        oneOf(input.wake.kind, ['conversational_command', 'control', 'advisory_update', 'history_reseed', 'idle'], 'ingress.wake.kind');
        if (typeof input.wake.active !== 'boolean')
            throw new Error('ingress.wake.active is invalid');
        str(input.wake.reason_id, 'ingress.wake.reason_id');
        const activeKind = input.wake.kind === 'conversational_command' || input.wake.kind === 'control';
        if (input.wake.active !== activeKind)
            throw new Error('ingress wake contradiction');
        oneOf(input.delivery_state, ['live', 'replay', 'reseed'], 'ingress.delivery_state');
        if (input.delivery_state !== 'live' && (input.wake.kind !== 'history_reseed' || input.wake.active))
            throw new Error('replay/reseed must be inactive');
        if (input.wake.kind === 'history_reseed' && input.delivery_state === 'live')
            throw new Error('history reseed cannot be live');
        if ((input.wake.kind === 'control') !== (input.control !== null))
            throw new Error('ingress control/wake mismatch');
        if (input.control !== null) {
            exact(input.control, ['id', 'verb', 'issued_at', 'issued_by_user_id', ...(record(input.control) && input.control.args !== undefined ? ['args'] : [])], 'ingress.control');
            uuid(input.control.id, 'ingress.control.id');
            uuid(input.control.issued_by_user_id, 'ingress.control.issued_by_user_id');
            if (!validOffsetDateTime(input.control.issued_at))
                throw new Error('ingress.control.issued_at is invalid');
            oneOf(input.control.verb, ['abort', 'set_model', 'set_thinking', 'compact', 'reload', 'list_models'], 'ingress.control.verb');
            if (input.control.args !== undefined) {
                if (!record(input.control.args))
                    throw new Error('ingress.control.args must be an object');
                const allowed = ['model', 'thinking'];
                if (Object.keys(input.control.args).some((key) => !allowed.includes(key)))
                    throw new Error('ingress.control.args has unknown fields');
                if (input.control.args.model !== undefined)
                    str(input.control.args.model, 'ingress.control.args.model');
                if (input.control.args.thinking !== undefined)
                    oneOf(input.control.args.thinking, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'ingress.control.args.thinking');
            }
            if (input.control.verb === 'set_model' && (!record(input.control.args) || typeof input.control.args.model !== 'string' || !input.control.args.model))
                throw new Error('set_model control requires model');
            if (input.control.verb === 'set_thinking' && (!record(input.control.args) || typeof input.control.args.thinking !== 'string'))
                throw new Error('set_thinking control requires thinking');
        }
        if (!Array.isArray(input.command_message_ids) || !Array.isArray(input.commands))
            throw new Error('ingress commands are invalid');
        input.command_message_ids.forEach((id, i) => uuid(id, `ingress.command_message_ids[${i}]`));
        input.commands.forEach((c, i) => command(c, `ingress.commands[${i}]`));
        const commandIds = input.command_message_ids;
        const commands = input.commands;
        const ingressConnection = input.connection;
        if (new Set(commandIds).size !== commandIds.length || commands.length !== commandIds.length || commands.some((c) => !commandIds.includes(c.message_id) || !sameConnection(c.addressee, ingressConnection)))
            throw new Error('ingress command identities/addressees mismatch');
        if (!strictlyOrdered(commands))
            throw new Error('ingress commands are not ordered');
        exact(input.context, ['human_context', 'agent_context', 'ai_context', 'system_context'], 'ingress.context');
        const entries = [];
        for (const [bucket, kind] of [['human_context', 'human'], ['agent_context', 'agent'], ['ai_context', 'ai'], ['system_context', 'system']]) {
            const list = input.context[bucket];
            if (!Array.isArray(list))
                throw new Error(`ingress.context.${bucket} must be an array`);
            list.forEach((e, i) => contextEntry(e, kind, `ingress.context.${bucket}[${i}]`));
            if (!strictlyOrdered(list))
                throw new Error(`ingress.context.${bucket} is not ordered`);
            entries.push(...list);
        }
        bounded(input.window, 'ingress.window', enhanced ? ACTIVE_PLAN_POLICY_VERSION : SCOPED_POLICY_VERSION);
        const rows = [...input.commands, ...entries];
        if (input.window.returned !== rows.length || new Set(rows.map((r) => r.message_id)).size !== rows.length)
            throw new Error('ingress window count/identity mismatch');
        const start = input.window.source_window.start?.sequence;
        const end = input.window.source_window.end?.sequence;
        if (rows.length > 0 && (start === undefined || end === undefined || start > end || rows.some((row) => row.order.sequence < start || row.order.sequence > end)))
            throw new Error('ingress rows fall outside source window');
        if (input.commands.length) {
            const sharedPrimaryRef = input.commands[0].delivery.primary_provenance_ref;
            const provenanceRefs = input.commands.map((command) => command.delivery.provenance_ref);
            const primaryFlagsMatch = input.commands.every((command) => command.delivery.is_primary === (command.delivery.provenance_ref === sharedPrimaryRef));
            if (new Set(input.commands.map((c) => c.delivery.turn_id)).size !== 1 || new Set(input.commands.map((c) => c.delivery.primary_provenance_ref)).size !== 1 || new Set(provenanceRefs).size !== provenanceRefs.length || !primaryFlagsMatch)
                throw new Error('ingress command turn binding is invalid');
        }
        if (input.wake.kind === 'conversational_command' && input.commands.length === 0)
            throw new Error('command wake has no command');
        const executable = input.delivery_state === 'live' && input.wake.active && input.wake.kind === 'conversational_command';
        return { ok: true, ingress: input, executable };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
const PLAN_STEP_MARK = {
    pending: '[ ]',
    in_progress: '[>]',
    completed: '[x]',
    failed: '[!]',
    skipped: '[-]',
};
function planAgentLabel(identity) {
    return identity.kind === 'dev'
        ? 'Dev'
        : `${identity.agent_name}${identity.codename ? ` · ${identity.codename}` : ''} (${identity.connection_id})`;
}
/**
 * Compact model-tail serialization. The projection is read-awareness, not a
 * command: own-plan lifecycle and same-owner adoption guidance name the exact
 * server ids/revisions, while another owner's plan is explicitly read-only.
 */
export function serializeActiveSessionPlans(projection, recipient) {
    if (!projection)
        return '';
    activePlans(projection, 'active_session_plans');
    const ownPlan = projection.plans.find((plan) => plan.steward.connection_id === recipient.connectionId);
    const lines = [
        '## Active session plans — ADVISORY READ-AWARENESS',
        projection.authority_note,
    ];
    for (const plan of projection.plans) {
        const own = plan.steward.connection_id === recipient.connectionId;
        const sameOwner = Boolean(recipient.ownerUserId && plan.owner.user_id === recipient.ownerUserId);
        const adoptable = !ownPlan && !own && sameOwner && plan.orphaned && plan.steward.kind === 'connection';
        const access = own ? '[OWN]' : adoptable ? '[SAME-OWNER ORPHAN — ADOPTABLE]' : sameOwner ? '[SAME-OWNER ROOM PLAN]' : '[OTHER OWNER — READ-ONLY]';
        lines.push('', `${access} ${JSON.stringify(plan.title)} | plan_id=${plan.id} | revision=${plan.revision} | ` +
            `steward=${planAgentLabel(plan.steward)} | owner=${plan.owner.display_name} (${plan.owner.user_id}) | ` +
            `orphaned=${plan.orphaned} | progress=${plan.progress.terminal}/${plan.progress.total}`);
        for (const step of plan.steps) {
            lines.push(`  ${PLAN_STEP_MARK[step.status]} ${step.position}. ${step.title} | step_id=${step.id} | status=${step.status}` +
                (step.status === 'failed'
                    ? ` | retryable=${step.retryable}${step.failure_reason ? ` | failure=${JSON.stringify(step.failure_reason)}` : ''}`
                    : ''));
        }
        if (own) {
            const allTerminal = plan.progress.total > 0 && plan.progress.terminal === plan.progress.total;
            const current = plan.steps.find((step) => step.status === 'in_progress');
            const next = plan.steps.find((step) => step.status === 'pending');
            lines.push(`  Lifecycle: continue this plan or end it explicitly; complete only if the outcome and steps are achieved, otherwise abandon with a specific reason. Closing the plan does not end the session. Never silently restart/drop it. Every mutation uses plan_id=${plan.id} and expected_revision=${plan.revision}.`, allTerminal
                ? '  End: complete only if the outcome was achieved; otherwise abandon with a specific reason. Closing the plan does not end the session.'
                : current && next
                    ? `  Boundary: use one atomic advance (current_step_id=${current.id}, next_step_id=${next.id}) after the current milestone succeeds.`
                    : current
                        ? `  Continue: resume step_id=${current.id}; complete the plan when its outcome and steps are achieved, otherwise abandon explicitly.`
                        : next
                            ? `  Continue: start step_id=${next.id} before acting.`
                            : '  Reconcile the plan explicitly before further work.');
        }
        else if (adoptable) {
            lines.push(`  Adoption: only on explicit continuation intent, call adopt with plan_id=${plan.id} and expected_revision=${plan.revision}; then use the returned revision.`);
        }
        else if (sameOwner) {
            lines.push(`  Cross-plan targeting must be intentional and explicit: plan_id=${plan.id}, expected_revision=${plan.revision}. Do not adopt a non-orphaned plan.`);
        }
        else {
            lines.push('  Read awareness only: do not mutate or adopt this plan.');
        }
    }
    return lines.join('\n');
}
export function selectCanonicalCommandsForPrompt(parsed, deliveredMessageIds) {
    if (!parsed.ok || !parsed.executable)
        return { commands: [], rejectedUnavailable: [], alreadyDelivered: false };
    const unseen = parsed.ingress.commands.filter((command) => !deliveredMessageIds.has(command.message_id));
    const rejectedUnavailable = unseen.filter((command) => command.attachments.some((attachment) => attachment.materialization === 'unavailable'));
    const alreadyDelivered = unseen.length === 0 && parsed.ingress.commands.length > 0;
    if (rejectedUnavailable.length > 0 || alreadyDelivered) {
        return { commands: [], rejectedUnavailable, alreadyDelivered };
    }
    return { commands: unseen, rejectedUnavailable, alreadyDelivered: false };
}
/**
 * Persist owner commands that arrived while inject must wait (connect handshake
 * still settling, or another host acceptance in flight).
 *
 * Live session 191795fc / item 4414d2d9: poll_connection returned the owner's
 * ping once, the plugin deferred inject (6990fd9e), then a later advisory-only
 * package had no commands[] — so the client cursor advanced and the ping was
 * gone. Holding the wire cursor is not enough once the server has already
 * shown the command. Keep a local queue and drain it when inject is legal.
 */
export function mergeDeferredCanonicalCommands(deferred, incoming) {
    const out = [];
    const seen = new Set();
    for (const command of [...(deferred ?? []), ...(incoming ?? [])]) {
        if (!command?.message_id || seen.has(command.message_id))
            continue;
        seen.add(command.message_id);
        out.push(command);
    }
    return out;
}
export function resolveHandshakeInject(opts) {
    const pending = mergeDeferredCanonicalCommands(opts.deferred, opts.incoming).filter((command) => !opts.deliveredIds.has(command.message_id));
    if ((opts.deferInject || opts.acceptingTurn) && pending.length > 0) {
        return { pending, nextDeferred: pending, injectNow: false };
    }
    return { pending, nextDeferred: pending, injectNow: pending.length > 0 };
}
export function freezeCanonicalTurn(value) {
    const visit = (v) => { if (!v || typeof v !== 'object' || Object.isFrozen(v))
        return; Object.freeze(v); for (const child of Object.values(v))
        visit(child); };
    visit(value);
    return value;
}
