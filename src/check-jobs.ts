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
export const CHECK_JOB_VERSION = 1 as const

/** The server's CHECK_JOB_WAKE_KEYS: exactly these, no more and no fewer. */
export const CHECK_JOB_WAKE_KEYS = [
  'id', 'kind', 'check_job_id', 'check_kind', 'record', 'entries', 'high_risk', 'yours', 'offered_at', 'delivery_connection_id',
] as const
const CHECK_JOB_KINDS = ['conflict', 'conflict_decisions', 'duplicate', 'staleness'] as const
const CHECK_JOB_RECORD_TYPES = ['task', 'memory', 'artifact', 'proposal'] as const
const RECORD_KEYS = ['type', 'id', 'title'] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OFFSET_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

export interface CheckJobWake {
  id: string
  kind: 'check_job'
  check_job_id: string
  check_kind: (typeof CHECK_JOB_KINDS)[number]
  record: { type: (typeof CHECK_JOB_RECORD_TYPES)[number]; id: string; title: string }
  entries: number
  high_risk: number
  yours: boolean
  offered_at: string
  delivery_connection_id: string
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value)
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Exactly the server's check-job envelope, addressed to `connectionId`. Any other
 * shape is not a check job: an extra or missing key, here or in its record, makes
 * it inert like every other dispatch this plugin does not know.
 */
export function isCheckJobWake(value: unknown, connectionId: string | null | undefined): value is CheckJobWake {
  if (!plainObject(value) || !exactKeys(value, CHECK_JOB_WAKE_KEYS)) return false
  const record = value.record
  if (!plainObject(record) || !exactKeys(record, RECORD_KEYS)) return false
  return value.kind === 'check_job' &&
    typeof value.id === 'string' && UUID.test(value.id) && value.check_job_id === value.id &&
    (CHECK_JOB_KINDS as readonly unknown[]).includes(value.check_kind) &&
    (CHECK_JOB_RECORD_TYPES as readonly unknown[]).includes(record.type) &&
    typeof record.id === 'string' && UUID.test(record.id) &&
    // A record whose title is unset arrives with an empty one; the wake names it by type and id.
    typeof record.title === 'string' &&
    count(value.entries) && count(value.high_risk) && value.high_risk <= value.entries &&
    typeof value.yours === 'boolean' &&
    typeof value.offered_at === 'string' && OFFSET_DATETIME.test(value.offered_at) &&
    typeof connectionId === 'string' && connectionId.length > 0 && value.delivery_connection_id === connectionId
}

function subject(job: CheckJobWake): string {
  const title = job.record.title.trim()
  return title ? `"${title}"` : `${job.record.type} ${job.record.id}`
}

/** The one line that wakes the agent for a check job (the frozen contract's wake text). */
export function checkJobWakeText(job: CheckJobWake): string {
  return `A check is waiting on ${subject(job)}: take it with claim_check_job, rule every entry with record_check_rulings, then carry on.`
}

/**
 * The prompt a batch of check jobs wakes OpenCode with: one wake line per job and
 * the job's own metadata, so the agent has the check_job_id to claim. It is not a
 * command or an automation run, and it asks for no reply.
 */
export function renderCheckJobTurn(jobs: readonly CheckJobWake[]): string {
  const heading = (jobs.length > 1
    ? `## DevSpec check jobs (${jobs.length}) — checks DevSpec asks you to rule, not commands or automation runs`
    : '## DevSpec check job — a check DevSpec asks you to rule, not a command or an automation run') +
    '\nThis turn needs no answer post of its own.'
  const blocks = jobs.map((job) => [
    checkJobWakeText(job),
    `check_job_id=${job.check_job_id} check_kind=${job.check_kind} record=${job.record.type}:${job.record.id} ` +
      `entries=${job.entries} high_risk=${job.high_risk} yours=${job.yours}`,
  ].join('\n'))
  return [heading, ...blocks].join('\n\n')
}
