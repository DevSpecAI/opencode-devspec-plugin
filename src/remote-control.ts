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
  /**
   * Id of the last OpenCode assistant message we mirrored back to DevSpec via
   * post_session_message. Prevents re-posting the same reply on every idle
   * poll — there is no other cursor for "have we already reported this one".
   */
  lastMirroredMessageId?: string | null
  /**
   * Cursor into the DevSpec transcript (last delivered message id). Without
   * this, every idle poll re-fetched the WHOLE transcript and re-delivered
   * every owner instruction ever posted — a real bug fixed alongside the
   * model-override work, not a hypothetical one.
   */
  lastDeliveredMessageId?: string | null
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

  if (!state.sessionId) return

  // NOTE: get_connection_dispatch is for agent_assignment work-item batches
  // (autopilot), not ad-hoc chat messages — it has no `owner_messages` field.
  // The real delivery path is the session transcript's `remote_control` stamp
  // below; an earlier version of this file called get_connection_dispatch
  // expecting owner_messages, which silently always returned nothing.
  const transcript: any = await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'get_session_transcript',
    arguments: {
      session_id: state.sessionId,
      connection_id: state.connectionId,
      ...(state.lastDeliveredMessageId ? { after_message_id: state.lastDeliveredMessageId } : {}),
    },
  }).catch(() => null)

  const allMessages: any[] = Array.isArray(transcript?.messages) ? transcript.messages : []
  if (allMessages.length > 0) {
    // Advance the cursor even for messages we don't deliver (advisory context) —
    // without this, every idle poll re-fetched the WHOLE transcript and
    // re-delivered every owner instruction ever posted to this session.
    writeState(directory, { ...state, lastDeliveredMessageId: allMessages[allMessages.length - 1].id })
  }

  const toDeliver = allMessages.filter((m) => m?.remote_control?.is_owner_instruction === true)

  for (const msg of toDeliver) {
    const text = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content ?? msg)
    // Per-message provider/model override — only meaningful for
    // provider-agnostic tools (OpenCode). Verified live: promptAsync's body
    // accepts an optional {providerID, modelID} independent of any agent config.
    const rawModel = msg?.dispatch_model
    const model =
      rawModel && typeof rawModel === 'object' && typeof rawModel.providerID === 'string' && typeof rawModel.modelID === 'string'
        ? { providerID: rawModel.providerID, modelID: rawModel.modelID }
        : undefined

    try {
      // client.session.promptAsync injects the message directly into the running
      // session (POST /session/:id/message under the hood) — no manual paste.
      await (client as any).session.promptAsync({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text }], ...(model ? { model } : {}) },
      })
    } catch (err) {
      // A rejected model/credential must surface back into the DevSpec
      // transcript, not vanish silently on the user's own machine.
      const reason = err instanceof Error ? err.message : String(err)
      await mcpToolsCall({
        mcpUrl: auth.mcp_url,
        token: auth.token,
        name: 'post_session_message',
        arguments: {
          session_id: state.sessionId,
          agent_name: 'OpenCode',
          message: model
            ? `⚠️ Could not run this message on \`${model.providerID}/${model.modelID}\`: ${reason}`
            : `⚠️ Could not deliver this message: ${reason}`,
        },
      }).catch(() => {
        // Best-effort — a failed error-report must never crash the poll loop.
      })
    }
  }

  await mirrorLatestReply(client, auth, directory, state, sessionId)
}

/**
 * Mirror OpenCode's own latest assistant reply back into the DevSpec session,
 * including which model produced it. Only the SINGLE most recent assistant
 * message is checked each poll (not a backlog) — cheap, and avoids flooding
 * DevSpec with a dump of prior history on first connect.
 *
 * This direction (OpenCode → DevSpec) did not exist before this change — the
 * plugin only ever delivered DevSpec → OpenCode. Without it, an owner could
 * pick a model and send a message, but would never see OpenCode's answer
 * appear back in the DevSpec session at all.
 */
async function mirrorLatestReply(
  client: Parameters<Plugin>[0]['client'],
  auth: ReturnType<typeof resolveDevspecAuth>,
  directory: string,
  state: ConnectionState,
  sessionId: string,
): Promise<void> {
  if (!auth.ok || !auth.token || !auth.mcp_url || !state.sessionId) return

  let messages: any[]
  try {
    const res: any = await (client as any).session.messages({ path: { id: sessionId } })
    messages = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []
  } catch {
    return
  }

  const assistantMessages = messages.filter((m) => m?.info?.role === 'assistant')
  const last = assistantMessages[assistantMessages.length - 1]
  if (!last?.info?.id || last.info.id === state.lastMirroredMessageId) return

  const text = (last.parts ?? [])
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text)
    .join('\n')
    .trim()

  if (!text) {
    // Nothing textual to mirror (e.g. a pure tool-call turn) — still advance
    // the cursor so this same non-text message isn't rechecked forever.
    writeState(directory, { ...state, lastMirroredMessageId: last.info.id })
    return
  }

  const modelInfo = last.info.model
  const model =
    modelInfo && typeof modelInfo.providerID === 'string' && typeof modelInfo.modelID === 'string'
      ? { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
      : undefined

  try {
    await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'post_session_message',
      arguments: {
        session_id: state.sessionId,
        agent_name: 'OpenCode',
        message: text,
        ...(model ? { model } : {}),
      },
    })
  } catch {
    // Leave the cursor unadvanced so this same reply is retried next idle poll.
    return
  }

  writeState(directory, { ...state, lastMirroredMessageId: last.info.id })
}
