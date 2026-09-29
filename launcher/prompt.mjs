/**
 * Writing the prompt a freshly-launched agent wakes up holding.
 *
 * Stamping is host-independent: every agent needs its local session id and launch
 * id written where the agent can read them back. What goes IN the prompt beyond
 * that is the plugin's business, not the launcher's.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function stampLine(sessionId) {
  return `DevSpec local_session_id for this run (stamp on record_implementation / failure update): ${sessionId}`
}

/**
 * Correlate launcher + connect Axiom phase rows (item 383de0cd).
 * @param {string} launchId
 * @returns {string}
 */
export function launchIdStampLine(launchId) {
  return `DevSpec launch_id for this run (pass --launch-id on remote-control-state / wait): ${launchId}`
}

/**
 * Full multiline prompt written to disk for the agent to read.
 * Never put this on argv — remote-control embeds (~28KB SKILL.md with YAML
 * `---`) and Windows/PowerShell argv forwarding turns a bare `---` into
 * `error: unknown option '---'` (session aa5090bc / item e949305f).
 * @param {string} expandedBody
 * @param {string} chatId
 * @param {{ launchId?: string | null }} [opts]
 * @returns {string}
 */
export function buildStampedPromptBody(expandedBody, chatId, opts = {}) {
  const stamp = stampLine(chatId)
  const launchStamp =
    typeof opts.launchId === 'string' && opts.launchId.trim()
      ? launchIdStampLine(opts.launchId.trim())
      : null
  const footer = launchStamp ? `${stamp}\n${launchStamp}` : stamp
  const body = typeof expandedBody === 'string' ? expandedBody.trim() : ''
  return body ? `${body}\n\n${footer}\n` : `${footer}\n`
}

/**
 * Path for the stamped prompt file, colocated with the launch prompt.
 * @param {string} promptFile
 * @param {string} chatId
 * @returns {string}
 */
export function resolveStampedPromptPath(promptFile, chatId) {
  const dir = path.dirname(promptFile)
  let base = path.basename(promptFile)
  // Launch files are `*.prompt.txt` — strip that compound suffix so we do not
  // produce `foo.prompt.stamped-….txt`.
  if (base.toLowerCase().endsWith('.prompt.txt')) {
    base = base.slice(0, -'.prompt.txt'.length)
  } else {
    base = path.basename(promptFile, path.extname(promptFile))
  }
  const shortId =
    String(chatId ?? '')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 12) || 'chat'
  return path.join(dir, `${base}.stamped-${shortId}.txt`)
}

/**
 * Quote a filesystem path for an agent-facing Shell one-liner (not cmd.exe).
 * @param {string} p
 * @returns {string}
 */
export function quotePathForPrompt(p) {
  const s = String(p ?? '')
  if (!s) return '""'
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}
