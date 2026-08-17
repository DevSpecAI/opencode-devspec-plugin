/**
 * Mirror helpers — dependency-free, and deliberately content-BLIND.
 *
 * This module used to decide whether a turn was postable by reading it: banner
 * matching, status-field counting, "internal note" stripping, an
 * `isOperationalChrome` classifier and a `prepareMirrorText` that returned
 * null for anything it judged to be machinery. Each rule was added after a live
 * failure, and the last of them let the word "Done." through into DevSpec
 * session 8fd18ec0 on 2026-08-17 because it did not look like chrome.
 *
 * Egress is now decided by what a turn DID — a handshake turn has no answer to
 * post — so there is nothing left to classify (item 68cc567c). What survives
 * here is formatting that never changes whether something is posted, plus two
 * non-text checks: a command NAME test and inject sequencing during connect.
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
/** Slash commands whose assistant turn is the plugin's own protocol, not an answer. */
export const DEVSPEC_REMOTE_CONTROL_COMMANDS = new Set([
  'devspec.remote',
  'devspec.remote-stop',
])

/** True for `/devspec.remote` and `/devspec.remote-stop` (OpenCode command.executed name). */
export function isDevspecRemoteControlCommand(name: unknown): boolean {
  return typeof name === 'string' && DEVSPEC_REMOTE_CONTROL_COMMANDS.has(name)
}

/**
 * Defer an owner-command inject while a connect handshake is still settling.
 *
 * Session bf7acd8c / item 6990fd9e: a dispatch landed mid-`/devspec.remote`
 * (register done, attach not finished), was injected into that connect turn,
 * and the handshake never completed cleanly. This is about SEQUENCING a turn,
 * not about judging any text.
 *
 * Session 8a97effc / connection 4aab7fe0: OpenCode fired a late
 * `command.executed` for `devspec.remote` against the *post-inject answer*
 * message id. nonMirrorMessageIds then won over awaitingRemoteReply and the
 * real reply was skip-claimed forever. When awaiting an inject reply, never
 * skip — that flag is the mechanical "this turn is the owner's answer" signal.
 */
/**
 * Defer owner-command inject while the connect/handshake turn is still settling.
 *
 * Live session bf7acd8c / item 6990fd9e: an owner dispatch landed mid-
 * `/devspec.remote` (register done, attach not finished). Seed inject fired
 * `promptAsync` into that connect turn; the model answered in the terminal, the
 * mirror claimed success without a room row, and the handshake never completed
 * cleanly. `connectMirrorSuppressed` already means "handshake still settling"
 * for the mirror path — reuse it so inject waits until suppress clears.
 *
 * Does NOT apply when `awaitingRemoteReply` is already true (a real inject turn
 * is in flight — suppress may still be set from register; do not starve that
 * turn's follow-ups).
 */
export function shouldDeferInjectDuringConnect(opts: {
  connectMirrorSuppressed?: boolean | null
  awaitingRemoteReply?: boolean | null
}): boolean {
  if (opts.awaitingRemoteReply) return false
  return Boolean(opts.connectMirrorSuppressed)
}
