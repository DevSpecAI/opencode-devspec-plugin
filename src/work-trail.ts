/**
 * Live work trail — serialize an in-flight OpenCode turn into terminal text for
 * DevSpec's streaming bubble (DevSpec item bfca2495).
 *
 * Until now a remote turn was invisible until its answer landed: the owner
 * dispatched work from DevSpec and watched an empty room for minutes. This module
 * turns whatever OpenCode has produced SO FAR into one cumulative blob that
 * `post_session_message({ phase: 'trail' })` grows on a single DevSpec turn.
 *
 * UNFILTERED, deliberately. The mirror path (`prepareMirrorText`) strips connect
 * banners and operational chrome because the answer must read as an answer; the
 * trail is the opposite surface — it is what the terminal shows, tool calls,
 * reasoning, failures and all. The only thing this module shortens is a single
 * enormous tool output, and it says so in place rather than dropping it silently.
 *
 * Pure functions: no OpenCode client, no filesystem, no network. The transport
 * lives in remote-control.ts.
 */

/**
 * Client-side ceiling on the whole cumulative trail. Matches DevSpec's own cap
 * (WORK_TRAIL_MAX_CHARS) so the server never has to trim what we send, and so a
 * very long turn cannot grow one MCP request without bound.
 */
export const TRAIL_MAX_CHARS = 100_000

/**
 * Longest single tool/part output carried verbatim before the middle is elided.
 * Matches the cumulative trail ceiling so ordinary turns are not silently
 * filtered — only a single part that alone exceeds the whole-trail budget is
 * shortened (with an in-place notice), and `clampTrail` still owns the total.
 */
export const TRAIL_PART_MAX_CHARS = TRAIL_MAX_CHARS

/** Head marker when the cumulative trail is trimmed to TRAIL_MAX_CHARS. */
export const TRAIL_TRIM_NOTICE = '… earlier output trimmed …\n'

/** Minimum spacing between trail posts — one per second keeps the bubble ~1s behind. */
export const TRAIL_POST_MIN_GAP_MS = 1_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/** Shorten one oversized blob from the MIDDLE, keeping its head and its tail. */
export function elideLongOutput(text: string, max = TRAIL_PART_MAX_CHARS): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 40) / 2)
  const dropped = text.length - half * 2
  return `${text.slice(0, half)}\n… ${dropped} chars elided …\n${text.slice(text.length - half)}`
}

/** One-line, safe-for-logs rendering of a tool's input arguments. */
function summarizeToolInput(input: unknown): string {
  const rec = asRecord(input)
  if (!rec) return typeof input === 'string' ? input : ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(rec)) {
    const rendered =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : Array.isArray(value)
            ? `[${value.length}]`
            : value == null
              ? ''
              : '{…}'
    if (!rendered) continue
    parts.push(`${key}=${rendered.length > 200 ? `${rendered.slice(0, 200)}…` : rendered}`)
  }
  return parts.join(' ')
}

/**
 * Render one OpenCode message part as trail text, or null when the part carries
 * no output of its own (step boundaries — structure, not content).
 *
 * Defensive across part shapes on purpose: OpenCode has moved these fields
 * between versions, and a trail that silently loses a tool call is worse than one
 * that renders an unfamiliar part as its raw shape.
 */
export function serializeTrailPart(rawPart: unknown): string | null {
  const part = asRecord(rawPart)
  if (!part) return null
  const type = String(part.type ?? '').toLowerCase()

  if (type === 'step-start' || type === 'step-finish' || type === 'step_start' || type === 'step_finish') {
    return null
  }

  if (type === 'text') {
    const text = typeof part.text === 'string' ? part.text : ''
    return text.trim() ? text : null
  }

  if (type === 'reasoning' || type === 'thinking') {
    const text = firstString(part, ['text', 'thinking', 'content']) ?? ''
    return text.trim() ? `» ${text.trim()}` : null
  }

  if (type === 'tool' || type === 'tool-call' || type === 'tool_use') {
    const nested = asRecord(part.tool)
    const name =
      firstString(part, ['tool', 'name', 'toolName', 'call']) ??
      (nested ? firstString(nested, ['name']) : null) ??
      'tool'
    const state = asRecord(part.state) ?? {}
    const status = String(state.status ?? part.status ?? '').toLowerCase()
    const input = summarizeToolInput(state.input ?? part.input ?? (nested ? nested.input : undefined))
    const header = `$ ${name}${input ? ` ${input}` : ''}`

    if (status === 'pending' || status === 'running') return `${header}\n  … running`

    const output =
      firstString(state, ['output', 'result', 'stdout', 'text']) ??
      firstString(part, ['output', 'result']) ??
      ''
    const error = firstString(state, ['error', 'message']) ?? ''
    const body = error ? `error: ${error}` : output
    if (!body) return header
    return `${header}\n${elideLongOutput(body)}`
  }

  if (type === 'file') {
    const name = firstString(part, ['filename', 'path', 'url']) ?? 'file'
    return `[file] ${name}`
  }

  if (type === 'patch') {
    const files = Array.isArray(part.files) ? part.files.length : null
    return `[patch]${files == null ? '' : ` ${files} file(s)`}`
  }

  if (type === 'agent') {
    const name = firstString(part, ['name', 'agent']) ?? 'agent'
    return `[agent] ${name}`
  }

  // Unknown shape: keep it rather than drop it — an unfamiliar part is exactly
  // the output a human debugging a stuck turn needs to see.
  const inlineText = firstString(part, ['text', 'output', 'message'])
  if (inlineText) return `[${type || 'part'}] ${elideLongOutput(inlineText)}`
  try {
    return `[${type || 'part'}] ${elideLongOutput(JSON.stringify(part) ?? '', 600)}`
  } catch {
    return `[${type || 'part'}]`
  }
}

/** Trim the cumulative trail to TRAIL_MAX_CHARS, keeping the most recent output. */
export function clampTrail(trail: string): string {
  if (trail.length <= TRAIL_MAX_CHARS) return trail
  const keep = TRAIL_MAX_CHARS - TRAIL_TRIM_NOTICE.length
  return TRAIL_TRIM_NOTICE + trail.slice(trail.length - keep)
}

/**
 * Serialize the assistant turn(s) of this OpenCode session that belong to the
 * remote turn in flight, newest last.
 *
 * `afterMessageId` is the pre-inject baseline the mirror already tracks
 * (`replyAfterOpenCodeMessageId`): everything after it is this remote turn's
 * work. Without a baseline only the newest assistant message is serialized —
 * never the whole session history, which would republish old turns as live work.
 */
export function serializeTurnTrail(
  messages: unknown,
  opts?: { afterMessageId?: string | null },
): string {
  const all = Array.isArray(messages) ? messages : []
  const assistants = all.filter((m) => asRecord(asRecord(m)?.info)?.role === 'assistant')
  if (assistants.length === 0) return ''

  let scope = assistants.slice(-1)
  const baseline = opts?.afterMessageId ?? null
  if (baseline) {
    const idx = assistants.findIndex((m) => asRecord(asRecord(m)?.info)?.id === baseline)
    if (idx >= 0) scope = assistants.slice(idx + 1)
  }

  const blocks: string[] = []
  for (const message of scope) {
    const parts = asRecord(message)?.parts
    for (const part of Array.isArray(parts) ? parts : []) {
      const rendered = serializeTrailPart(part)
      if (rendered) blocks.push(rendered)
    }
  }
  return clampTrail(blocks.join('\n\n').trimEnd())
}

/**
 * Whether to send this trail now.
 *
 * Two guards, both load-bearing: nothing NEW to say (this trail hashes to what we
 * last posted) means the update would cost a request and change nothing on
 * screen, and a post inside `minGapMs` of the last one is the throttle that keeps
 * a chatty `message.updated` stream from becoming an MCP call per token. `force`
 * is the turn-boundary flush.
 *
 * The caller hashes (`hashPostedContent`) rather than this comparing bodies: the
 * previous trail would otherwise have to live in the on-disk state file, which
 * means writing up to 100KB of terminal output to disk on every update.
 */
export function shouldPostTrail(input: {
  trail: string
  trailHash: string
  lastPostedTrailHash?: string | null
  lastPostedAt?: number | null
  now: number
  minGapMs?: number
  force?: boolean
}): boolean {
  if (!input.trail.trim()) return false
  if (input.trailHash === (input.lastPostedTrailHash ?? null)) return false
  if (input.force) return true
  const gap = input.minGapMs ?? TRAIL_POST_MIN_GAP_MS
  const last = input.lastPostedAt ?? null
  if (last == null) return true
  return input.now - last >= gap
}
