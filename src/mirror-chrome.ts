/**
 * Mirror chrome filter — dependency-free helpers shared by the OpenCode mirror
 * path and seed-window command filtering.
 *
 * Live failure (session 0ffe97cb): the model wrapped the terminal-only status
 * block in markdown fences (as the skill example shows). strip removed the
 * banner body but left ``` leftovers, which were posted as a blank bubble;
 * unansweredCommands then treated that bubble as a reply and settled the
 * prior owner command. These helpers are the single place that decision lives.
 */

export const REMOTE_STATUS_BANNER = '━━━ DevSpec Remote Control ━━━'

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

/**
 * Strip the terminal-only status block the devspec.remote command tells the
 * model to print. Removes from the banner header through the trailing rule line.
 */
export function stripRemoteControlBanner(text: string): string {
  const t = String(text ?? '')
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
  return `${t.slice(0, start)}${t.slice(end)}`.replace(/^\s+|\s+$/g, '')
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

  if (t.includes(REMOTE_STATUS_BANNER)) {
    t = stripRemoteControlBanner(t).trim()
    t = collapseOrphanMarkdownFences(t)
    if (!t) return true
    if (/^[`~\s]*$/.test(t)) return true
    if (/^Connected and waiting for your next command\b/i.test(t) && t.length < 280) return true
    if (/^You're connected to .+ agent on their local machine\.?\s*$/i.test(t)) return true
    // Banner plus a tiny leftover (e.g. "Open: Agents page") — still chrome.
    if (t.length < 80 && /^(Agent|Connection|Session|Status|Open|Stop with):/m.test(t)) return true
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
  if (t.includes(REMOTE_STATUS_BANNER)) t = stripRemoteControlBanner(t).trim()
  t = collapseOrphanMarkdownFences(t)

  if (!t || isOperationalChrome(t)) return null
  return t
}
