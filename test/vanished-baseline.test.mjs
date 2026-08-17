#!/usr/bin/env node
/**
 * Regression (8d0f1726): vanished inject baseline must clear, not stick forever.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, after, beforeEach } from 'node:test'
import {
  clearAbandonedInjectCursor,
  decideAwaitingBaseline,
  readState,
  resetBondsForTests,
  writeState,
  runWithBondAsync,
} from '../dist/remote-control.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-devspec-baseline-'))
}


/**
 * State reads and writes are scoped to a bond now (item a72a4e22) — there is no
 * process-global to fall back on. These cases exercise the state layer itself,
 * so each runs inside one explicit test bond.
 */
// Each suite gets its own bond AND its own home: state files are keyed on the
// bond alone now, so a shared name would have these files racing each other in
// the real ~/.devspec directory. (Before the rekey the folder was part of the
// key, which isolated them by accident.)
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-vanished_baseline-home-'))
const TEST_BOND = 'ses_test_bond_vanished_baseline'
const itInBond = (name, fn) => it(name, () => runWithBondAsync(TEST_BOND, async () => fn()))

describe('decideAwaitingBaseline — vanished baseline recovery (8d0f1726)', () => {
  itInBond('still fails closed when the inject snapshot itself failed', () => {
    assert.deepEqual(
      decideAwaitingBaseline({
        baseline: 'msg_x',
        baselineCaptured: false,
        assistantIds: ['msg_a'],
      }),
      { action: 'fail_closed_snapshot' },
    )
  })

  itInBond('clears when a concrete baseline id is missing from the live session', () => {
    assert.deepEqual(
      decideAwaitingBaseline({
        baseline: 'msg_fd7f926c30015SvpQIbHzFDChC',
        baselineCaptured: true,
        assistantIds: ['msg_new_a', 'msg_new_b'],
      }),
      { action: 'clear_abandoned', baseline: 'msg_fd7f926c30015SvpQIbHzFDChC' },
    )
  })

  itInBond('waits when baseline is the latest assistant', () => {
    assert.deepEqual(
      decideAwaitingBaseline({
        baseline: 'msg_base',
        baselineCaptured: true,
        assistantIds: ['msg_older', 'msg_base'],
      }),
      { action: 'wait', baseline: 'msg_base' },
    )
  })

  itInBond('slices candidates after the baseline when newer assistants exist', () => {
    assert.deepEqual(
      decideAwaitingBaseline({
        baseline: 'msg_base',
        baselineCaptured: true,
        assistantIds: ['msg_older', 'msg_base', 'msg_answer'],
      }),
      { action: 'slice', fromIndex: 2 },
    )
  })
})

describe('clearAbandonedInjectCursor', () => {
  const dirs = []
  beforeEach(() => {
    resetBondsForTests()
  })
  after(() => {
    resetBondsForTests()
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })

  itInBond('clears awaiting/baseline/busy on disk', () => {
    const dir = tmpDir()
    dirs.push(dir)
    writeState({
      connectionId: '5aa9129e-aa63-4b80-a2ad-ad8c5e336bde',
      sessionId: '5546c769-0cc2-4eac-9bcf-ca91b14151c4',
      codename: 'Fierce Eagle',
      awaitingRemoteReply: true,
      replyAfterOpenCodeMessageId: 'msg_gone',
      replyBaselineCaptured: true,
      busy: true,
      busySince: 123,
    })

    assert.equal(clearAbandonedInjectCursor('msg_gone'), true)
    const fresh = readState()
    assert.equal(fresh?.awaitingRemoteReply, false)
    assert.equal(fresh?.replyAfterOpenCodeMessageId, null)
    assert.equal(fresh?.busy, false)
    assert.equal(fresh?.busySince, null)
  })
})
