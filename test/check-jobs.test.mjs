// Check job wake shape and text (DevSpec item 55d71b0c; this plugin's item 0793170c).
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
    high_risk: 0,
    yours: false,
    offered_at: '2026-11-04T03:00:00.000+00:00',
    delivery_connection_id: connection,
    ...over,
  }
}

describe('check job wake shape', () => {
  it('negotiates version 1 on every poll', () => {
    assert.equal(CHECK_JOB_VERSION, 1)
    assert.equal(pollNegotiationArgs().check_job_version, 1)
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
      job({ high_risk: 5 }),
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
  })
})
