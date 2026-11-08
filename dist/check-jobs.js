/**
 * Check jobs on the wake channel (DevSpec item 55d71b0c; this plugin's item 0793170c).
 *
 * DevSpec sends every check on a change, the agent's own changes included, as a
 * pending check job beside automation runs in `poll_connection`'s `dispatches[]`,
 * but only to a connection whose polls say they read them (`check_job_version`).
 * A check job is inbox metadata only, never record text: which record, which kind
 * of check, how many entries, and whether this agent made the change. The agent
 * takes it with claim_check_job, which returns everything to rule.
 *
 * Version 2 (DevSpec item 1d89fe56) is the envelope `check_job.envelope` and
 * `check_job.records` in devspec://product/remote-ingress-contract describe: no
 * `high_risk`, and three more records, each an out-of-date (`staleness`) check. This
 * plugin negotiates 2 only, so the server never sends it the version-1 envelope.
 */
/** The check-job wake-channel version this plugin reads. Sent on every poll. */
export const CHECK_JOB_VERSION = 2;
/** The server's version-2 CHECK_JOB_WAKE_KEYS: exactly these, no more and no fewer. */
export const CHECK_JOB_WAKE_KEYS = [
    'id', 'kind', 'check_job_id', 'check_kind', 'record', 'entries', 'yours', 'offered_at', 'delivery_connection_id',
];
const CHECK_JOB_KINDS = ['conflict', 'conflict_decisions', 'duplicate', 'staleness'];
/**
 * The records a version-2 job may name. The last three are the ones version 2 adds:
 * a settled discussion point or a Goal whose open-task out-of-date check this is,
 * and the manual whole-backlog out-of-date scan's own record. Each is only ever a
 * `staleness` check.
 */
export const CHECK_JOB_RECORD_TYPES = [
    'task', 'memory', 'artifact', 'proposal', 'discussion_point', 'goal', 'backlog_scan',
];
const STALENESS_ONLY_RECORD_TYPES = ['discussion_point', 'goal', 'backlog_scan'];
const RECORD_KEYS = ['type', 'id', 'title'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFSET_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value, keys) {
    const own = Object.keys(value);
    return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function count(value) {
    return Number.isSafeInteger(value) && value >= 0;
}
/**
 * Exactly the server's version-2 check-job envelope, addressed to `connectionId`. Any
 * other shape is not a check job: an extra or missing key, here or in its record (a
 * version-1 `high_risk` included), makes it inert like every other dispatch this
 * plugin does not know.
 */
export function isCheckJobWake(value, connectionId) {
    if (!plainObject(value) || !exactKeys(value, CHECK_JOB_WAKE_KEYS))
        return false;
    const record = value.record;
    if (!plainObject(record) || !exactKeys(record, RECORD_KEYS))
        return false;
    return value.kind === 'check_job' &&
        typeof value.id === 'string' && UUID.test(value.id) && value.check_job_id === value.id &&
        CHECK_JOB_KINDS.includes(value.check_kind) &&
        CHECK_JOB_RECORD_TYPES.includes(record.type) &&
        // The records version 2 adds are only ever out-of-date checks.
        (!STALENESS_ONLY_RECORD_TYPES.includes(record.type) || value.check_kind === 'staleness') &&
        typeof record.id === 'string' && UUID.test(record.id) &&
        // A record whose title is unset arrives with an empty one; the wake names it by type and id.
        typeof record.title === 'string' &&
        count(value.entries) &&
        typeof value.yours === 'boolean' &&
        typeof value.offered_at === 'string' && OFFSET_DATETIME.test(value.offered_at) &&
        typeof connectionId === 'string' && connectionId.length > 0 && value.delivery_connection_id === connectionId;
}
function subject(job) {
    const title = job.record.title.trim();
    return title ? `"${title}"` : `${job.record.type} ${job.record.id}`;
}
/**
 * What the check is on, in words. The records version 2 adds say what they are,
 * because a title alone does not tell a settled discussion point from a Goal, and
 * the manual scan is a scan of the whole backlog, not of one record.
 */
function target(job) {
    const title = job.record.title.trim();
    const named = title ? ` "${title}"` : '';
    switch (job.record.type) {
        case 'discussion_point':
            return `An out-of-date check on the settled discussion point${named || ` ${job.record.id}`} is waiting`;
        case 'goal':
            return `An out-of-date check on the Goal${named || ` ${job.record.id}`} is waiting`;
        case 'backlog_scan':
            return `The whole-backlog out-of-date scan${named} is waiting`;
        default:
            return `A check is waiting on ${subject(job)}`;
    }
}
/** The one line that wakes the agent for a check job (the frozen contract's wake text). */
export function checkJobWakeText(job) {
    return `${target(job)}: take it with claim_check_job, rule every entry with record_check_rulings, then carry on.`;
}
/**
 * The prompt a batch of check jobs wakes OpenCode with: one wake line per job and
 * the job's own metadata, so the agent has the check_job_id to claim. It is not a
 * command or an automation run, and it asks for no reply: ruling a check job is
 * never posted about in the room (`check_job.room`, DevSpec item a868f41f).
 */
export function renderCheckJobTurn(jobs) {
    const heading = (jobs.length > 1
        ? `## DevSpec check jobs (${jobs.length}) — checks DevSpec asks you to rule, not commands or automation runs`
        : '## DevSpec check job — a check DevSpec asks you to rule, not a command or an automation run') +
        '\nThis turn needs no answer post of its own. Never post in the room about ruling a check job ' +
        '(check_job.room in devspec://product/remote-ingress-contract).';
    const blocks = jobs.map((job) => [
        checkJobWakeText(job),
        `check_job_id=${job.check_job_id} check_kind=${job.check_kind} record=${job.record.type}:${job.record.id} ` +
            `entries=${job.entries} yours=${job.yours}`,
    ].join('\n'));
    return [heading, ...blocks].join('\n\n');
}
