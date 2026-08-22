import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  ACTIVE_SESSION_PLAN_AUTHORITY_NOTE,
  parseCanonicalIngress,
  serializeActiveSessionPlans,
} from '../dist/remote-ingress.js'
import { renderInjectedTurn } from '../dist/poll-turn.js'

const ids = {
  connection: '11111111-1111-4111-8111-111111111111',
  owner: '22222222-2222-4222-8222-222222222222',
  otherOwner: '33333333-3333-4333-8333-333333333333',
  plan: '44444444-4444-4444-8444-444444444444',
  orphan: '55555555-5555-4555-8555-555555555555',
  other: '66666666-6666-4666-8666-666666666666',
  step: '77777777-7777-4777-8777-777777777777',
  otherConnection: '88888888-8888-4888-8888-888888888888',
}
const connection = { connection_id: ids.connection, agent_name: 'OpenCode', codename: 'Otter', label: 'OpenCode · Otter' }
const identity = (connection_id, agent_name = 'OpenCode') => ({ kind: 'connection', connection_id, agent_name, codename: null })
const step = (over = {}) => ({ id: ids.step, position: 1, title: 'Inspect', status: 'in_progress', ...over })
const plan = (over = {}) => ({
  id: ids.plan,
  title: 'Qualifying lifecycle',
  revision: 4,
  status: 'active',
  created_at: '2026-08-21T10:00:00.000Z',
  origin: identity(ids.connection),
  steward: identity(ids.connection),
  owner: { user_id: ids.owner, display_name: 'Owner' },
  orphaned: false,
  progress: { terminal: 0, total: 1, completed: 0, skipped: 0 },
  steps: [step()],
  ...over,
})
const projection = (plans) => ({
  version: 1,
  advisory: true,
  authority_note: ACTIVE_SESSION_PLAN_AUTHORITY_NOTE,
  inventory: { returned: plans.length, total_known: plans.length, truncated: false },
  plans,
})
function envelope(over = {}) {
  return {
    kind: 'devspec.remote_ingress', schema_version: 1,
    contract_version: over.contract_version ?? '1.3.0',
    policy_version: over.policy_version ?? '2026-08-21.1',
    envelope_id: '99999999-9999-4999-8999-999999999999', connection,
    wake: { kind: 'advisory_update', active: false, reason_id: 'snapshot' },
    delivery_state: 'live', command_message_ids: [], commands: [], control: null,
    context: { human_context: [], agent_context: [], ai_context: [], system_context: [] },
    ...(over.active_session_plans ? { active_session_plans: over.active_session_plans } : {}),
    window: {
      policy_version: over.policy_version ?? '2026-08-21.1', returned: 0, total_known: 0,
      source_window: { start: null, end: null }, truncated: false, has_more: false,
      next_cursor: null, fetch_id: null, omission_reason: null,
    },
  }
}

describe('active session plan projection v1', () => {
  it('adds zero prompt footprint when the room has no active plan', () => {
    assert.equal(serializeActiveSessionPlans(undefined, { connectionId: ids.connection }), '')
    const base = renderInjectedTurn({ commands: [{ content: 'Do the thing.' }] })
    const withAbsentProjection = renderInjectedTurn({ commands: [{ content: 'Do the thing.' }], activeSessionPlans: '' })
    assert.equal(withAbsentProjection, base)
    assert.doesNotMatch(base, /ACTIVE SESSION PLANS|Active session plans/)
  })

  it('strictly parses enhanced 1.3 while preserving scoped 1.2 compatibility', () => {
    const enhanced = parseCanonicalIngress(envelope({ active_session_plans: projection([plan()]) }), ids.connection)
    assert.equal(enhanced.ok, true)

    const scoped = envelope({ contract_version: '1.2.0', policy_version: '2026-08-19.3' })
    assert.equal(parseCanonicalIngress(scoped, ids.connection).ok, true)
    scoped.active_session_plans = projection([plan()])
    assert.equal(parseCanonicalIngress(scoped, ids.connection).ok, false, '1.2 must reject the 1.3-only field')

    const malformed = envelope({ active_session_plans: projection([plan()]) })
    malformed.active_session_plans.plans[0].unexpected = true
    assert.equal(parseCanonicalIngress(malformed, ids.connection).ok, false)
  })

  it('renders own continuation/end mechanics with exact ids and atomic advance', () => {
    const own = plan({
      progress: { terminal: 0, total: 2, completed: 0, skipped: 0 },
      steps: [step(), step({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', position: 2, title: 'Validate', status: 'pending' })],
    })
    const text = serializeActiveSessionPlans(projection([own]), { connectionId: ids.connection, ownerUserId: ids.owner })
    assert.match(text, /\[OWN\]/)
    assert.match(text, new RegExp(`plan_id=${ids.plan}.*revision=4`))
    assert.match(text, /atomic advance/)
    assert.match(text, /complete only if|complete the plan/)
    assert.match(text, /Closing the plan does not end the session/)
  })

  it('allows awareness of every room plan but only marks a same-owner orphan adoptable', () => {
    const orphan = plan({
      id: ids.orphan,
      title: 'Orphan',
      steward: identity(ids.otherConnection, 'Cursor'),
      orphaned: true,
    })
    const crossOwner = plan({
      id: ids.other,
      title: 'Other owner',
      steward: identity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Claude'),
      owner: { user_id: ids.otherOwner, display_name: 'Teammate' },
      orphaned: true,
    })
    const text = serializeActiveSessionPlans(projection([orphan, crossOwner]), {
      connectionId: ids.connection,
      ownerUserId: ids.owner,
    })
    assert.match(text, /SAME-OWNER ORPHAN — ADOPTABLE/)
    assert.match(text, new RegExp(`Adoption:.*plan_id=${ids.orphan}.*expected_revision=4`))
    assert.match(text, /OTHER OWNER — READ-ONLY/)
    assert.match(text, /do not mutate or adopt this plan/)
  })

  it('keeps the local instruction footprint concise and contract-authoritative', () => {
    const text = fs.readFileSync(path.join(process.cwd(), 'instructions/devspec.md'), 'utf8')
    assert.match(text, /devspec:\/\/product\/implementation-contract/)
    assert.match(text, /load `manage_plan` on demand with `search_devspec_tools`/)
    assert.match(text, /Routine reading.*no plan/s)
    assert.match(text, /`advance`.*atomically completes/s)
    assert.match(text, /intentional cross-plan.*`plan_id` and `expected_revision`/s)
    assert.match(text, /orphaned same-owner plan/)
    assert.ok(text.length < 4_500, `instruction footprint grew unexpectedly: ${text.length} chars`)
  })
})
