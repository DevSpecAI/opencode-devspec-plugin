/**
 * Check jobs on the wake channel (DevSpec item 55d71b0c; this plugin's item 0793170c).
 *
 * DevSpec sends every check on a change, the agent's own changes included, as a
 * pending check job beside automation runs in `poll_connection`'s `dispatches[]`,
 * but only to a connection whose polls say they read them (`check_job_version`).
 * A check job is inbox metadata only, never record text: which record, which kind
 * of check, how many entries, how many high risk, and whether this agent made the
 * change. The agent takes it with claim_check_job, which returns everything to rule.
 */
/** The check-job wake-channel version this plugin reads. Sent on every poll. */
export declare const CHECK_JOB_VERSION: 1;
/** The server's CHECK_JOB_WAKE_KEYS: exactly these, no more and no fewer. */
export declare const CHECK_JOB_WAKE_KEYS: readonly ["id", "kind", "check_job_id", "check_kind", "record", "entries", "high_risk", "yours", "offered_at", "delivery_connection_id"];
declare const CHECK_JOB_KINDS: readonly ["conflict", "conflict_decisions", "duplicate", "staleness"];
declare const CHECK_JOB_RECORD_TYPES: readonly ["task", "memory", "artifact", "proposal"];
export interface CheckJobWake {
    id: string;
    kind: 'check_job';
    check_job_id: string;
    check_kind: (typeof CHECK_JOB_KINDS)[number];
    record: {
        type: (typeof CHECK_JOB_RECORD_TYPES)[number];
        id: string;
        title: string;
    };
    entries: number;
    high_risk: number;
    yours: boolean;
    offered_at: string;
    delivery_connection_id: string;
}
/**
 * Exactly the server's check-job envelope, addressed to `connectionId`. Any other
 * shape is not a check job: an extra or missing key, here or in its record, makes
 * it inert like every other dispatch this plugin does not know.
 */
export declare function isCheckJobWake(value: unknown, connectionId: string | null | undefined): value is CheckJobWake;
/** The one line that wakes the agent for a check job (the frozen contract's wake text). */
export declare function checkJobWakeText(job: CheckJobWake): string;
/**
 * The prompt a batch of check jobs wakes OpenCode with: one wake line per job and
 * the job's own metadata, so the agent has the check_job_id to claim. It is not a
 * command or an automation run, and it asks for no reply.
 */
export declare function renderCheckJobTurn(jobs: readonly CheckJobWake[]): string;
export {};
