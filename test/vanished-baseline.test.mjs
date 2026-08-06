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
  resetBoundSessionIdForTests,
  writeState,
} from '../dist/remote-control.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-devspec-baseline-'))
}

describe('decideAwaitingBaseline — vanished baseline recovery (8d0f1726)', () => {
  it('still fails closed when the inject snapshot itself failed', () => {
    assert.deepEqual(
      decideAwaitingBaseline({
        baseline: 'msg_x',
        baselineCaptured: false,
        assistantIds: ['msg_a'],
      }),
      { action: 'fail_closed_snapshot' },
    )
  })

  it('clears when a concrete baseline id is missing from the live session', () => {
    assert.deepEqual(
      decideAwaitingBaseline({
        baseline: 'msg_fd7f926c30015SvpQIbHzFDChC',
        baselineCaptured: true,
        assistantIds: ['msg_new_a', 'msg_new_b'],
      }),
      { action: 'clear_abandoned', baseline: 'msg_fd7f926c30015SvpQIbHzFDChC' },
    )
  })

  it('waits when baseline is the latest assistant', () => {
    assert.deepEqual(
      decideAwaitingBaseline({
        baseline: 'msg_base',
        baselineCaptured: true,
        assistantIds: ['msg_older', 'msg_base'],
      }),
      { action: 'wait', baseline: 'msg_base' },
    )
  })

  it('slices candidates after the baseline when newer assistants exist', () => {
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
    resetBoundSessionIdForTests()
  })
  after(() => {
    resetBoundSessionIdForTests()
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })

  it('clears awaiting/baseline/busy on disk', () => {
    const dir = tmpDir()
    dirs.push(dir)
    writeState(dir, {
      connectionId: '5aa9129e-aa63-4b80-a2ad-ad8c5e336bde',
      sessionId: '5546c769-0cc2-4eac-9bcf-ca91b14151c4',
      codename: 'Fierce Eagle',
      awaitingRemoteReply: true,
      replyAfterOpenCodeMessageId: 'msg_gone',
      replyBaselineCaptured: true,
      busy: true,
      busySince: 123,
    })

    assert.equal(clearAbandonedInjectCursor(dir, 'msg_gone'), true)
    const fresh = readState(dir)
    assert.equal(fresh?.awaitingRemoteReply, false)
    assert.equal(fresh?.replyAfterOpenCodeMessageId, null)
    assert.equal(fresh?.busy, false)
    assert.equal(fresh?.busySince, null)
  })
})
