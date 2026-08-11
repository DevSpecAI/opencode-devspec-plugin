#!/usr/bin/env node
/**
 * Regression (8718be5a): /new must reset OpenCode context in place —
 * same DevSpec session_id, no bindSessionState onto the OpenCode id.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, after } from 'node:test'
import {
  forgetOpenCodeBond,
  listOpenCodeBondSessions,
  readState,
  rememberOpenCodeBond,
  resetBoundSessionIdForTests,
  runWithBoundSessionAsync,
  stateKeyForOpenCodeBond,
  wipeOpenCodeContextInPlace,
  writeState,
} from '../dist/remote-control.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-wipe-'))
}

describe('wipeOpenCodeContextInPlace (8718be5a)', () => {
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

  it('rebonds to a fresh OpenCode session without changing DevSpec sessionId', async () => {
    const dir = tmpDir()
    dirs.push(dir)
    const devspecSession = 'f9c54dad-68e0-4ff8-859f-7e3219b9b210'
    const oldOpenCode = 'ses_old_context'
    const newOpenCode = 'ses_blank_after_new'

    await runWithBoundSessionAsync(devspecSession, async () => {
      writeState(dir, {
        connectionId: '1cce2c8c-549c-4388-96d0-8e480b3a1ce4',
        sessionId: devspecSession,
        codename: 'Gliding Coyote',
        lastMirroredMessageId: 'msg_prior',
        replyAfterOpenCodeMessageId: 'msg_prior',
        replyBaselineCaptured: true,
        awaitingRemoteReply: true,
        lastDeliveredMessageId: 'owner-msg-keep',
        deliveredMessageIds: ['owner-msg-keep'],
      })
      rememberOpenCodeBond(oldOpenCode, devspecSession)

      const client = {
        session: {
          create: async () => ({ data: { id: newOpenCode } }),
        },
      }

      const result = await wipeOpenCodeContextInPlace({
        client,
        directory: dir,
        opencodeSessionId: oldOpenCode,
      })

      assert.equal(result.newOpenCodeSessionId, newOpenCode)
      assert.equal(result.preservedDevspecSessionId, devspecSession)

      const state = readState(dir)
      assert.equal(state?.sessionId, devspecSession, 'DevSpec session_id must stay put')
      assert.equal(state?.connectionId, '1cce2c8c-549c-4388-96d0-8e480b3a1ce4')
      assert.equal(state?.lastDeliveredMessageId, 'owner-msg-keep')
      assert.deepEqual(state?.deliveredMessageIds, ['owner-msg-keep'])
      assert.equal(state?.lastMirroredMessageId, null)
      assert.equal(state?.awaitingRemoteReply, false)
      assert.equal(state?.replyAfterOpenCodeMessageId, null)

      assert.equal(stateKeyForOpenCodeBond(oldOpenCode), undefined)
      assert.equal(stateKeyForOpenCodeBond(newOpenCode), devspecSession)
      assert.deepEqual(listOpenCodeBondSessions(), [newOpenCode])
    })
  })

  it('does not treat the OpenCode id as a DevSpec state-file key', async () => {
    const dir = tmpDir()
    dirs.push(dir)
    const devspecSession = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const oldOpenCode = 'ses_should_not_become_state_key'
    const newOpenCode = 'ses_fresh'

    await runWithBoundSessionAsync(devspecSession, async () => {
      writeState(dir, {
        connectionId: 'conn-1',
        sessionId: devspecSession,
        codename: 'Test Bird',
      })
      rememberOpenCodeBond(oldOpenCode, devspecSession)

      await wipeOpenCodeContextInPlace({
        client: {
          session: {
            create: async () => ({ data: { id: newOpenCode } }),
          },
        },
        directory: dir,
        opencodeSessionId: oldOpenCode,
      })

      // Reading under the OpenCode id must NOT find the connection state
      // (that was the bindSessionState(directory, newId) failure mode).
      const wronglyKeyed = await runWithBoundSessionAsync(newOpenCode, async () =>
        readState(dir),
      )
      assert.equal(
        wronglyKeyed?.sessionId ?? null,
        null,
        'state must not be keyed by OpenCode session id',
      )

      const correctlyKeyed = await runWithBoundSessionAsync(devspecSession, async () =>
        readState(dir),
      )
      assert.equal(correctlyKeyed?.sessionId, devspecSession)
    })

    forgetOpenCodeBond(newOpenCode)
  })
})
