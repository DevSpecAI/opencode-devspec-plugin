import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const CONTRACT_URI = 'devspec://product/implementation-contract'

const CLAIM_TOOL = 'claim_work_item'
const CLEAR_TOOLS = new Set([
  'record_implementation',
  'release_work_item',
  'fail_work_item',
])

const EDIT_TOOLS = new Set(['edit', 'write'])
const BASH_TOOL = 'bash'

const CLAIMED_STATUSES = new Set(['claimed', 'implementing', 'in_progress'])
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REFERENCE_RE =
  /\[devspec:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})\]/gi

const REFUSED_COMMIT_FLAGS = new Set([
  '--amend',
  '--squash',
  '--fixup',
  '--no-edit',
  '--template',
  '-t',
  '-F',
  '--file',
  '-C',
  '--reuse-message',
  '-c',
  '--reedit-message',
  '--interactive',
  '-i',
  '-p',
  '--patch',
])

type JsonRecord = Record<string, unknown>

export type SimpleGitCommit = {
  message: string
  appendable: boolean
  insertOffset: number
}

export type LocalReferenceOutcome = 'absent' | 'malformed' | 'ambiguous' | 'well_formed'

export type ProvenanceDecision =
  | { action: 'allow' }
  | { action: 'stamp'; command: string; itemId: string; field: 'command' | 'cmd' }
  | { action: 'deny'; reason: string }

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
  return resultId.toLowerCase()
}

function successfulLifecycleResult(hookOutput: unknown): boolean {
  const outer = structuredResult(hookOutput)
  if (!outer || hasFailure(outer)) return false
  const payload = asRecord(outer.result)
  return !payload || !hasFailure(payload)
}

function argsItemId(args: unknown): string | null {
  const raw = stringField(asRecord(args), 'action_item_id', 'work_item_id', 'item_id', 'id')
  return raw && FULL_UUID.test(raw) ? raw.toLowerCase() : null
}

export function isKnownEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(tool.toLowerCase())
}

export function isBashTool(tool: string): boolean {
  return tool.toLowerCase() === BASH_TOOL
}

export function shellCommandField(args: unknown): { field: 'command' | 'cmd'; value: string } | null {
  const record = asRecord(args)
  if (!record) return null
  if (typeof record.command === 'string') return { field: 'command', value: record.command }
  if (typeof record.cmd === 'string') return { field: 'cmd', value: record.cmd }
  return null
}

type Token = { value: string; start: number; end: number }

function tokenizeReadable(command: string): Token[][] | null {
  if (!command || command.length > 8192) return null
  const segments: Token[][] = [[]]
  let value = ''
  let started = false
  let quote: "'" | '"' | null = null
  let wordStart = -1

  const endWord = (at: number) => {
    if (!started) return
    segments[segments.length - 1]!.push({ value, start: wordStart, end: at })
    value = ''
    started = false
    wordStart = -1
  }

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!

    if (quote === "'") {
      if (char === "'") {
        quote = null
        continue
      }
      value += char
      started = true
      continue
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null
        continue
      }
      if (char === '$' || char === '`' || char === '\\') return null
      value += char
      started = true
      continue
    }

    if (char === "'" || char === '"') {
      if (!started) wordStart = index
      quote = char
      started = true
      continue
    }
    if (char === '&') {
      if (command[index + 1] !== '&') return null
      if (segments.length > 1) return null
      endWord(index)
      segments.push([])
      index += 1
      continue
    }
    if ('|;<>(){}`$\\\n\r'.includes(char)) return null
    if (/\s/.test(char)) {
      endWord(index)
      continue
    }
    if (!started) wordStart = index
    value += char
    started = true
  }
  if (quote) return null
  endWord(command.length)
  return segments.every((segment) => segment.length > 0) ? segments : null
}

export function simpleGitCommit(command: string): SimpleGitCommit | null {
  const segments = tokenizeReadable(command)
  if (!segments) return null

  if (segments.length === 2) {
    const prefix = segments[0]!
    if (prefix.length !== 2 || prefix[0]!.value !== 'cd') return null
    if (prefix[1]!.value.startsWith('-')) return null
  }

  const words = segments[segments.length - 1]!
  if (words[0]?.value !== 'git') return null

  let index = 1
  while (index < words.length && words[index]!.value.startsWith('-')) {
    const option = words[index]!.value
    if (option === '-C') {
      const target = words[index + 1]
      if (!target || target.value.startsWith('-')) return null
      index += 2
      continue
    }
    if (option === '--no-pager' || option === '--no-optional-locks') {
      index += 1
      continue
    }
    return null
  }
  if (words[index]?.value !== 'commit') return null

  const rest = words.slice(index + 1)
  for (const entry of rest) {
    if (REFUSED_COMMIT_FLAGS.has(entry.value)) return null
    if (/^(?:--file|--template|--reuse-message|--reedit-message|--squash|--fixup)=/.test(entry.value)) {
      return null
    }
  }

  const messages: Array<Token & { joined?: boolean }> = []
  for (let i = 0; i < rest.length; i++) {
    const entry = rest[i]!
    if (entry.value === '-m' || entry.value === '--message' || entry.value === '-am') {
      const next = rest[i + 1]
      if (!next) return null
      messages.push(next)
      i += 1
      continue
    }
    if (entry.value.startsWith('--message=')) {
      messages.push({
        value: entry.value.slice('--message='.length),
        start: entry.start,
        end: entry.end,
        joined: true,
      })
      continue
    }
    if (/^-m./.test(entry.value)) {
      messages.push({
        value: entry.value.slice(2),
        start: entry.start,
        end: entry.end,
        joined: true,
      })
      continue
    }
  }
  if (messages.length !== 1) return null

  const message = messages[0]!
  const closing = command[message.end - 1]
  const quoted = closing === '"' || closing === "'"
  return {
    message: message.value,
    insertOffset: message.end - 1,
    appendable: quoted && !message.joined,
  }
}

export function isSimpleGitPush(command: string): boolean {
  const segments = tokenizeReadable(command)
  if (!segments) return false
  if (segments.length === 2) {
    const prefix = segments[0]!
    if (prefix.length !== 2 || prefix[0]!.value !== 'cd') return false
    if (prefix[1]!.value.startsWith('-')) return false
  }
  const words = segments[segments.length - 1]!
  if (words[0]?.value !== 'git') return false
  let index = 1
  while (index < words.length && words[index]!.value.startsWith('-')) {
    const option = words[index]!.value
    if (option === '-C') {
      const target = words[index + 1]
      if (!target || target.value.startsWith('-')) return false
      index += 2
      continue
    }
    if (option === '--no-pager' || option === '--no-optional-locks') {
      index += 1
      continue
    }
    return false
  }
  return words[index]?.value === 'push'
}

export function referencesIn(message: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const match of message.matchAll(REFERENCE_RE)) {
    const id = match[1]!.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    found.push(id)
  }
  return found
}

export function localReferenceOutcome(message: string): LocalReferenceOutcome {
  const refs = referencesIn(message)
  if (refs.length > 1) return 'ambiguous'
  if (refs.length === 1) return 'well_formed'
  if (/\[devspec:/i.test(message)) return 'malformed'
  return 'absent'
}

export function stampCommand(command: string, commit: SimpleGitCommit, itemId: string): string | null {
  if (!commit.appendable) return null
  const tag = ` [devspec:${itemId}]`
  return `${command.slice(0, commit.insertOffset)}${tag}${command.slice(commit.insertOffset)}`
}

export function readProjectPin(
  startDir: string,
  homeDir: string = os.homedir(),
): { projectId: string; pinPath: string } | null {
  if (!startDir) return null
  let dir = path.resolve(startDir)
  const home = path.resolve(homeDir)
  const seen = new Set<string>()
  while (!seen.has(dir)) {
    seen.add(dir)
    if (dir === home) break
    const pinPath = path.join(dir, '.devspec', 'project.json')
    try {
      const parsed = JSON.parse(fs.readFileSync(pinPath, 'utf8')) as { project_id?: unknown }
      if (typeof parsed.project_id === 'string' && FULL_UUID.test(parsed.project_id.trim())) {
        return { projectId: parsed.project_id.trim().toLowerCase(), pinPath }
      }
    } catch {
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function recoveryText(claims: string[]): string {
  if (claims.length > 1) {
    return [
      `DevSpec: this commit has no [devspec:<id>] reference and ${claims.length} claims are active, so nothing was added automatically.`,
      `Put exactly one of ${claims.map((id) => `[devspec:${id}]`).join(' or ')} in the message and retry.`,
      `Authority: ${CONTRACT_URI}. Nothing else is blocked.`,
    ].join(' ')
  }
  return [
    'DevSpec: this commit has no [devspec:<id>] reference, so it would land unlinked.',
    'Recover without leaving this turn: reuse or create the smallest item that covers it,',
    'add [devspec:<full-uuid>] to the commit message, and retry.',
    `Authority: ${CONTRACT_URI}. Nothing else is blocked.`,
  ].join(' ')
}

export function decideCommit(input: {
  command: string
  claims: string[]
  hasJurisdiction: boolean
}): ProvenanceDecision {
  const commit = simpleGitCommit(input.command)
  if (!commit) return { action: 'allow' }

  const outcome = localReferenceOutcome(commit.message)
  if (outcome === 'well_formed' || outcome === 'ambiguous') return { action: 'allow' }
  if (!input.hasJurisdiction) return { action: 'allow' }

  if (outcome === 'absent' && input.claims.length === 1 && commit.appendable) {
    const itemId = input.claims[0]!
    const stamped = stampCommand(input.command, commit, itemId)
    if (stamped) {
      return { action: 'stamp', command: stamped, itemId, field: 'command' }
    }
  }

  return { action: 'deny', reason: recoveryText(input.claims) }
}

function appendVisible(output: unknown, note: string): void {
  const record = asRecord(output)
  if (!record) return
  if (typeof record.output === 'string' && record.output.length > 0) {
    record.output = `${record.output}\n${note}`
    return
  }
  record.output = note
}

function nudgeText(): string {
  return [
    'DevSpec: no active claim in this session. Early claiming remains the normal workflow —',
    'call claim_work_item before you commit. Edits are not blocked.',
    `See ${CONTRACT_URI}.`,
  ].join(' ')
}

export class CommitProvenance {
  readonly #directory: string
  readonly #homeDir: string
  readonly #claimsBySession = new Map<string, Set<string>>()
  readonly #nudged = new Set<string>()
  readonly #pendingNotes = new Map<string, string>()

  constructor(options: { directory: string; homeDir?: string } = { directory: process.cwd() }) {
    this.#directory = options.directory
    this.#homeDir = options.homeDir ?? os.homedir()
  }

  hasJurisdiction(): boolean {
    return readProjectPin(this.#directory, this.#homeDir) !== null
  }

  claimsForSession(sessionID: string): string[] {
    return [...(this.#claimsBySession.get(sessionID) ?? [])]
  }

  didNudge(sessionID: string): boolean {
    const pin = readProjectPin(this.#directory, this.#homeDir)
    return this.#nudged.has(`${sessionID}\0${pin?.projectId ?? this.#directory}`)
  }

  before(tool: string, sessionID: unknown, args: unknown = {}, callID?: string): void {
    if (!isBashTool(tool)) return
    const field = shellCommandField(args)
    if (!field) return
    if (isSimpleGitPush(field.value)) return

    const session = typeof sessionID === 'string' && sessionID ? sessionID : ''
    const decision = decideCommit({
      command: field.value,
      claims: session ? this.claimsForSession(session) : [],
      hasJurisdiction: this.hasJurisdiction(),
    })

    if (decision.action === 'allow') return
    if (decision.action === 'stamp') {
      const record = asRecord(args)
      if (!record) return
      record[field.field] = decision.command
      if (callID) {
        this.#pendingNotes.set(
          callID,
          `DevSpec stamped [devspec:${decision.itemId}] onto this commit message (one active claim).`,
        )
      }
      return
    }
    throw new Error(decision.reason)
  }

  after(tool: string, sessionID: unknown, args: unknown, hookOutput: unknown, callID?: string): void {
    if (callID) {
      const note = this.#pendingNotes.get(callID)
      if (note) {
        appendVisible(hookOutput, note)
        this.#pendingNotes.delete(callID)
      }
    }

    const session = typeof sessionID === 'string' && sessionID ? sessionID : null
    if (session) this.#observeClaim(tool, session, args, hookOutput)

    if (!session || !isKnownEditTool(tool) || !this.hasJurisdiction()) return
    if (this.claimsForSession(session).length > 0) return
    const pin = readProjectPin(this.#directory, this.#homeDir)
    const key = `${session}\0${pin?.projectId ?? this.#directory}`
    if (this.#nudged.has(key)) return
    this.#nudged.add(key)
    appendVisible(hookOutput, nudgeText())
  }

  clearSession(sessionID: string): void {
    this.#claimsBySession.delete(sessionID)
    for (const key of [...this.#nudged]) {
      if (key.startsWith(`${sessionID}\0`)) this.#nudged.delete(key)
    }
  }

  clearAll(): void {
    this.#claimsBySession.clear()
    this.#nudged.clear()
    this.#pendingNotes.clear()
  }

  #observeClaim(tool: string, session: string, args: unknown, hookOutput: unknown): void {
    const kind = devSpecToolKind(tool)
    if (kind === CLAIM_TOOL) {
      const itemId = successfulClaimItemId(args, hookOutput)
      if (!itemId) return
      const current = this.#claimsBySession.get(session) ?? new Set<string>()
      current.add(itemId)
      this.#claimsBySession.set(session, current)
      return
    }
    if (!kind || !CLEAR_TOOLS.has(kind) || !successfulLifecycleResult(hookOutput)) return
    const completedId = argsItemId(args)
    if (!completedId) return
    const current = this.#claimsBySession.get(session)
    if (!current) return
    current.delete(completedId)
    if (current.size === 0) this.#claimsBySession.delete(session)
  }
}
