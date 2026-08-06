#!/usr/bin/env node
/**
 * Regression (d5efd533 / Fierce Eagle): inject awaiting on the folder-only
 * state file must survive attach rebinding to the full session UUID file.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, after, beforeEach } from 'node:test'
import {
  bindSessionState,
  mergeConnectionStates,
  readState,
  recordConnectionEventFromTool,
  resetBoundSessionIdForTests,
  writeState,
} from '../dist/remote-control.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-devspec-bind-'))
}

describe('bindSessionState — migrate inject awaiting across key flip', () => {
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

  it('preserves awaitingRemoteReply + baseline when binding folder-only → full UUID', () => {
    const dir = tmpDir()
    dirs.push(dir)
    // Cold poll / seed inject while boundSessionId is still null.
    writeState(dir, {
      connectionId: '5aa9129e-aa63-4b80-a2ad-ad8c5e336bde',
      sessionId: '5546c769-0cc2-4eac-9bcf-ca91b14151c4',
      codename: 'Fierce Eagle',
      lastMirroredMessageId: 'msg_fd7f926c30015SvpQIbHzFDChC',
      replyAfterOpenCodeMessageId: 'msg_fd7f926c30015SvpQIbHzFDChC',
      replyBaselineCaptured: true,
      awaitingRemoteReply: true,
      busy: true,
      mirroredMessageIds: ['msg_fd7f926c30015SvpQIbHzFDChC'],
      deliveredMessageIds: ['c117ffae-6ee4-44c4-a1e6-14f3963dfa8e'],
      connectMirrorSuppressed: false,
    })

    const full = '5546c769-0cc2-4eac-9bcf-ca91b14151c4'
    const next = bindSessionState(dir, full, {
      connectionId: '5aa9129e-aa63-4b80-a2ad-ad8c5e336bde',
      codename: 'Fierce Eagle',
    })

    assert.equal(next.awaitingRemoteReply, true)
    assert.equal(next.replyAfterOpenCodeMessageId, 'msg_fd7f926c30015SvpQIbHzFDChC')
    assert.equal(next.replyBaselineCaptured, true)
    assert.equal(next.busy, true)
    assert.equal(next.sessionId, full)
    assert.ok(next.mirroredMessageIds?.includes('msg_fd7f926c30015SvpQIbHzFDChC'))

    const fresh = readState(dir)
    assert.equal(fresh?.awaitingRemoteReply, true)
    assert.equal(fresh?.replyAfterOpenCodeMessageId, 'msg_fd7f926c30015SvpQIbHzFDChC')
  })

  it('recordConnectionEventFromTool(attach) migrates folder-only inject state', () => {
    const dir = tmpDir()
    dirs.push(dir)
    writeState(dir, {
      connectionId: '5aa9129e-aa63-4b80-a2ad-ad8c5e336bde',
      sessionId: null,
      codename: null,
      replyAfterOpenCodeMessageId: 'msg_baseline',
      replyBaselineCaptured: true,
      awaitingRemoteReply: true,
      busy: true,
      connectMirrorSuppressed: false,
    })

    const full = '5546c769-0cc2-4eac-9bcf-ca91b14151c4'
    recordConnectionEventFromTool(
      dir,
      'devspec_attach_connection',
      {
        connection_id: '5aa9129e-aa63-4b80-a2ad-ad8c5e336bde',
        session_id: '5546c769',
      },
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              connection_id: '5aa9129e-aa63-4b80-a2ad-ad8c5e336bde',
              session_id: full,
            }),
          },
        ],
      },
    )

    const fresh = readState(dir)
    assert.equal(fresh?.sessionId, full)
    assert.equal(fresh?.awaitingRemoteReply, true)
    assert.equal(fresh?.replyAfterOpenCodeMessageId, 'msg_baseline')
    assert.equal(fresh?.replyBaselineCaptured, true)
    assert.equal(fresh?.busy, true)
    // First bind into this session file still arms connect suppress, but
    // awaitingRemoteReply keeps shouldSkipConnectTurnMirror from claiming.
    assert.equal(fresh?.connectMirrorSuppressed, true)
  })

  it('mergeConnectionStates prefers awaiting baseline over a stale destination', () => {
    const merged = mergeConnectionStates(
      {
        connectionId: 'c1',
        sessionId: 's1',
        codename: 'A',
        awaitingRemoteReply: true,
        replyAfterOpenCodeMessageId: 'msg_baseline',
        replyBaselineCaptured: true,
        busy: true,
      },
      {
        connectionId: 'c1',
        sessionId: 's1',
        codename: null,
        lastMirroredMessageId: 'msg_old',
        awaitingRemoteReply: false,
        nonMirrorMessageIds: ['msg_connect'],
      },
    )
    assert.equal(merged?.awaitingRemoteReply, true)
    assert.equal(merged?.replyAfterOpenCodeMessageId, 'msg_baseline')
    assert.deepEqual(merged?.nonMirrorMessageIds, ['msg_connect'])
    assert.equal(merged?.busy, true)
  })
})
