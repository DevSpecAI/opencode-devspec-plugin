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
  /**
   * Bounded list of DevSpec message ids already delivered via promptAsync.
   * Real bug found live-testing: the SAME owner message got delivered to
   * OpenCode 3 separate times (3 duplicate answers inside one OpenCode
   * session for one single DevSpec-side dispatch) even though
   * get_session_transcript's own after_message_id cursor was verified
   * correct in isolation — the exact mechanism wasn't fully isolated, but
   * this list makes duplicate delivery structurally impossible regardless
   * of how a stale/racing cursor read could happen. Capped at 50 entries in
   * the delivery loop — only needs to cover recent history.
   */
  deliveredMessageIds?: string[]
  /**
   * Our own last-known assertion of heartbeat_connection's `busy` flag —
   * the SOLE signal that drives the "OpenCode is working…" indicator on the
   * agent's icon in the DevSpec session UI (confirmed against the tool's
   * own contract). Real gap found: every heartbeat_connection call in this
   * file only ever sent `status: 'live'` — never `busy` — so the connection
   * always showed live but never showed as working, no matter how long a
   * turn actually took. Tracked here so re-asserting on routine keep-alives
   * (per the tool's contract) doesn't require an extra read each time, and
   * so we only call the tool again when the value actually changes.
   */
  busy?: boolean
}

/**
 * Assert heartbeat_connection's `busy` flag — see the `busy` field doc on
 * ConnectionState for why this exists. Call with `true` right before
 * kicking off a delivered message's turn, and `false` as soon as OpenCode's
 * own `session.idle` event confirms the turn actually finished.
 */
export async function setBusy(directory: string, busy: boolean): Promise<void> {
  const auth = resolveDevspecAuth(directory)
  const state = readState(directory)
  if (!auth.ok || !auth.token || !auth.mcp_url || !state) return
  if (state.busy === busy) return // already asserted — avoid a redundant call
  try {
    await mcpToolsCall({
      mcpUrl: auth.mcp_url,
      token: auth.token,
      name: 'heartbeat_connection',
      arguments: { connection_id: state.connectionId, status: 'live', busy },
    })
    writeState(directory, { ...state, busy })
  } catch {
    // Best-effort — a failed busy assertion must never crash the poll loop.
  }
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

/**
 * Bridge between the `/devspec.remote` MARKDOWN command (which has the model
 * call `register_connection`/`attach_connection` directly as raw MCP tool
 * calls) and this file's own local state, which `pollAndDeliver` depends on
 * to know a connection exists at all.
 *
 * Real gap found live-testing: the command completes a genuine connect
 * handshake with DevSpec's server, but never went through `ensureConnection`/
 * `attachSession` above — so no local state file was ever written, and
 * `pollAndDeliver` (gated on `readState(directory)` being non-null) silently
 * never activated for that session. Wire this into the `tool.execute.after`
 * plugin hook so ANY path that results in these tool calls (the command,
 * or the model doing it ad hoc) keeps local state in sync automatically —
 * no dependence on the command's own wording.
 *
 * `hookOutput` is the RAW `tool.execute.after` output object. Verified live
 * that this does NOT match the hook's own declared `{title, output,
 * metadata}` shape for MCP-sourced tools specifically — MCP results instead
 * arrive as the standard MCP envelope `{content: [{type: 'text', text:
 * '...'}]}`, with the actual JSON payload inside `text`. Built-in tools
 * (bash, glob, ...) DO use `{output: string}`. Check both rather than
 * trusting the declared type, which is only accurate for the built-in case.
 */
export function recordConnectionEventFromTool(
  directory: string,
  toolName: string,
  args: unknown,
  hookOutput: unknown,
): void {
  const isRegister = toolName === 'devspec_register_connection' || toolName.endsWith('register_connection')
  const isAttach = toolName === 'devspec_attach_connection' || toolName.endsWith('attach_connection')
  if (!isRegister && !isAttach) return

  const out = (hookOutput && typeof hookOutput === 'object' ? hookOutput : {}) as Record<string, unknown>
  const mcpContent = Array.isArray(out.content) ? out.content : null
  const rawText =
    typeof out.output === 'string'
      ? out.output
      : mcpContent && typeof mcpContent[0]?.text === 'string'
        ? (mcpContent[0].text as string)
        : null
  if (!rawText) return

  let result: any
  try {
    result = JSON.parse(rawText)
  } catch {
    return
  }

  const existing = readState(directory)
  const argsObj = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>

  if (isRegister) {
    const connectionId = typeof result?.connection_id === 'string' ? result.connection_id : existing?.connectionId
    if (!connectionId) return
    writeState(directory, {
      connectionId,
      sessionId: existing?.sessionId ?? null,
      codename: typeof result?.codename === 'string' ? result.codename : existing?.codename ?? null,
      lastMirroredMessageId: existing?.lastMirroredMessageId,
      lastDeliveredMessageId: existing?.lastDeliveredMessageId,
      deliveredMessageIds: existing?.deliveredMessageIds,
    })
    return
  }

  // Attach: connection_id/session_id may come back on the result, or only be
  // present on the call's own args (DevSpec's attach_connection echoes both,
  // but don't assume — fall back to what the model was called with).
  const connectionId =
    typeof result?.connection_id === 'string'
      ? result.connection_id
      : typeof argsObj.connection_id === 'string'
        ? (argsObj.connection_id as string)
        : existing?.connectionId
  const sessionId =
    typeof result?.session_id === 'string'
      ? result.session_id
      : typeof argsObj.session_id === 'string'
        ? (argsObj.session_id as string)
        : existing?.sessionId ?? null
  if (!connectionId) return

  writeState(directory, {
    connectionId,
    sessionId,
    codename: existing?.codename ?? null,
    lastMirroredMessageId: existing?.lastMirroredMessageId,
    lastDeliveredMessageId: existing?.lastDeliveredMessageId,
    deliveredMessageIds: existing?.deliveredMessageIds,
  })
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

// Dedup key for reportPollError, keyed by directory — avoids spamming DevSpec
// with the same warning every 8s from the interval backstop. Module-level and
// in-memory only (resets on server restart); that's fine, a repeat failure
// re-posting once per minute is still far better than the total silence this
// replaces.
const lastPollErrorReports = new Map<string, { message: string; at: number }>()
const POLL_ERROR_REPORT_COOLDOWN_MS = 60_000

/**
 * Post a poll failure back into the DevSpec session so it's diagnosable from
 * the owner's side, not just the machine's own (usually inaccessible) logs.
 *
 * Real gap found live-testing: `pollAndDeliver`'s heartbeat/transcript-fetch
 * failures were caught-and-swallowed with zero trace anywhere — a dispatched
 * message could sit as "waiting for pickup" forever with no way for the
 * owner (or anyone debugging remotely) to tell whether delivery was merely
 * slow or the whole poll loop was silently broken.
 */
async function reportPollError(
  auth: ReturnType<typeof resolveDevspecAuth>,
  directory: string,
  sessionId: string | null,
  stage: string,
  err: unknown,
): Promise<void> {
  if (!auth.ok || !auth.token || !auth.mcp_url || !sessionId) return
  const message = err instanceof Error ? err.message : String(err)
  const key = `${directory}:${stage}`
  const prior = lastPollErrorReports.get(key)
  if (prior && prior.message === message && Date.now() - prior.at < POLL_ERROR_REPORT_COOLDOWN_MS) return
  lastPollErrorReports.set(key, { message, at: Date.now() })

  await mcpToolsCall({
    mcpUrl: auth.mcp_url,
    token: auth.token,
    name: 'post_session_message',
    arguments: {
      session_id: sessionId,
      agent_name: 'OpenCode',
      message: `⚠️ Remote-control poll failed at \`${stage}\`: ${message}`,
    },
  }).catch(() => {
    // Best-effort — a failed error-report must never crash the poll loop.
  })
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
      // Re-assert our last-known busy value on every keep-alive, per
      // heartbeat_connection's own documented contract ("re-assert on
      // keep-alives") — otherwise a long-running turn's busy:true would
      // silently decay back to idle server-side after its freshness window.
      arguments: { connection_id: state.connectionId, status: 'live', busy: state.busy ?? false },
    })
  } catch (err) {
    // connection may have ended server-side — next idle cycle will re-check.
    // Still surface it: a persistently failing heartbeat means NOTHING below
    // this line ever runs, which previously looked identical to "delivered,
    // just slow" from the owner's side.
    await reportPollError(auth, directory, state.sessionId, 'heartbeat_connection', err)
    return
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
  }).catch((err) => {
    void reportPollError(auth, directory, state.sessionId, 'get_session_transcript', err)
    return null
  })

  const allMessages: any[] = Array.isArray(transcript?.messages) ? transcript.messages : []
  if (allMessages.length > 0) {
    // Advance the cursor even for messages we don't deliver (advisory context) —
    // without this, every idle poll re-fetched the WHOLE transcript and
    // re-delivered every owner instruction ever posted to this session.
    writeState(directory, { ...state, lastDeliveredMessageId: allMessages[allMessages.length - 1].id })
  }

  const toDeliver = allMessages.filter((m) => m?.remote_control?.is_owner_instruction === true)
  const deliveredIds = new Set(state.deliveredMessageIds ?? [])

  // Assert busy BEFORE kicking off any turn — see setBusy's doc. Only the
  // undelivered ones matter (an all-already-delivered batch means nothing
  // new is actually starting).
  if (toDeliver.some((m) => typeof m?.id === 'string' && !deliveredIds.has(m.id))) {
    await setBusy(directory, true)
  }

  for (const msg of toDeliver) {
    if (typeof msg?.id === 'string' && deliveredIds.has(msg.id)) continue // see deliveredMessageIds doc

    // Mark as claimed BEFORE calling promptAsync (not after) and persist
    // immediately — closes the race window as tightly as possible so a
    // concurrent/overlapping poll invocation sees this id already delivered
    // rather than independently fetching and delivering it a second time.
    if (typeof msg?.id === 'string') {
      deliveredIds.add(msg.id)
      writeState(directory, { ...state, deliveredMessageIds: Array.from(deliveredIds).slice(-50) })
    }

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
    // Real bug found live-testing: a message can be checked WHILE STILL
    // STREAMING (no text parts yet) — marking it "mirrored" here (as this
    // code used to) meant it was permanently skipped even once it finished
    // streaming with real text moments later, since the dedup check above
    // only compares message IDs, not content. Confirmed live: a genuine
    // answer to a plain question never made it to DevSpec at all because an
    // earlier poll caught it empty and marked it done first. Do NOT persist
    // here — leave last.info.id unrecorded so the next poll re-evaluates
    // this same message once it (likely) has text. A message that is
    // permanently textless (a real pure-tool-call turn) is harmless to
    // recheck: `last` moves on naturally once a newer message exists.
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
