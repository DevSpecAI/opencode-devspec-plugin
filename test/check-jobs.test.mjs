// Check job wake shape and text (DevSpec item 55d71b0c; this plugin's item 0793170c),
// in the version-2 envelope (DevSpec item 1d89fe56).
// The delivery lane itself is exercised in canonical-poll-delivery.test.mjs.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CHECK_JOB_VERSION,
  CHECK_JOB_WAKE_KEYS,
  checkJobWakeText,
  isCheckJobWake,
  renderCheckJobTurn,
} from '../dist/check-jobs.js'
import { pollNegotiationArgs } from '../dist/remote-control.js'

const connection = '11111111-1111-4111-8111-111111111111'
const jobId = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1'
const recordId = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2'

function job(over = {}) {
  const id = over.id ?? jobId
  return {
    id,
    kind: 'check_job',
    check_job_id: id,
    check_kind: 'duplicate',
    record: { type: 'memory', id: recordId, title: 'Use rem for type sizes' },
    entries: 4,
    yours: false,
    offered_at: '2026-11-04T03:00:00.000+00:00',
    delivery_connection_id: connection,
    ...over,
  }
}

describe('check job wake shape', () => {
  it('negotiates version 2 on every poll', () => {
    assert.equal(CHECK_JOB_VERSION, 2)
    assert.equal(pollNegotiationArgs().check_job_version, 2)
  })

  it('accepts exactly the server envelope addressed to this connection', () => {
    assert.deepEqual(Object.keys(job()), [...CHECK_JOB_WAKE_KEYS])
    assert.equal(isCheckJobWake(job(), connection), true)
    for (const check_kind of ['conflict', 'conflict_decisions', 'duplicate', 'staleness']) {
      assert.equal(isCheckJobWake(job({ check_kind }), connection), true, check_kind)
    }
    for (const type of ['task', 'memory', 'artifact', 'proposal']) {
      assert.equal(isCheckJobWake(job({ record: { type, id: recordId, title: 't' } }), connection), true, type)
    }
    assert.equal(isCheckJobWake(job({ record: { type: 'task', id: recordId, title: '' } }), connection), true, 'an unset title')
  })

  it('accepts the three records version 2 adds, each only as the out-of-date check it is', () => {
    for (const type of ['discussion_point', 'goal', 'backlog_scan']) {
      assert.equal(isCheckJobWake(job({ check_kind: 'staleness', record: { type, id: recordId, title: 'Pricing page' } }), connection), true, type)
      for (const check_kind of ['conflict', 'conflict_decisions', 'duplicate']) {
        assert.equal(isCheckJobWake(job({ check_kind, record: { type, id: recordId, title: 't' } }), connection), false, `${type} as ${check_kind}`)
      }
    }
  })

  it('takes only the version-2 envelope: a job that still carries high_risk is inert', () => {
    assert.deepEqual([...CHECK_JOB_WAKE_KEYS], [
      'id', 'kind', 'check_job_id', 'check_kind', 'record', 'entries', 'yours', 'offered_at', 'delivery_connection_id',
    ])
    assert.equal(isCheckJobWake(job({ high_risk: 0 }), connection), false)
    assert.equal(isCheckJobWake(job({ high_risk: 1 }), connection), false)
  })

  it('rejects an extra or missing key, at the top or in the record', () => {
    assert.equal(isCheckJobWake({ ...job(), body: 'record text' }, connection), false)
    const { offered_at: _offered, ...missing } = job()
    assert.equal(isCheckJobWake(missing, connection), false)
    assert.equal(isCheckJobWake(job({ record: { type: 'task', id: recordId, title: 't', text: 'x' } }), connection), false)
    assert.equal(isCheckJobWake(job({ record: { type: 'task', id: recordId } }), connection), false)
  })

  it('rejects values the contract does not allow', () => {
    for (const bad of [
      job({ kind: 'automation_run' }),
      job({ check_job_id: recordId }),
      job({ id: 'not-a-uuid', check_job_id: 'not-a-uuid' }),
      job({ check_kind: 'review' }),
      job({ record: { type: 'action_item', id: recordId, title: 't' } }),
      job({ entries: -1 }),
      job({ entries: 2.5 }),
      job({ record: { type: 'outcome', id: recordId, title: 't' } }),
      job({ check_kind: 'staleness', record: { type: 'backlog_scan', id: 'scan-1', title: 't' } }),
      job({ yours: 1 }),
      job({ offered_at: 'yesterday' }),
      job({ delivery_connection_id: recordId }),
    ]) assert.equal(isCheckJobWake(bad, connection), false, JSON.stringify(bad))
    assert.equal(isCheckJobWake(job(), null), false, 'no connection to compare with')
    assert.equal(isCheckJobWake(null, connection), false)
    assert.equal(isCheckJobWake([job()], connection), false)
  })

  it('wakes with the contract line, naming the record', () => {
    assert.equal(
      checkJobWakeText(job()),
      'A check is waiting on "Use rem for type sizes": take it with claim_check_job, rule every entry with record_check_rulings, then carry on.',
    )
    assert.match(checkJobWakeText(job({ record: { type: 'artifact', id: recordId, title: '  ' } })), new RegExp(`waiting on artifact ${recordId}:`))
    const turn = renderCheckJobTurn([job(), job({ id: recordId })])
    assert.match(turn, /check jobs \(2\)/)
    assert.match(turn, new RegExp(`check_job_id=${jobId}`))
    assert.match(turn, /no answer post/)
    assert.doesNotMatch(turn, /high_risk|high risk/)
  })

  it('says what the records version 2 adds are, so the agent knows what it is ruling', () => {
    const staleness = (type, title) => job({ check_kind: 'staleness', record: { type, id: recordId, title } })
    assert.equal(
      checkJobWakeText(staleness('discussion_point', 'Drop the free tier')),
      'An out-of-date check on the settled discussion point "Drop the free tier" is waiting: take it with claim_check_job, rule every entry with record_check_rulings, then carry on.',
    )
    assert.equal(
      checkJobWakeText(staleness('goal', 'Launch in Europe')),
      'An out-of-date check on the Goal "Launch in Europe" is waiting: take it with claim_check_job, rule every entry with record_check_rulings, then carry on.',
    )
    assert.equal(
      checkJobWakeText(staleness('backlog_scan', 'Backlog scan, 7 Nov')),
      'The whole-backlog out-of-date scan "Backlog scan, 7 Nov" is waiting: take it with claim_check_job, rule every entry with record_check_rulings, then carry on.',
    )
    assert.match(checkJobWakeText(staleness('backlog_scan', '')), /^The whole-backlog out-of-date scan is waiting: /)
    assert.match(checkJobWakeText(staleness('goal', ' ')), new RegExp(`on the Goal ${recordId} is waiting:`))
    assert.match(checkJobWakeText(staleness('discussion_point', '')), new RegExp(`settled discussion point ${recordId} is waiting:`))
    const turn = renderCheckJobTurn([staleness('goal', 'Launch in Europe')])
    assert.match(turn, /record=goal:/)
    assert.match(turn, /An out-of-date check on the Goal "Launch in Europe"/)
  })
})
