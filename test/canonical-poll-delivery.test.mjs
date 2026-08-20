import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  bondLocalId,
  forgetOpenCodeBond,
  forgetPumpState,
  pollAndDeliver,
  readState,
  rememberOpenCodeBond,
  runWithBond,
  runWithBondAsync,
  writeState,
} from '../dist/remote-control.js'

const connectionId = '11111111-1111-4111-8111-111111111111'
const devspecSessionId = '22222222-2222-4222-8222-222222222222'
const ownerId = '33333333-3333-4333-8333-333333333333'
const turnId = '44444444-4444-4444-8444-444444444444'
const provenance1 = '55555555-5555-4555-8555-555555555555'
const provenance2 = '66666666-6666-4666-8666-666666666666'
const message1 = '77777777-7777-4777-8777-777777777777'
const message2 = '88888888-8888-4888-8888-888888888888'
const controlId = '99999999-9999-4999-8999-999999999999'
const opencodeSessionId = `canonical-poll-${process.pid}-${Math.random()}`
const connection = { connection_id: connectionId, agent_name: 'OpenCode', codename: 'Otter', label: 'OpenCode · Otter' }
const point = (sequence, message_id) => ({ sequence, created_at: `2026-08-20T12:00:0${sequence}.000Z`, message_id })
const command = (message_id, sequence, provenance, body, primary) => ({
  message_id,
  order: point(sequence, message_id),
  content: { mode: 'full', body, complete: true },
  attachments: [],
  requester: { user_id: ownerId, display_name: 'Owner' },
  authority: { kind: 'owner', mode: 'owner', requested_by_user_id: ownerId, connection_owner_user_id: ownerId, decision_source: 'server' },
  addressee: connection,
  delivery: { provenance_ref: provenance, turn_id: turnId, primary_provenance_ref: provenance1, is_primary: primary },
})
function ingress(commands = [], over = {}) {
  const context = { human_context: [], agent_context: [], ai_context: [], system_context: [] }
  const rows = [...commands]
  return {
    kind: 'devspec.remote_ingress', schema_version: 1, contract_version: '1.1.0', policy_version: '2026-08-19.2',
    envelope_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', connection,
    wake: over.wake ?? (commands.length ? { kind: 'conversational_command', active: true, reason_id: 'command' } : { kind: 'advisory_update', active: false, reason_id: 'context' }),
    delivery_state: over.delivery_state ?? 'live', command_message_ids: commands.map((row) => row.message_id), commands,
    control: over.control ?? null, context,
    window: {
      policy_version: '2026-08-19.2', returned: rows.length, total_known: rows.length,
      source_window: rows.length ? { start: rows[0].order, end: rows.at(-1).order } : { start: null, end: null },
      truncated: over.truncated ?? false, has_more: over.has_more ?? false,
      next_cursor: over.next_cursor ?? null, fetch_id: over.fetch_id ?? null,
      omission_reason: over.omission_reason ?? null,
    },
  }
}
function changed(payload = {}) {
  return {
    connection_id: connectionId, session_id: devspecSessionId, changed: true,
    cursor_v2: 'live-v2-next', dispatch_cursor: 'dispatch-next', dispatches: [],
    ingress: ingress(), ...payload,
  }
}
function mcpResponse(value) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
}

let originalFetch
let originalToken
let originalUrl
let calls
let pollResults
let promptCalls
let promptImpl
let abortCalls
let summarizeCalls
let reloadCalls

function clientDouble() {
  return {
    session: {
      messages: async () => ({ data: [] }),
      promptAsync: async (args) => { promptCalls.push(args); return promptImpl(args) },
      abort: async () => { abortCalls++; return { data: true } },
      summarize: async () => { summarizeCalls++; return { data: true } },
    },
    config: { providers: async () => ({ data: { providers: [], default: {} } }) },
    instance: { dispose: async () => { reloadCalls++; return { data: true } } },
    tui: { executeCommand: async () => ({ data: true }) },
  }
}
function statePath() {
  return path.join(os.homedir(), '.devspec', 'opencode-remote-control', `${bondLocalId(opencodeSessionId)}.json`)
}
async function tick(client = clientDouble()) {
  return runWithBondAsync(opencodeSessionId, () => pollAndDeliver(client, process.cwd(), opencodeSessionId))
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 25))
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalToken = process.env.DEVSPEC_MCP_TOKEN
  originalUrl = process.env.DEVSPEC_MCP_URL
  process.env.DEVSPEC_MCP_TOKEN = 'test-token'
  process.env.DEVSPEC_MCP_URL = 'https://example.test/mcp'
  calls = []
  pollResults = []
  promptCalls = []
  promptImpl = async () => ({ data: true })
  abortCalls = 0
  summarizeCalls = 0
  reloadCalls = 0
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.params)
    if (body.params.name === 'poll_connection' && !body.params.arguments.control_ack) {
      return mcpResponse(pollResults.shift() ?? { connection_id: connectionId, session_id: devspecSessionId, changed: false, cursor_v2: null, dispatch_cursor: null })
    }
    return mcpResponse({ ok: true, changed: false })
  }
  rememberOpenCodeBond(opencodeSessionId, devspecSessionId)
  runWithBond(opencodeSessionId, () => writeState({ connectionId, sessionId: devspecSessionId, codename: 'Otter', busy: false }))
  forgetPumpState(connectionId)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.DEVSPEC_MCP_TOKEN
  else process.env.DEVSPEC_MCP_TOKEN = originalToken
  if (originalUrl === undefined) delete process.env.DEVSPEC_MCP_URL
  else process.env.DEVSPEC_MCP_URL = originalUrl
  forgetPumpState(connectionId)
  forgetOpenCodeBond(opencodeSessionId)
  fs.rmSync(statePath(), { force: true })
})

describe('pollAndDeliver canonical transaction integration', () => {
  it('keeps live/catch-up cursors and ids uncommitted until promptAsync accepts, then commits each cursor separately', async () => {
    const cmd = command(message1, 1, provenance1, 'full body', true)
    pollResults.push(changed({ ingress: ingress([cmd], { has_more: true, next_cursor: 'older-page', truncated: true, fetch_id: 'fetch-1', omission_reason: 'history_before_window' }) }))
    let accept
    promptImpl = () => new Promise((resolve) => { accept = resolve })
    await tick()
    let state = runWithBond(opencodeSessionId, () => readState())
    assert.equal(state.remoteIngressCursorV2 ?? null, null)
    assert.equal(state.remoteIngressCatchUpCursor ?? null, null)
    assert.deepEqual(state.deliveredMessageIds ?? [], [])

    // The serial pump may re-enter before the SDK queue promise settles. The
    // repeated server envelope must not schedule a second promptAsync.
    pollResults.push(changed({ ingress: ingress([cmd], { has_more: true, next_cursor: 'older-page', truncated: true, fetch_id: 'fetch-1', omission_reason: 'history_before_window' }) }))
    await tick()
    assert.equal(promptCalls.length, 1)

    accept({ data: true })
    await settle()
    state = runWithBond(opencodeSessionId, () => readState())
    assert.equal(state.remoteIngressCursorV2, 'live-v2-next')
    assert.equal(state.remoteIngressCatchUpCursor, 'older-page')
    assert.deepEqual(state.deliveredMessageIds, [message1])

    pollResults.push({ connection_id: connectionId, session_id: devspecSessionId, changed: false, cursor_v2: 'live-v2-next', dispatch_cursor: 'dispatch-next' })
    await tick()
    const poll = calls.filter((call) => call.name === 'poll_connection' && !call.arguments.control_ack).at(-1)
    assert.equal(poll.arguments.cursor_v2, 'live-v2-next')
    assert.equal(poll.arguments.catch_up_cursor, 'older-page')
    assert.equal(poll.arguments.catch_up, true)
    assert.notEqual(poll.arguments.cursor_v2, poll.arguments.catch_up_cursor)
  })

  it('rolls back mechanically when promptAsync rejects and retries the whole immutable turn once', async () => {
    const cmd = command(message1, 1, provenance1, 'retry me', true)
    const response = changed({ ingress: ingress([cmd]) })
    pollResults.push(response)
    promptImpl = async () => ({ error: { message: 'queue rejected' } })
    await tick()
    await settle()
    let state = runWithBond(opencodeSessionId, () => readState())
    assert.equal(state.remoteIngressCursorV2 ?? null, null)
    assert.deepEqual(state.deliveredMessageIds ?? [], [])

    pollResults.push(structuredClone(response))
    promptImpl = async () => ({ data: true })
    await tick()
    await settle()
    state = runWithBond(opencodeSessionId, () => readState())
    assert.equal(promptCalls.length, 2)
    assert.deepEqual(state.deliveredMessageIds, [message1])
    assert.equal(state.remoteIngressCursorV2, 'live-v2-next')
  })

  it('treats partial multi-command dedupe as an atomic delivered turn and never prompts the suffix', async () => {
    const commands = [
      command(message1, 1, provenance1, 'first', true),
      command(message2, 2, provenance2, 'second', false),
    ]
    runWithBond(opencodeSessionId, () => writeState({ connectionId, sessionId: devspecSessionId, codename: 'Otter', busy: false, deliveredMessageIds: [message1] }))
    pollResults.push(changed({ ingress: ingress(commands) }))
    await tick()
    const state = runWithBond(opencodeSessionId, () => readState())
    assert.equal(promptCalls.length, 0)
    assert.deepEqual(state.deliveredMessageIds, [message1, message2])
    assert.equal(state.remoteIngressCursorV2, 'live-v2-next')
  })

  it('delivers only explicit playbook_run dispatches through playbook text and advances dispatch_cursor after acceptance', async () => {
    pollResults.push(changed({
      dispatches: [
        { id: 'play-1', kind: 'playbook_run', run_id: 'run-1', playbook_name: 'Review', permission: 'look_only', instruction: 'Inspect only.' },
        { id: 'assignment-1', kind: 'assignment', instruction: 'must remain inert' },
      ],
    }))
    await tick()
    await settle()
    assert.equal(promptCalls.length, 1)
    const text = promptCalls[0].body.parts[0].text
    assert.match(text, /claim_playbook_run/)
    assert.match(text, /LOOK ONLY/)
    assert.doesNotMatch(text, /must remain inert/)
    const state = runWithBond(opencodeSessionId, () => readState())
    assert.deepEqual(state.deliveredAssignmentIds, ['play-1'])
    assert.equal(state.remoteDispatchCursor, 'dispatch-next')
  })

  it('applies typed model/thinking controls to later prompts and returns list_models catalog with its ack', async () => {
    const modelControl = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', verb: 'set_model', issued_at: '2026-08-20T12:00:00.000Z', issued_by_user_id: ownerId, args: { model: 'anthropic/claude-test' } }
    pollResults.push(changed({ ingress: ingress([], { wake: { kind: 'control', active: true, reason_id: 'owner_control' }, control: modelControl }) }))
    await tick(); await settle()

    const compactControl = { id: 'abababab-abab-4bab-8bab-abababababab', verb: 'compact', issued_at: '2026-08-20T12:00:00.500Z', issued_by_user_id: ownerId }
    pollResults.push(changed({ ingress: ingress([], { wake: { kind: 'control', active: true, reason_id: 'owner_control' }, control: compactControl }) }))
    await tick(); await settle()
    assert.equal(summarizeCalls, 1)

    const reloadControl = { id: 'acacacac-acac-4cac-8cac-acacacacacac', verb: 'reload', issued_at: '2026-08-20T12:00:00.750Z', issued_by_user_id: ownerId }
    pollResults.push(changed({ ingress: ingress([], { wake: { kind: 'control', active: true, reason_id: 'owner_control' }, control: reloadControl }) }))
    await tick(); await settle()
    assert.equal(reloadCalls, 1)

    const thinkingControl = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', verb: 'set_thinking', issued_at: '2026-08-20T12:00:01.000Z', issued_by_user_id: ownerId, args: { thinking: 'high' } }
    pollResults.push(changed({ ingress: ingress([], { wake: { kind: 'control', active: true, reason_id: 'owner_control' }, control: thinkingControl }) }))
    await tick(); await settle()

    const cmd = command(message1, 1, provenance1, 'use selected controls', true)
    pollResults.push(changed({ cursor_v2: 'after-controlled-prompt', ingress: ingress([cmd]) }))
    await tick(); await settle()
    assert.deepEqual(promptCalls[0].body.model, { providerID: 'anthropic', modelID: 'claude-test' })
    assert.equal(promptCalls[0].body.variant, 'high')

    const listId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const listControl = { id: listId, verb: 'list_models', issued_at: '2026-08-20T12:00:02.000Z', issued_by_user_id: ownerId }
    const client = clientDouble()
    client.config.providers = async () => ({ data: { providers: [{ id: 'anthropic', models: { 'claude-test': { name: 'Claude Test' } } }], default: {} } })
    pollResults.push(changed({ ingress: ingress([], { wake: { kind: 'control', active: true, reason_id: 'owner_control' }, control: listControl }) }))
    await tick(client); await settle()
    const ack = calls.find((call) => call.name === 'poll_connection' && call.arguments.control_ack === listId)
    assert.deepEqual(ack.arguments.model_catalog.models, [{ provider: 'anthropic', id: 'claude-test', name: 'Claude Test' }])
    assert.equal(ack.arguments.model_catalog.current, 'anthropic/claude-test')
  })

  it('does not acknowledge a typed control when the deterministic host action fails', async () => {
    const control = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', verb: 'abort', issued_at: '2026-08-20T12:00:00.000Z', issued_by_user_id: ownerId }
    const client = clientDouble()
    client.session.abort = async () => { throw new Error('host refused') }
    pollResults.push(changed({ ingress: ingress([], { wake: { kind: 'control', active: true, reason_id: 'owner_control' }, control }) }))
    await tick(client); await settle()
    assert.equal(calls.some((call) => call.arguments.control_ack === control.id), false)
    const state = runWithBond(opencodeSessionId, () => readState())
    assert.equal((state.executedControlIds ?? []).includes(control.id), false)
  })

  it('executes canonical controls and acknowledges only after host execution; slash bodies remain prompts', async () => {
    const control = { id: controlId, verb: 'abort', issued_at: '2026-08-20T12:00:00.000Z', issued_by_user_id: ownerId }
    pollResults.push(changed({ ingress: ingress([], { wake: { kind: 'control', active: true, reason_id: 'owner_control' }, control }) }))
    await tick()
    await settle()
    assert.equal(abortCalls, 1)
    const ack = calls.find((call) => call.name === 'poll_connection' && call.arguments.control_ack === controlId)
    assert.ok(ack, 'control ack must be sent after execution')
    assert.equal(promptCalls.length, 0)

    const slash = command(message1, 1, provenance1, '/abort', true)
    pollResults.push(changed({ cursor_v2: 'live-after-slash', ingress: ingress([slash]) }))
    await tick()
    await settle()
    assert.equal(abortCalls, 1, 'conversational slash must not enter control path')
    assert.equal(promptCalls.length, 1)
    assert.match(promptCalls[0].body.parts[0].text, /\/abort/)
  })
})
