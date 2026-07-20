/**
 * DevSpec remote control for OpenCode.
 *
 * This is a NEW design, not a straight port of claude-code-devspec-autopilot's
 * remote-control scripts (remote-control-state.mjs + devspec-remote-poll.mjs +
 * devspec-remote-wait.mjs, ~1800 lines combined). That machinery exists purely
 * to work around Claude Code having no server of its own — a detached Node
 * process polls DevSpec and writes owner commands to a file, which the
 * interactive Claude Code session has to separately run a blocking "wait"
 * process to notice.
 *
 * OpenCode doesn't have that problem: this plugin runs INSIDE the OpenCode
 * process and is handed a real SDK `client` that can push a message straight
 * into the live session (`client.session.promptAsync`, verified against the
 * installed @opencode-ai/sdk types — POST /session/:id/message under the
 * hood). So instead of a separate poller process + inbox file + wait script,
 * this hooks OpenCode's own `session.idle` event: whenever the session goes
 * quiet, check DevSpec for a dispatched owner command and inject it directly.
 *
 * Not yet tested against a live OpenCode + DevSpec pairing (no OpenCode
 * install available in the environment this was built in) — the design is
 * grounded in the real installed SDK types, but treat this as a first
 * implementation pass, not a battle-tested one.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Plugin } from '@opencode-ai/plugin'
import { mcpToolsCall } from './devspec-client.js'
import { resolveDevspecAuth } from './resolve-devspec-auth.js'

interface ConnectionState {
  connectionId: string
  sessionId: string | null
  codename: string | null
}

function stateFile(directory: string): string {
  const key = Buffer.from(path.resolve(directory)).toString('base64url').slice(0, 32)
  const dir = path.join(os.homedir(), '.devspec', 'opencode-remote-control')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${key}.json`)
}

function readState(directory: string): ConnectionState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(directory), 'utf8'))
  } catch {
    return null
  }
}

function writeState(directory: string, state: ConnectionState): void {
  fs.writeFileSync(stateFile(directory), JSON.stringify(state, null, 2), { mode: 0o600 })
}

function clearState(directory: string): void {
  try {
    fs.unlinkSync(stateFile(directory))
  } catch {
    /* already gone */
  }
}

/** Register (or reuse) this OpenCode instance as a DevSpec connection. Idempotent per directory. */
export async function ensureConnection(directory: string): Promise<{ auth: ReturnType<typeof resolveDevspecAuth>; state: ConnectionState | null; error?: string }> {
  const auth = resolveDevspecAuth(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url) {
    return { auth, state: null, error: auth.error }
  }

  const existing = readState(directory)
  if (existing) return { auth, state: existing }

  const localId = Buffer.from(path.resolve(directory)).toString('base64url').slice(0, 24)
  const result: any = await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'register_connection',
    arguments: { local_id: localId, agent_name: 'OpenCode', cwd: directory },
  })

  const state: ConnectionState = {
    connectionId: result.connection_id,
    sessionId: null,
    codename: result.codename ?? null,
  }
  writeState(directory, state)
  return { auth, state }
}

/** Attach the connection to a DevSpec session — `/devspec.remote --session <id>`. */
export async function attachSession(directory: string, sessionId: string): Promise<void> {
  const { auth, state } = await ensureConnection(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state) throw new Error(auth.error || 'DevSpec not configured')
  await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'attach_connection',
    arguments: { connection_id: state.connectionId, session_id: sessionId },
  })
  writeState(directory, { ...state, sessionId })
}

/** Detach + mark the connection offline — `/devspec.remote-stop`. */
export async function stopConnection(directory: string): Promise<void> {
  const auth = resolveDevspecAuth(directory)
  const state = readState(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state) {
    clearState(directory)
    return
  }
  try {
    await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'detach_connection',
      arguments: { connection_id: state.connectionId },
    })
  } finally {
    clearState(directory)
  }
}

/**
 * Poll DevSpec for owner commands and inject any into the live OpenCode
 * session directly. Call this from the `session.idle` event — no separate
 * poller process or inbox file needed, unlike Claude Code's design.
 */
export async function pollAndDeliver(
  client: Parameters<Plugin>[0]['client'],
  directory: string,
  sessionId: string,
): Promise<void> {
  const auth = resolveDevspecAuth(directory)
  const state = readState(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state) return

  try {
    await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'heartbeat_connection',
      arguments: { connection_id: state.connectionId, status: 'live' },
    })
  } catch {
    return // connection may have ended server-side — next idle cycle will re-check
  }

  const dispatch: any = await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'get_connection_dispatch',
    arguments: { connection_id: state.connectionId },
  }).catch(() => null)

  const ownerMessages: any[] = Array.isArray(dispatch?.owner_messages) ? dispatch.owner_messages : []

  let transcriptMessages: any[] = []
  if (state.sessionId) {
    const transcript: any = await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'get_session_transcript',
      arguments: { session_id: state.sessionId, connection_id: state.connectionId },
    }).catch(() => null)
    transcriptMessages = (transcript?.messages ?? []).filter(
      (m: any) => m?.remote_control?.is_owner_instruction === true,
    )
  }

  const toDeliver = [...ownerMessages, ...transcriptMessages]
  for (const msg of toDeliver) {
    const text = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content ?? msg)
    // client.session.promptAsync injects the message directly into the running
    // session (POST /session/:id/message under the hood) — no manual paste.
    await (client as any).session.promptAsync({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text }] },
    })
  }
}
