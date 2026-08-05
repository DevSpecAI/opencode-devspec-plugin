/**
 * Client-side remote-control story breadcrumbs (brief 21ea8ff4).
 *
 * Same phase vocabulary as DevSpecV2 `logRemoteControlStory` / Axiom
 * `Remote-control story` rows. Clients write structured JSON into the local
 * poll.log (prefixed `story `) so offline debug matches the Axiom schema —
 * they do not ship token streams.
 *
 * Appends directly to poll.log (does not import remote-control.ts) to avoid
 * a circular dependency with the poll loop.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Shared with server + Cursor — keep docs in sync when extending. */
export const REMOTE_CONTROL_STORY_PHASES = [
  'register',
  'attach',
  'seed_filter',
  'inject',
  'wake',
  'mirror_decision',
  'mirror_post',
  'complete_turn',
  'pickup',
  'done',
  'poll_error',
  'stall',
  'ended',
] as const

export type RemoteControlStoryPhase = (typeof REMOTE_CONTROL_STORY_PHASES)[number]

export type RemoteControlStoryFields = {
  phase: RemoteControlStoryPhase | string
  outcome: string
  reason?: string | null
  connectionId?: string | null
  sessionId?: string | null
  agent?: string | null
  codename?: string | null
  tool?: string | null
  data?: Record<string, unknown>
}

function appendPollLine(line: string): void {
  try {
    const file = path.join(os.homedir(), '.devspec', 'opencode-remote-control', 'poll.log')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    // best-effort
  }
}

/**
 * Append one structured story line to poll.log.
 * Format: `story {"type":"remote_control_story",...}`
 */
export function logRemoteControlStory(fields: RemoteControlStoryFields): void {
  const {
    phase,
    outcome,
    reason,
    connectionId,
    sessionId,
    agent,
    codename,
    tool,
    data,
  } = fields

  const event: Record<string, unknown> = {
    type: 'remote_control_story',
    phase,
    outcome,
    ...(reason != null && reason !== '' ? { reason } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(agent ? { agent } : {}),
    ...(codename ? { codename } : {}),
    ...(tool ? { tool } : {}),
    ...(data ?? {}),
  }

  appendPollLine(`story ${JSON.stringify(event)}`)
}
