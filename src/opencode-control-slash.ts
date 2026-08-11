/**
 * OpenCode native control slashes for DevSpec remote control (item b315fe42).
 *
 * Exact owner tokens only — `/compact`, `/summarize`, `/abort`, `/new`, `/clear`,
 * `/undo`, `/redo` — executed via `@opencode-ai/sdk` session APIs, never
 * `promptAsync` of the slash text.
 */

export const OPENCODE_CONTROL_SLASH_NAMES = [
  'compact',
  'summarize',
  'abort',
  'new',
  'clear',
  'undo',
  'redo',
] as const

export type OpencodeControlSlashName = (typeof OPENCODE_CONTROL_SLASH_NAMES)[number]

export type OpencodeControlSlash =
  | { kind: 'compact' }
  | { kind: 'abort' }
  | { kind: 'new' }
  | { kind: 'undo' }
  | { kind: 'redo' }

const NAME_SET = new Set<string>(OPENCODE_CONTROL_SLASH_NAMES)

/**
 * Parse a single owner-command body as an exact OpenCode control slash.
 * Extra prose or arguments → null (falls through to normal prompt inject).
 */
export function parseOpencodeControlSlash(raw: string | null | undefined): OpencodeControlSlash | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)\s*$/)
  if (!match) return null
  const name = (match[1] ?? '').toLowerCase()
  if (!NAME_SET.has(name)) return null
  switch (name) {
    case 'compact':
    case 'summarize':
      return { kind: 'compact' }
    case 'abort':
      return { kind: 'abort' }
    case 'new':
    case 'clear':
      return { kind: 'new' }
    case 'undo':
      return { kind: 'undo' }
    case 'redo':
      return { kind: 'redo' }
    default:
      return null
  }
}

/**
 * When the delivered turn is exactly one control slash (no attachments),
 * return it — otherwise null so the normal promptAsync path runs.
 */
export function resolveOwnerControlSlash(commands: unknown[]): OpencodeControlSlash | null {
  if (!Array.isArray(commands) || commands.length !== 1) return null
  const only = commands[0] as Record<string, unknown> | null
  if (!only || typeof only !== 'object') return null
  const content =
    typeof only.content === 'string'
      ? only.content
      : typeof only.text === 'string'
        ? only.text
        : null
  return parseOpencodeControlSlash(content)
}

export function controlSlashSuccessMessage(cmd: OpencodeControlSlash): string {
  switch (cmd.kind) {
    case 'compact':
      return 'Compacted the OpenCode session context.'
    case 'abort':
      return 'Aborted the current OpenCode generation.'
    case 'new':
      return 'Started a new OpenCode session.'
    case 'undo':
      return 'Undid the last OpenCode turn.'
    case 'redo':
      return 'Redid the previously undone OpenCode turn.'
  }
}
