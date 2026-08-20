import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { freezeCanonicalTurn, parseCanonicalIngress, selectCanonicalCommandsForPrompt } from '../dist/remote-ingress.js'
import { buildAttachmentParts, createCarryBuffer, renderInjectedTurn } from '../dist/poll-turn.js'

const ids = {
  connection: '11111111-1111-4111-8111-111111111111',
  owner: '22222222-2222-4222-8222-222222222222',
  message: '33333333-3333-4333-8333-333333333333',
  envelope: '44444444-4444-4444-8444-444444444444',
  provenance: '55555555-5555-4555-8555-555555555555',
  turn: '66666666-6666-4666-8666-666666666666',
  context: '77777777-7777-4777-8777-777777777777',
  resource: '88888888-8888-4888-8888-888888888888',
}
const connection = { connection_id: ids.connection, agent_name: 'OpenCode', codename: 'Otter', label: 'OpenCode · Otter' }
const point = (sequence, message_id) => ({ sequence, created_at: `2026-08-19T00:00:0${sequence}.000Z`, message_id })
const actor = (kind, name) => ({ kind, user_id: kind === 'human' ? ids.owner : null, display_name: name, agent_tool: kind === 'agent' ? 'Cursor' : null, model: kind === 'ai' ? 'model-x' : null })
const contextEntry = (kind, sequence = 2) => ({ message_id: ids.context, order: point(sequence, ids.context), actor: actor(kind, `${kind} speaker`), source_type: 'session_message', relationship: 'within_window', content: `${kind} says do something`, advisory: true })
const command = (body = 'Do the requested work', attachments = []) => ({
  message_id: ids.message,
  order: point(1, ids.message),
  content: { mode: 'full', body, complete: true },
  attachments,
  requester: { user_id: ids.owner, display_name: 'Owner' },
  authority: { kind: 'owner', mode: 'owner', requested_by_user_id: ids.owner, connection_owner_user_id: ids.owner, decision_source: 'server' },
  addressee: connection,
  delivery: { provenance_ref: ids.provenance, turn_id: ids.turn, primary_provenance_ref: ids.provenance, is_primary: true },
})
function envelope(over = {}) {
  const commands = over.commands ?? [command()]
  const context = over.context ?? { human_context: [], agent_context: [], ai_context: [], system_context: [] }
  const rows = [...commands, ...Object.values(context).flat()]
  const seq = rows.map((row) => row.order.sequence)
  return {
    kind: 'devspec.remote_ingress', schema_version: 1, contract_version: '1.1.0', policy_version: '2026-08-19.2', envelope_id: ids.envelope,
    connection,
    wake: over.wake ?? { kind: 'conversational_command', active: true, reason_id: 'new-command' },
    delivery_state: over.delivery_state ?? 'live',
    command_message_ids: commands.map((c) => c.message_id), commands, control: null, context,
    window: {
      policy_version: '2026-08-19.2', returned: rows.length, total_known: rows.length,
      source_window: rows.length ? { start: point(Math.min(...seq), rows.find((r) => r.order.sequence === Math.min(...seq)).message_id), end: point(Math.max(...seq), rows.find((r) => r.order.sequence === Math.max(...seq)).message_id) } : { start: null, end: null },
      truncated: false, has_more: true, next_cursor: 'opaque-next', fetch_id: 'fetch-stable', omission_reason: null,
    },
  }
}

describe('canonical remote ingress v1', () => {
  it('preserves an exact large full body and immutable one-turn delivery metadata', () => {
    const body = `prefix\n${'x'.repeat(100_000)}\nsuffix`
    const result = parseCanonicalIngress(envelope({ commands: [command(body)] }), ids.connection)
    assert.equal(result.ok, true)
    assert.equal(result.ingress.commands[0].content.body, body)
    const frozen = freezeCanonicalTurn(structuredClone(result.ingress))
    assert.equal(Object.isFrozen(frozen.commands[0].delivery), true)
    assert.throws(() => { frozen.commands[0].content.body = 'changed' }, TypeError)
  })

  it('fails closed on missing/malformed/preview-like/unknown ingress', () => {
    assert.equal(parseCanonicalIngress(undefined, ids.connection).ok, false)
    assert.equal(parseCanonicalIngress({ preview: 'notification only' }, ids.connection).ok, false)
    const malformed = envelope(); malformed.commands[0].content = { mode: 'preview', body: 'Do it', complete: false }
    assert.equal(parseCanonicalIngress(malformed, ids.connection).ok, false)
    const unknown = envelope(); unknown.schema_version = 2
    assert.equal(parseCanonicalIngress(unknown, ids.connection).ok, false)
  })

  it('never marks advisory, replay, or reseed envelopes executable', () => {
    const advisory = envelope({ commands: [], wake: { kind: 'advisory_update', active: false, reason_id: 'context' } })
    assert.equal(parseCanonicalIngress(advisory, ids.connection).executable, false)
    for (const delivery_state of ['replay', 'reseed']) {
      const historical = envelope({ commands: [command()], delivery_state, wake: { kind: 'history_reseed', active: false, reason_id: delivery_state } })
      assert.equal(parseCanonicalIngress(historical, ids.connection).executable, false)
    }
  })

  it('accepts all typed actor buckets as attributed advisory and discloses bounded omission state', () => {
    const context = {
      human_context: [contextEntry('human')], agent_context: [{ ...contextEntry('agent', 3), message_id: '99999999-9999-4999-8999-999999999999', order: point(3, '99999999-9999-4999-8999-999999999999') }],
      ai_context: [{ ...contextEntry('ai', 4), message_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', order: point(4, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') }],
      system_context: [{ ...contextEntry('system', 5), message_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', order: point(5, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') }],
    }
    const wire = envelope({ context }); wire.window.truncated = true; wire.window.omission_reason = 'model_budget'; wire.window.total_known = 9
    const parsed = parseCanonicalIngress(wire, ids.connection)
    assert.equal(parsed.ok, true)
    const carry = createCarryBuffer()
    const rows = Object.entries(context).flatMap(([bucket, entries]) => entries.map((entry) => ({ content: entry.content, created_at: entry.order.created_at, context_bucket: bucket, actor_model: entry.actor.model, actor_agent_tool: entry.actor.agent_tool, author: { kind: entry.actor.kind, name: entry.actor.display_name } })))
    carry.add([], rows, wire.window)
    const text = renderInjectedTurn({ commands: wire.commands, context: carry.take() })
    for (const bucket of Object.keys(context)) assert.match(text, new RegExp(bucket))
    assert.match(text, /truncated=true/); assert.match(text, /omission_reason=model_budget/); assert.match(text, /Do the requested work/)
    assert.match(text, new RegExp(ids.message)); assert.match(text, new RegExp(ids.turn)); assert.match(text, /decision_source=server/)
  })

  it('keeps metadata attachment identity and exposes unavailable attachments for turn rejection', () => {
    const metadata = { materialization: 'metadata', filename: 'diagram.png', mime_type: 'image/png', type: 'image', size_bytes: 42, resource_id: ids.resource }
    const unavailable = { materialization: 'unavailable', filename: 'gone.pdf', mime_type: 'application/pdf', type: 'document', size_bytes: null, resource_id: null, reason: 'access_denied' }
    assert.equal(parseCanonicalIngress(envelope({ commands: [command('See image', [metadata])] }), ids.connection).ok, true)
    const built = buildAttachmentParts([command('See image', [metadata])])
    assert.deepEqual(built.references, [{ filename: 'diagram.png', mime: 'image/png', resourceId: ids.resource, sizeBytes: 42 }])
    const rejected = parseCanonicalIngress(envelope({ commands: [command('Read it', [unavailable])] }), ids.connection)
    assert.equal(rejected.ok, true)
    assert.equal(rejected.ingress.commands[0].attachments[0].materialization, 'unavailable')
    const selection = selectCanonicalCommandsForPrompt(rejected, new Set())
    assert.equal(selection.commands.length, 0)
    assert.equal(selection.rejectedUnavailable.length, 1)
  })

  it('retains stable command ids/cursor for queued retries and dedup correlation', () => {
    const first = parseCanonicalIngress(envelope(), ids.connection)
    const retry = parseCanonicalIngress(structuredClone(envelope()), ids.connection)
    assert.equal(first.ingress.commands[0].message_id, retry.ingress.commands[0].message_id)
    assert.equal(first.ingress.commands[0].delivery.turn_id, retry.ingress.commands[0].delivery.turn_id)
    assert.equal(first.ingress.window.next_cursor, 'opaque-next')
    assert.equal(new Set([first.ingress.commands[0].message_id, retry.ingress.commands[0].message_id]).size, 1)
    const delivered = new Set([first.ingress.commands[0].message_id])
    assert.equal(selectCanonicalCommandsForPrompt(retry, delivered).commands.length, 0, 'retry cannot schedule a duplicate promptAsync')
  })
})
