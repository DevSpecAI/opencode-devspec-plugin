/**
 * Strict local consumer for the negotiated remote-ingress wire contract.
 * Operational policy and the authoritative schema live at
 * devspec://product/remote-ingress-contract.
 */

export const REMOTE_INGRESS_VERSION = 1 as const
export const DELEGATED_SCOPE_VERSION = 1 as const
export const DELEGATED_PROJECT_POLICY_ID = 'delegated_project_v1' as const
const CONTRACT_VERSION = '1.2.0'
const POLICY_VERSION = '2026-08-19.3'
const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)$/i
const OFFSET_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/

function validOffsetDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = OFFSET_DATETIME.exec(value)
  if (!match) return false
  const [, year, month, day, hour, minute, second, zone, , offsetHour, offsetMinute] = match
  const parts = [year, month, day, hour, minute, second].map(Number)
  const [y, mo, d, h, mi, s] = parts
  if (h! > 23 || mi! > 59 || s! > 59 || (zone !== 'Z' && (Number(offsetHour) > 23 || Number(offsetMinute) > 59))) return false
  const calendar = new Date(Date.UTC(y!, mo! - 1, d!))
  return calendar.getUTCFullYear() === y && calendar.getUTCMonth() === mo! - 1 && calendar.getUTCDate() === d && !Number.isNaN(Date.parse(value))
}

export interface CanonicalAttachment {
  materialization: 'metadata' | 'unavailable'
  filename: string
  mime_type: string
  type: string
  size_bytes: number | null
  resource_id: string | null
  reason?: 'missing_resource' | 'legacy_inline_payload' | 'access_denied'
}
export interface CanonicalOrder { sequence: number; created_at: string; message_id: string }
export interface CanonicalProjectScope {
  kind: 'devspec_project'
  policy_id: typeof DELEGATED_PROJECT_POLICY_ID
  project_id: string
  instruction: string
}
export interface CanonicalCommand {
  message_id: string
  order: CanonicalOrder
  content: { mode: 'full'; body: string; complete: true }
  attachments: CanonicalAttachment[]
  requester: { user_id: string; display_name: string | null }
  authority: { kind: 'owner' | 'delegated'; mode: 'owner' | 'project' | 'allowlist'; requested_by_user_id: string; connection_owner_user_id: string; decision_source: 'server' }
  project_scope: CanonicalProjectScope | null
  addressee: CanonicalConnection
  delivery: { provenance_ref: string; turn_id: string; primary_provenance_ref: string; is_primary: boolean }
}
export interface CanonicalConnection { connection_id: string; agent_name: string | null; codename: string | null; label: string }
export interface CanonicalContextEntry {
  message_id: string
  order: CanonicalOrder
  actor: { kind: 'human' | 'agent' | 'ai' | 'system'; user_id: string | null; display_name: string; agent_tool: string | null; model: string | null }
  source_type: string
  relationship: 'before_window' | 'within_window' | 'after_command'
  content: string
  advisory: true
}
export interface CanonicalWindow {
  policy_version: string
  returned: number
  total_known: number | null
  source_window: { start: CanonicalOrder | null; end: CanonicalOrder | null }
  truncated: boolean
  has_more: boolean
  next_cursor: string | null
  fetch_id: string | null
  omission_reason: string | null
}
export interface CanonicalControl {
  id: string
  verb: 'abort' | 'set_model' | 'set_thinking' | 'compact' | 'reload' | 'list_models'
  issued_at: string
  issued_by_user_id: string
  args?: { model?: string; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
}
export interface CanonicalIngress {
  kind: 'devspec.remote_ingress'
  schema_version: 1
  contract_version: string
  policy_version: string
  envelope_id: string
  connection: CanonicalConnection
  wake: { kind: 'conversational_command' | 'control' | 'advisory_update' | 'history_reseed' | 'idle'; active: boolean; reason_id: string }
  delivery_state: 'live' | 'replay' | 'reseed'
  command_message_ids: string[]
  commands: CanonicalCommand[]
  control: CanonicalControl | null
  context: { human_context: CanonicalContextEntry[]; agent_context: CanonicalContextEntry[]; ai_context: CanonicalContextEntry[]; system_context: CanonicalContextEntry[] }
  window: CanonicalWindow
}
export type CanonicalIngressResult = { ok: true; ingress: CanonicalIngress; executable: boolean } | { ok: false; error: string }

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function exact(v: unknown, keys: string[], at: string): asserts v is Record<string, unknown> {
  if (!record(v)) throw new Error(`${at} must be an object`)
  const actual = Object.keys(v).sort()
  const wanted = [...keys].sort()
  if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i])) throw new Error(`${at} has missing or unknown fields`)
}
function str(v: unknown, at: string, nullable = false): asserts v is string | null {
  if (nullable && v === null) return
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${at} must be a non-empty string`)
}
function uuid(v: unknown, at: string, nullable = false): asserts v is string | null {
  if (nullable && v === null) return
  if (typeof v !== 'string' || !UUID.test(v)) throw new Error(`${at} must be a UUID`)
}
function oneOf<T extends string>(v: unknown, values: readonly T[], at: string): asserts v is T {
  if (typeof v !== 'string' || !values.includes(v as T)) throw new Error(`${at} is unknown`)
}
function projectScope(v: unknown, at: string): asserts v is CanonicalProjectScope {
  exact(v, ['kind', 'policy_id', 'project_id', 'instruction'], at)
  if (v.kind !== 'devspec_project') throw new Error(`${at}.kind is unknown`)
  if (v.policy_id !== DELEGATED_PROJECT_POLICY_ID) throw new Error(`${at}.policy_id is unknown`)
  uuid(v.project_id, `${at}.project_id`)
  if (typeof v.instruction !== 'string' || v.instruction.trim().length === 0) throw new Error(`${at}.instruction must be non-empty server text`)
}
export function isCanonicalProjectScope(v: unknown): v is CanonicalProjectScope {
  try { projectScope(v, 'project_scope'); return true } catch { return false }
}
function order(v: unknown, at: string): asserts v is CanonicalOrder {
  exact(v, ['sequence', 'created_at', 'message_id'], at)
  if (!Number.isSafeInteger(v.sequence) || (v.sequence as number) <= 0) throw new Error(`${at}.sequence is invalid`)
  if (!validOffsetDateTime(v.created_at)) throw new Error(`${at}.created_at is invalid`)
  uuid(v.message_id, `${at}.message_id`)
}
function connection(v: unknown, at: string): asserts v is CanonicalConnection {
  exact(v, ['connection_id', 'agent_name', 'codename', 'label'], at)
  uuid(v.connection_id, `${at}.connection_id`); str(v.agent_name, `${at}.agent_name`, true); str(v.codename, `${at}.codename`, true); str(v.label, `${at}.label`)
}
function attachment(v: unknown, at: string): asserts v is CanonicalAttachment {
  if (!record(v)) throw new Error(`${at} must be an object`)
  if (v.materialization === 'metadata') {
    exact(v, ['materialization', 'filename', 'mime_type', 'type', 'size_bytes', 'resource_id'], at)
    uuid(v.resource_id, `${at}.resource_id`)
  } else if (v.materialization === 'unavailable') {
    exact(v, ['materialization', 'filename', 'mime_type', 'type', 'size_bytes', 'resource_id', 'reason'], at)
    if (v.resource_id !== null) throw new Error(`${at}.resource_id must be null`)
    oneOf(v.reason, ['missing_resource', 'legacy_inline_payload', 'access_denied'], `${at}.reason`)
  } else throw new Error(`${at}.materialization is unknown`)
  str(v.filename, `${at}.filename`); str(v.mime_type, `${at}.mime_type`); str(v.type, `${at}.type`)
  if (v.size_bytes !== null && (!Number.isSafeInteger(v.size_bytes) || (v.size_bytes as number) < 0)) throw new Error(`${at}.size_bytes is invalid`)
}
function command(v: unknown, at: string): asserts v is CanonicalCommand {
  exact(v, ['message_id', 'order', 'content', 'attachments', 'requester', 'authority', 'project_scope', 'addressee', 'delivery'], at)
  uuid(v.message_id, `${at}.message_id`); order(v.order, `${at}.order`)
  if (v.message_id !== v.order.message_id) throw new Error(`${at} identity mismatch`)
  exact(v.content, ['mode', 'body', 'complete'], `${at}.content`)
  if (v.content.mode !== 'full' || v.content.complete !== true || typeof v.content.body !== 'string') throw new Error(`${at}.content must be complete full content`)
  if (!Array.isArray(v.attachments)) throw new Error(`${at}.attachments must be an array`); v.attachments.forEach((a, i) => attachment(a, `${at}.attachments[${i}]`))
  exact(v.requester, ['user_id', 'display_name'], `${at}.requester`); uuid(v.requester.user_id, `${at}.requester.user_id`); str(v.requester.display_name, `${at}.requester.display_name`, true)
  exact(v.authority, ['kind', 'mode', 'requested_by_user_id', 'connection_owner_user_id', 'decision_source'], `${at}.authority`)
  oneOf(v.authority.kind, ['owner', 'delegated'], `${at}.authority.kind`); oneOf(v.authority.mode, ['owner', 'project', 'allowlist'], `${at}.authority.mode`)
  uuid(v.authority.requested_by_user_id, `${at}.authority.requested_by_user_id`); uuid(v.authority.connection_owner_user_id, `${at}.authority.connection_owner_user_id`)
  if (v.authority.decision_source !== 'server' || v.requester.user_id !== v.authority.requested_by_user_id) throw new Error(`${at}.authority is inconsistent`)
  const owner = v.authority.requested_by_user_id === v.authority.connection_owner_user_id
  if ((v.authority.kind === 'owner') !== owner || (v.authority.mode === 'owner' && v.authority.kind !== 'owner')) throw new Error(`${at}.authority contradicts requester`)
  if (v.authority.kind === 'owner') {
    if (v.project_scope !== null) throw new Error(`${at}.project_scope must be null for owner authority`)
  } else {
    projectScope(v.project_scope, `${at}.project_scope`)
  }
  connection(v.addressee, `${at}.addressee`)
  exact(v.delivery, ['provenance_ref', 'turn_id', 'primary_provenance_ref', 'is_primary'], `${at}.delivery`)
  uuid(v.delivery.provenance_ref, `${at}.delivery.provenance_ref`); uuid(v.delivery.turn_id, `${at}.delivery.turn_id`); uuid(v.delivery.primary_provenance_ref, `${at}.delivery.primary_provenance_ref`)
  if (typeof v.delivery.is_primary !== 'boolean') throw new Error(`${at}.delivery.is_primary is invalid`)
}
function contextEntry(v: unknown, kind: string, at: string): asserts v is CanonicalContextEntry {
  exact(v, ['message_id', 'order', 'actor', 'source_type', 'relationship', 'content', 'advisory'], at)
  uuid(v.message_id, `${at}.message_id`); order(v.order, `${at}.order`); if (v.message_id !== v.order.message_id) throw new Error(`${at} identity mismatch`)
  exact(v.actor, ['kind', 'user_id', 'display_name', 'agent_tool', 'model'], `${at}.actor`)
  oneOf(v.actor.kind, ['human', 'agent', 'ai', 'system'], `${at}.actor.kind`); if (v.actor.kind !== kind) throw new Error(`${at}.actor kind mismatch`)
  uuid(v.actor.user_id, `${at}.actor.user_id`, true); str(v.actor.display_name, `${at}.actor.display_name`); str(v.actor.agent_tool, `${at}.actor.agent_tool`, true); str(v.actor.model, `${at}.actor.model`, true)
  str(v.source_type, `${at}.source_type`); oneOf(v.relationship, ['before_window', 'within_window', 'after_command'], `${at}.relationship`)
  if (typeof v.content !== 'string' || v.advisory !== true) throw new Error(`${at} must be advisory content`)
}
function bounded(v: unknown, at: string): asserts v is CanonicalWindow {
  exact(v, ['policy_version', 'returned', 'total_known', 'source_window', 'truncated', 'has_more', 'next_cursor', 'fetch_id', 'omission_reason'], at)
  if (v.policy_version !== POLICY_VERSION || !Number.isSafeInteger(v.returned) || (v.returned as number) < 0) throw new Error(`${at} version/count is invalid`)
  if (v.total_known !== null && (!Number.isSafeInteger(v.total_known) || (v.total_known as number) < (v.returned as number))) throw new Error(`${at}.total_known is invalid`)
  exact(v.source_window, ['start', 'end'], `${at}.source_window`); if (v.source_window.start !== null) order(v.source_window.start, `${at}.source_window.start`); if (v.source_window.end !== null) order(v.source_window.end, `${at}.source_window.end`)
  if ((v.source_window.start === null) !== (v.source_window.end === null) || (v.source_window.start && v.source_window.end && v.source_window.start.sequence > v.source_window.end.sequence)) throw new Error(`${at}.source_window is invalid`)
  if (typeof v.truncated !== 'boolean' || typeof v.has_more !== 'boolean') throw new Error(`${at} flags are invalid`)
  str(v.next_cursor, `${at}.next_cursor`, true); str(v.fetch_id, `${at}.fetch_id`, true)
  if (v.omission_reason !== null) oneOf(v.omission_reason, ['policy_limit', 'model_budget', 'transport_budget', 'filter', 'history_before_window', 'delivery_retry'], `${at}.omission_reason`)
  if (v.has_more && !v.next_cursor) throw new Error(`${at}.has_more requires next_cursor`)
  if (v.truncated && (!v.fetch_id || !v.omission_reason)) throw new Error(`${at}.truncated requires omission metadata`)
}
function sameConnection(a: CanonicalConnection, b: CanonicalConnection) { return a.connection_id === b.connection_id && a.agent_name === b.agent_name && a.codename === b.codename && a.label === b.label }
function strictlyOrdered(rows: Array<{ order: CanonicalOrder }>) { return rows.every((r, i) => i === 0 || rows[i - 1]!.order.sequence < r.order.sequence) }

/** Parse a changed negotiated poll response. Missing ingress is therefore an error. */
export function parseCanonicalIngress(input: unknown, expectedConnectionId: string): CanonicalIngressResult {
  try {
    exact(input, ['kind', 'schema_version', 'contract_version', 'policy_version', 'envelope_id', 'connection', 'wake', 'delivery_state', 'command_message_ids', 'commands', 'control', 'context', 'window'], 'ingress')
    if (input.kind !== 'devspec.remote_ingress' || input.schema_version !== 1 || input.contract_version !== CONTRACT_VERSION || input.policy_version !== POLICY_VERSION) throw new Error('ingress contract/policy pair is unsupported')
    uuid(input.envelope_id, 'ingress.envelope_id'); connection(input.connection, 'ingress.connection')
    if (input.connection.connection_id !== expectedConnectionId) throw new Error('ingress connection mismatch')
    exact(input.wake, ['kind', 'active', 'reason_id'], 'ingress.wake'); oneOf(input.wake.kind, ['conversational_command', 'control', 'advisory_update', 'history_reseed', 'idle'], 'ingress.wake.kind')
    if (typeof input.wake.active !== 'boolean') throw new Error('ingress.wake.active is invalid'); str(input.wake.reason_id, 'ingress.wake.reason_id')
    const activeKind = input.wake.kind === 'conversational_command' || input.wake.kind === 'control'; if (input.wake.active !== activeKind) throw new Error('ingress wake contradiction')
    oneOf(input.delivery_state, ['live', 'replay', 'reseed'], 'ingress.delivery_state')
    if (input.delivery_state !== 'live' && (input.wake.kind !== 'history_reseed' || input.wake.active)) throw new Error('replay/reseed must be inactive')
    if (input.wake.kind === 'history_reseed' && input.delivery_state === 'live') throw new Error('history reseed cannot be live')
    if ((input.wake.kind === 'control') !== (input.control !== null)) throw new Error('ingress control/wake mismatch')
    if (input.control !== null) {
      exact(input.control, ['id', 'verb', 'issued_at', 'issued_by_user_id', ...(record(input.control) && input.control.args !== undefined ? ['args'] : [])], 'ingress.control')
      uuid(input.control.id, 'ingress.control.id'); uuid(input.control.issued_by_user_id, 'ingress.control.issued_by_user_id')
      if (!validOffsetDateTime(input.control.issued_at)) throw new Error('ingress.control.issued_at is invalid')
      oneOf(input.control.verb, ['abort', 'set_model', 'set_thinking', 'compact', 'reload', 'list_models'], 'ingress.control.verb')
      if (input.control.args !== undefined) {
        if (!record(input.control.args)) throw new Error('ingress.control.args must be an object')
        const allowed = ['model', 'thinking']; if (Object.keys(input.control.args).some((key) => !allowed.includes(key))) throw new Error('ingress.control.args has unknown fields')
        if (input.control.args.model !== undefined) str(input.control.args.model, 'ingress.control.args.model')
        if (input.control.args.thinking !== undefined) oneOf(input.control.args.thinking, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'ingress.control.args.thinking')
      }
      if (input.control.verb === 'set_model' && (!record(input.control.args) || typeof input.control.args.model !== 'string' || !input.control.args.model)) throw new Error('set_model control requires model')
      if (input.control.verb === 'set_thinking' && (!record(input.control.args) || typeof input.control.args.thinking !== 'string')) throw new Error('set_thinking control requires thinking')
    }
    if (!Array.isArray(input.command_message_ids) || !Array.isArray(input.commands)) throw new Error('ingress commands are invalid')
    input.command_message_ids.forEach((id, i) => uuid(id, `ingress.command_message_ids[${i}]`)); input.commands.forEach((c, i) => command(c, `ingress.commands[${i}]`))
    const commandIds = input.command_message_ids as string[]
    const commands = input.commands as CanonicalCommand[]
    const ingressConnection = input.connection as CanonicalConnection
    if (new Set(commandIds).size !== commandIds.length || commands.length !== commandIds.length || commands.some((c) => !commandIds.includes(c.message_id) || !sameConnection(c.addressee, ingressConnection))) throw new Error('ingress command identities/addressees mismatch')
    if (!strictlyOrdered(commands)) throw new Error('ingress commands are not ordered')
    exact(input.context, ['human_context', 'agent_context', 'ai_context', 'system_context'], 'ingress.context')
    const entries: CanonicalContextEntry[] = []
    for (const [bucket, kind] of [['human_context', 'human'], ['agent_context', 'agent'], ['ai_context', 'ai'], ['system_context', 'system']] as const) {
      const list = input.context[bucket]; if (!Array.isArray(list)) throw new Error(`ingress.context.${bucket} must be an array`)
      list.forEach((e, i) => contextEntry(e, kind, `ingress.context.${bucket}[${i}]`)); if (!strictlyOrdered(list)) throw new Error(`ingress.context.${bucket} is not ordered`); entries.push(...list)
    }
    bounded(input.window, 'ingress.window')
    const rows = [...input.commands, ...entries]; if (input.window.returned !== rows.length || new Set(rows.map((r) => r.message_id)).size !== rows.length) throw new Error('ingress window count/identity mismatch')
    const start = input.window.source_window.start?.sequence; const end = input.window.source_window.end?.sequence
    if (rows.length > 0 && (start === undefined || end === undefined || start > end || rows.some((row) => row.order.sequence < start || row.order.sequence > end))) throw new Error('ingress rows fall outside source window')
    if (input.commands.length) {
      const sharedPrimaryRef = input.commands[0]!.delivery.primary_provenance_ref
      const provenanceRefs = input.commands.map((command) => command.delivery.provenance_ref)
      const primaryFlagsMatch = input.commands.every((command) =>
        command.delivery.is_primary === (command.delivery.provenance_ref === sharedPrimaryRef)
      )
      if (new Set(input.commands.map((c) => c.delivery.turn_id)).size !== 1 || new Set(input.commands.map((c) => c.delivery.primary_provenance_ref)).size !== 1 || new Set(provenanceRefs).size !== provenanceRefs.length || !primaryFlagsMatch) throw new Error('ingress command turn binding is invalid')
    }
    if (input.wake.kind === 'conversational_command' && input.commands.length === 0) throw new Error('command wake has no command')
    const executable = input.delivery_state === 'live' && input.wake.active && input.wake.kind === 'conversational_command'
    return { ok: true, ingress: input as unknown as CanonicalIngress, executable }
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
}

export function selectCanonicalCommandsForPrompt(
  parsed: CanonicalIngressResult,
  deliveredMessageIds: ReadonlySet<string>,
): { commands: CanonicalCommand[]; rejectedUnavailable: CanonicalCommand[]; alreadyDelivered: boolean } {
  if (!parsed.ok || !parsed.executable) return { commands: [], rejectedUnavailable: [], alreadyDelivered: false }
  const unseen = parsed.ingress.commands.filter((command) =>
    !deliveredMessageIds.has(command.message_id),
  )
  const rejectedUnavailable = unseen.filter((command) =>
    command.attachments.some((attachment) => attachment.materialization === 'unavailable'),
  )
  const alreadyDelivered = unseen.length === 0 && parsed.ingress.commands.length > 0
  if (rejectedUnavailable.length > 0 || alreadyDelivered) {
    return { commands: [], rejectedUnavailable, alreadyDelivered }
  }
  return { commands: unseen, rejectedUnavailable, alreadyDelivered: false }
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
export function mergeDeferredCanonicalCommands(
  deferred: CanonicalCommand[] | null | undefined,
  incoming: CanonicalCommand[] | null | undefined,
): CanonicalCommand[] {
  const out: CanonicalCommand[] = []
  const seen = new Set<string>()
  for (const command of [...(deferred ?? []), ...(incoming ?? [])]) {
    if (!command?.message_id || seen.has(command.message_id)) continue
    seen.add(command.message_id)
    out.push(command)
  }
  return out
}

export function resolveHandshakeInject(opts: {
  deferInject: boolean
  acceptingTurn: boolean
  deferred: CanonicalCommand[] | null | undefined
  incoming: CanonicalCommand[] | null | undefined
  deliveredIds: ReadonlySet<string>
}): { pending: CanonicalCommand[]; nextDeferred: CanonicalCommand[]; injectNow: boolean } {
  const pending = mergeDeferredCanonicalCommands(opts.deferred, opts.incoming).filter(
    (command) => !opts.deliveredIds.has(command.message_id),
  )
  if ((opts.deferInject || opts.acceptingTurn) && pending.length > 0) {
    return { pending, nextDeferred: pending, injectNow: false }
  }
  return { pending, nextDeferred: pending, injectNow: pending.length > 0 }
}

export function freezeCanonicalTurn<T>(value: T): T {
  const visit = (v: unknown): void => { if (!v || typeof v !== 'object' || Object.isFrozen(v)) return; Object.freeze(v); for (const child of Object.values(v as Record<string, unknown>)) visit(child) }
  visit(value); return value
}
