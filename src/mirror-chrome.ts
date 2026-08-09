/**
 * Mirror chrome filter — dependency-free helpers shared by the OpenCode mirror
 * path and seed-window command filtering.
 *
 * Live failure (session 0ffe97cb): the model wrapped the terminal-only status
 * block in markdown fences (as the skill example shows). strip removed the
 * banner body but left ``` leftovers, which were posted as a blank bubble;
 * unansweredCommands then treated that bubble as a reply and settled the
 * prior owner command. These helpers are the single place that decision lives.
 *
 * Live failure (Dashing Osprey / session 7976fffb): the model printed a
 * variant status block — a box-drawing rule without the exact
 * `━━━ DevSpec Remote Control ━━━` title — plus an "Internal note (not
 * mirrored)" orientation paragraph. Narrow title matching left the whole
 * turn postable; this module now treats field-block + internal-note chrome
 * the same as the canonical banner.
 */

export const REMOTE_STATUS_BANNER = '━━━ DevSpec Remote Control ━━━'

/** Line-start labels in the terminal-only connect status block. */
const STATUS_FIELD_LABELS = [
  'Agent',
  'Connection',
  'Session',
  'Status',
  'Open',
  'Stop with',
] as const

/** Full-width or ascii rule used as status-block delimiters. */
const RULE_LINE_RE = /^[━─\-═]{8,}\s*$/

/**
 * Canonical title line, or a bare box-drawing rule that models invent when
 * they skip the exact `REMOTE_STATUS_BANNER` string.
 */
const STATUS_OPENER_RE = /^(?:━━━\s*DevSpec Remote Control\s*━━━|[━─\-═]{8,})\s*$/

const STATUS_FIELD_LINE_RE = /^(?:Agent|Connection|Session|Status|Open|Stop with):\s/

/** Models sometimes paste orientation as a labelled "Internal note" aside. */
function internalNotePattern(): RegExp {
  // Fresh instance every call — never share a /g lastIndex across helpers.
  return /(?:^|\n)\s*(?:>\s*)?\*{0,2}Internal note(?:\s*\([^)]*\))?\*{0,2}:[^\n]*(?:\n(?![━─\-═]{8,}\s*$)(?!(?:Agent|Connection|Session|Status|Open|Stop with):\s)[^\n]*)*/gi
}

/**
 * If the whole string is one fenced markdown block, return the inner body.
 * Models often wrap the connect status block that way because the skill
 * documents it inside a fence example.
 */
export function unwrapSingleOuterMarkdownFence(text: string): string {
  const t = String(text ?? '').trim()
  const m = t.match(/^```(?:[a-zA-Z0-9_-]*)?\r?\n([\s\S]*?)\r?\n```$/)
  return m ? String(m[1] ?? '').trim() : t
}

/** Drop orphan fence markers left after a banner strip (e.g. ```\\n```). */
export function collapseOrphanMarkdownFences(text: string): string {
  return String(text ?? '')
    .replace(/```(?:[a-zA-Z0-9_-]*)?\s*```/g, '')
    .replace(/^\s*```(?:[a-zA-Z0-9_-]*)?\s*$/gm, '')
    .trim()
}

/** How many distinct status-field labels appear at line start. */
export function statusFieldHitCount(text: string): number {
  const t = String(text ?? '')
  let n = 0
  for (const label of STATUS_FIELD_LABELS) {
    if (new RegExp(`^${label}:\\s`, 'm').test(t)) n++
  }
  return n
}

/**
 * Strip labelled "Internal note (not mirrored)" orientation chrome.
 * The skill (and models) mark this as terminal-only; it must not become a
 * room bubble even when the status banner was already stripped or omitted.
 */
export function stripInternalNoteChrome(text: string): string {
  return String(text ?? '')
    .replace(internalNotePattern(), '\n')
    .replace(/^\s+|\s+$/g, '')
}

/**
 * Strip the terminal-only status block the devspec.remote command tells the
 * model to print — both the canonical `REMOTE_STATUS_BANNER` form and
 * variant field blocks that open with a bare box-drawing rule (or dive
 * straight into Agent/Connection/Session lines).
 */
export function stripRemoteControlBanner(text: string): string {
  const raw = String(text ?? '')
  if (!raw) return raw

  // Fast path: classic exact-title strip (kept for clarity + tests).
  let t = stripCanonicalRemoteBanner(raw)

  // Variant / leftover field blocks (Dashing Osprey): rule + Agent/…/Stop with.
  t = stripStatusFieldBlocks(t)
  return t.replace(/^\s+|\s+$/g, '')
}

function stripCanonicalRemoteBanner(t: string): string {
  const start = t.indexOf(REMOTE_STATUS_BANNER)
  if (start < 0) return t
  const afterHeader = t.slice(start + REMOTE_STATUS_BANNER.length)
  const ruleMatch = afterHeader.match(/\n[─-]{3,}\s*\n?/)
  let end = start + REMOTE_STATUS_BANNER.length
  if (ruleMatch && typeof ruleMatch.index === 'number') {
    end += ruleMatch.index + ruleMatch[0].length
  } else {
    const nextBlank = afterHeader.search(/\n\s*\n/)
    end = nextBlank >= 0 ? start + REMOTE_STATUS_BANNER.length + nextBlank : t.length
  }
  return `${t.slice(0, start)}${t.slice(end)}`
}

/**
 * Remove one or more consecutive status field blocks. A block is:
 * optional opener (canonical title or rule line) + ≥3 status field lines +
 * optional trailing rule. Requires ≥3 distinct field labels so a real reply
 * that happens to mention "Session: foo" once is not stripped.
 */
function stripStatusFieldBlocks(text: string): string {
  if (statusFieldHitCount(text) < 3) return text

  const lines = text.split(/\r?\n/)
  const keep: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const openerHere = STATUS_OPENER_RE.test(line)
    const fieldHere = STATUS_FIELD_LINE_RE.test(line)

    if (!openerHere && !fieldHere) {
      keep.push(line)
      i++
      continue
    }

    // Peek: collect optional opener + consecutive field lines + optional rule.
    let j = i
    if (openerHere) j++
    const fieldStart = j
    while (j < lines.length && STATUS_FIELD_LINE_RE.test(lines[j] ?? '')) j++
    const fieldCount = j - fieldStart
    // Distinct labels in this run (not just line count).
    const runText = lines.slice(fieldStart, j).join('\n')
    const distinct = statusFieldHitCount(runText)

    if (distinct >= 3 && fieldCount >= 3) {
      if (j < lines.length && RULE_LINE_RE.test(lines[j] ?? '')) j++
      // Drop the block; skip a single blank line that hugged it.
      if (j < lines.length && (lines[j] ?? '').trim() === '') j++
      i = j
      continue
    }

    // Not a status block — keep the current line and move on.
    keep.push(line)
    i++
  }
  return keep.join('\n')
}

/**
 * True when assistant text is operational chrome that must never become a
 * session chat bubble — the terminal status block, fence leftovers, or a bare
 * connect / reconnect one-liner. Fail open for ambiguous / real replies.
 */
export function isOperationalChrome(text: string): boolean {
  let t = String(text ?? '').trim()
  if (!t) return true

  t = unwrapSingleOuterMarkdownFence(t)
  t = collapseOrphanMarkdownFences(t)
  if (!t) return true
  // Fence / backtick / tilde noise with no real prose (the 0ffe97cb leftover).
  if (/^[`~\s]*$/.test(t)) return true

  if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
  if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true

  const firstLine = t.split(/\r?\n/, 1)[0] ?? ''
  const hasInternalNote = internalNotePattern().test(t)
  const hadStatusShape =
    t.includes(REMOTE_STATUS_BANNER) ||
    statusFieldHitCount(t) >= 3 ||
    STATUS_OPENER_RE.test(firstLine)

  if (hadStatusShape || hasInternalNote) {
    t = stripRemoteControlBanner(t).trim()
    t = stripInternalNoteChrome(t).trim()
    t = collapseOrphanMarkdownFences(t)
    if (!t) return true
    if (/^[`~\s]*$/.test(t)) return true
    if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true
    if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
    // Banner plus a tiny leftover (e.g. "Open: Agents page") — still chrome.
    if (t.length < 80 && /^(Agent|Connection|Session|Status|Open|Stop with):/m.test(t)) return true
  }

  // Pure internal-note orientation with no status fields.
  if (/^\s*(?:>\s*)?\*{0,2}Internal note(?:\s*\([^)]*\))?\*{0,2}:/i.test(t)) {
    const stripped = stripInternalNoteChrome(t).trim()
    if (!stripped) return true
  }

  return false
}

/**
 * Prepare an assistant turn's text for mirroring: strip known chrome, then
 * return null if nothing postable remains (pure chrome) — so a real answer
 * that happens to follow a pasted status block still gets posted, banner
 * removed, rather than being dropped along with it.
 */
export function prepareMirrorText(text: string): string | null {
  let t = String(text ?? '').trim()
  if (!t) return null

  t = unwrapSingleOuterMarkdownFence(t)
  t = stripRemoteControlBanner(t).trim()
  t = stripInternalNoteChrome(t).trim()
  t = collapseOrphanMarkdownFences(t)

  if (!t || isOperationalChrome(t)) return null
  return t
}

/** Slash commands whose assistant turn must never be mirrored into DevSpec. */
export const DEVSPEC_REMOTE_CONTROL_COMMANDS = new Set([
  'devspec.remote',
  'devspec.remote-stop',
])

/** True for `/devspec.remote` and `/devspec.remote-stop` (OpenCode command.executed name). */
export function isDevspecRemoteControlCommand(name: unknown): boolean {
  return typeof name === 'string' && DEVSPEC_REMOTE_CONTROL_COMMANDS.has(name)
}

/**
 * Whether mirrorLatestReply must skip posting this OpenCode assistant message.
 *
 * Session e7ecc1de: the `/devspec.remote` connect turn printed status + process
 * narration; prepareMirrorText kept the narration (real prose); the mirror
 * posted it; unansweredCommands then treated it as the answer to a pending
 * dispatch that landed during attach. Skipping the connect skill turn (by
 * command.executed message id and/or a short post-handshake suppress) stops
 * that race without NLP-guessing narration or weakening the seed filter.
 *
 * Session 8a97effc / connection 4aab7fe0: OpenCode fired a late
 * `command.executed` for `devspec.remote` against the *post-inject answer*
 * message id. nonMirrorMessageIds then won over awaitingRemoteReply and the
 * real reply was skip-claimed forever. When awaiting an inject reply, never
 * skip — that flag is the mechanical "this turn is the owner's answer" signal.
 */
export function shouldSkipConnectTurnMirror(opts: {
  messageId: string | null | undefined
  nonMirrorMessageIds?: Iterable<string> | null
  connectMirrorSuppressed?: boolean | null
  awaitingRemoteReply?: boolean | null
}): boolean {
  // Post-inject remote replies always mirror — even if a late connect-skill
  // command.executed wrongly tagged this message id (8a97effc).
  if (opts.awaitingRemoteReply) return false

  const id = typeof opts.messageId === 'string' ? opts.messageId : ''
  if (id && opts.nonMirrorMessageIds) {
    for (const x of opts.nonMirrorMessageIds) {
      if (x === id) return true
    }
  }
  // Handshake suppress covers the race where flushMirrorNow runs before
  // command.executed records the skill message id.
  if (opts.connectMirrorSuppressed) return true
  return false
}

/**
 * Whether a connect-skill skip may permanently claim `lastMirroredMessageId`.
 *
 * Claiming without posting drops the bubble forever. That is correct for a
 * pure connect status turn, but wrong when:
 * - we are still awaiting an inject reply (8a97effc), or
 * - the tagged message still has real answer text after chrome strip
 *   (b156e680 / Brave Osprey: late `devspec.remote` command.executed on the
 *   same id as “-1”, then skip-claim → answer only in the terminal).
 */
export function shouldClaimConnectTurnSuppress(opts: {
  awaitingRemoteReply?: boolean | null
  /** Result of `prepareMirrorText` on the candidate — null means pure chrome. */
  preparedText: string | null
}): boolean {
  if (opts.awaitingRemoteReply) return false
  if (opts.preparedText) return false
  return true
}
