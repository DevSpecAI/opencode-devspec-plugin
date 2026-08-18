type JsonRecord = Record<string, unknown>

const CLAIM_TOOL = 'claim_work_item'
const CLEAR_TOOLS = new Set([
  'record_implementation',
  'release_work_item',
  'fail_work_item',
])

const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'find',
  'ls',
  'list',
  'tree',
  'webfetch',
  'web_fetch',
])

const DEVSPEC_PRECLAIM_TOOLS = new Set([
  CLAIM_TOOL,
  'create_action_item',
  'search_index',
  'get_action_items',
  'get_action_item',
  'get_project_summary',
  'search_memories',
  'get_memory',
  'get_conventions',
  'get_decisions',
  'get_workflow_rules',
  'reserve_work_items',
  // `/devspec.remote` must be able to establish a fresh connection before a
  // work item exists to claim. Keep this to the command's exact handshake and
  // orientation verbs; mutation-capable DevSpec tools remain fail-closed.
  'register_connection',
  'attach_connection',
  'get_session_transcript',
])

const MUTATION_ALIASES = new Set([
  'edit',
  'multi_edit',
  'multiedit',
  'str_replace_editor',
  'write',
  'write_file',
  'save',
  'save_file',
  'apply_patch',
  'patch',
  'delete',
  'delete_file',
  'remove',
  'remove_file',
  'rm',
  'move',
  'move_file',
  'mv',
  'rename',
  'bash',
  'shell',
  'shell_execute',
  'sh',
  'zsh',
  'fish',
  'powershell',
  'power_shell',
  'pwsh',
  'terminal',
  'terminal_execute',
  'exec',
  'execute',
  'run',
  'run_command',
  'command',
])

const CLAIMED_STATUSES = new Set(['claimed', 'implementing', 'in_progress'])
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PreclaimToolClass = 'read_only' | 'devspec_tracking' | 'mutation' | 'unknown'

/**
 * Match only the MCP names OpenCode can legitimately assign to the DevSpec
 * server. A random namespace that merely ends in the verb is not DevSpec.
 */
function isDevSpecTool(tool: string, verb: string): boolean {
  const name = tool.toLowerCase()
  return (
    name === verb ||
    name === `devspec_${verb}` ||
    name === `devspec.${verb}` ||
    name === `devspec/${verb}` ||
    name === `devspec__${verb}` ||
    name === `mcp__devspec__${verb}` ||
    name === `mcp.devspec.${verb}` ||
    name === `mcp/devspec/${verb}`
  )
}

function devSpecToolKind(tool: string): string | null {
  if (isDevSpecTool(tool, CLAIM_TOOL)) return CLAIM_TOOL
  for (const name of CLEAR_TOOLS) {
    if (isDevSpecTool(tool, name)) return name
  }
  return null
}

function normalizeMutationAlias(tool: string): string {
  const normalized = tool
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/-/g, '_')
  // These are recognized host namespaces, not a general suffix rule.
  for (const prefix of ['functions.', 'functions/', 'functions__', 'tools.', 'tools/', 'tools__']) {
    if (normalized.startsWith(prefix)) return normalized.slice(prefix.length)
  }
  return normalized
}

/** Classification is diagnostic; unknown tools are blocked just like mutations. */
export function classifyPreclaimTool(tool: string): PreclaimToolClass {
  const name = tool.toLowerCase()
  if (READ_ONLY_TOOLS.has(name)) return 'read_only'
  for (const verb of DEVSPEC_PRECLAIM_TOOLS) {
    if (isDevSpecTool(name, verb)) return 'devspec_tracking'
  }
  if (MUTATION_ALIASES.has(normalizeMutationAlias(tool))) return 'mutation'
  return 'unknown'
}

/** Exact alias detection avoids lexical false positives such as credit/nutshell. */
export function isMutationTool(tool: string): boolean {
  return classifyPreclaimTool(tool) === 'mutation'
}

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function parseJsonObject(value: unknown): JsonRecord | null {
  if (typeof value !== 'string') return asRecord(value)
  try {
    return asRecord(JSON.parse(value))
  } catch {
    return null
  }
}

/** Accept JSON objects only from OpenCode's observed structured result channels. */
function structuredResult(hookOutput: unknown): JsonRecord | null {
  const envelope = asRecord(hookOutput)
  if (!envelope || envelope.isError === true) return null

  const structured = parseJsonObject(envelope.structuredContent)
  if (structured) return structured

  const declared = parseJsonObject(envelope.output)
  if (declared) return declared

  if (Array.isArray(envelope.content)) {
    for (const part of envelope.content) {
      const parsed = parseJsonObject(asRecord(part)?.text)
      if (parsed) return parsed
    }
  }

  if ('claim_success' in envelope || 'success' in envelope || 'action_item_id' in envelope) {
    return envelope
  }
  return null
}

function isPresentFailure(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') return false
  if (Array.isArray(value)) return value.length > 0
  return true
}

function hasFailure(result: JsonRecord): boolean {
  if (result.success === false || result.ok === false || result.claim_success === false) return true
  if (isPresentFailure(result.error) || isPresentFailure(result.errors)) return true
  if (isPresentFailure(result.possible_conflict) || isPresentFailure(result.conflict)) return true
  const status = typeof result.status === 'string' ? result.status.toLowerCase() : ''
  return ['error', 'failed', 'failure', 'conflict', 'conflicted', 'rejected', 'denied'].includes(status)
}

function stringField(record: JsonRecord | null, ...names: string[]): string | null {
  if (!record) return null
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function successfulClaimItemId(args: unknown, hookOutput: unknown): string | null {
  const outer = structuredResult(hookOutput)
  if (!outer || hasFailure(outer)) return null
  const payload = asRecord(outer.result) ?? outer
  if (payload !== outer && hasFailure(payload)) return null
  if (payload.claim_success !== true) return null

  const requestedId = stringField(asRecord(args), 'action_item_id')
  const directId = stringField(payload, 'action_item_id')
  const actionItem = asRecord(payload.action_item)
  const nestedId = stringField(actionItem, 'id', 'action_item_id')
  const resultId = directId ?? nestedId
  if (!requestedId || !resultId || !FULL_UUID.test(requestedId) || !FULL_UUID.test(resultId)) return null
  if (directId && nestedId && directId.toLowerCase() !== nestedId.toLowerCase()) return null
  if (requestedId.toLowerCase() !== resultId.toLowerCase()) return null

  const directStatus = stringField(payload, 'status')?.toLowerCase() ?? null
  const nestedStatus = stringField(actionItem, 'status')?.toLowerCase() ?? null
  if (directStatus && nestedStatus && directStatus !== nestedStatus) return null
  const status = directStatus ?? nestedStatus
  if (!status || !CLAIMED_STATUSES.has(status)) return null
  return resultId
}

function successfulLifecycleResult(hookOutput: unknown): boolean {
  const outer = structuredResult(hookOutput)
  if (!outer || hasFailure(outer)) return false
  const payload = asRecord(outer.result)
  return !payload || !hasFailure(payload)
}

function argsItemId(args: unknown): string | null {
  return stringField(asRecord(args), 'action_item_id', 'work_item_id', 'item_id', 'id')
}

function sameItem(left: string, right: string): boolean {
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  return a === b || (a.length >= 6 && b.startsWith(a)) || (b.length >= 6 && a.startsWith(b))
}

/** Process-local, session-scoped claim attestation. Restart/dispose fails closed. */
export class TrackBeforeMutation {
  readonly #claimedBySession = new Map<string, string>()

  before(tool: string, sessionID: unknown): void {
    const session = typeof sessionID === 'string' && sessionID ? sessionID : null
    if (session && this.#claimedBySession.has(session)) return
    const classification = classifyPreclaimTool(tool)
    if (classification === 'read_only' || classification === 'devspec_tracking') return
    throw new Error(
      `DevSpec: ${classification === 'mutation' ? 'local mutation' : 'an unrecognized/custom tool'} ` +
        'is blocked until this OpenCode session successfully calls claim_work_item. ' +
        'Only recognized discovery and DevSpec tracking tools are available before claim. ' +
        'Follow the canonical implementation contract returned by claim_work_item.',
    )
  }

  after(tool: string, sessionID: unknown, args: unknown, hookOutput: unknown): void {
    const session = typeof sessionID === 'string' && sessionID ? sessionID : null
    if (!session) return
    const kind = devSpecToolKind(tool)
    if (kind === CLAIM_TOOL) {
      const itemId = successfulClaimItemId(args, hookOutput)
      if (itemId) this.#claimedBySession.set(session, itemId)
      return
    }
    if (!kind || !CLEAR_TOOLS.has(kind) || !successfulLifecycleResult(hookOutput)) return
    const claimedId = this.#claimedBySession.get(session)
    const completedId = argsItemId(args)
    if (claimedId && completedId && sameItem(claimedId, completedId)) {
      this.#claimedBySession.delete(session)
    }
  }

  clearSession(sessionID: string): void {
    this.#claimedBySession.delete(sessionID)
  }

  clearAll(): void {
    this.#claimedBySession.clear()
  }

  claimedItemForSession(sessionID: string): string | null {
    return this.#claimedBySession.get(sessionID) ?? null
  }
}
