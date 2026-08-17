#!/usr/bin/env node
/**
 * Regression (8718be5a): `/new` must reset OpenCode context in place — same
 * DevSpec session, same connection, driven from a blank chat.
 *
 * Rewritten for the bond rekey (a72a4e22). The state file is now keyed on the
 * OpenCode session id, so moving a bond to the fresh chat is a real transfer of
 * that file rather than a no-op. This is the ONE place a transfer legitimately
 * happens: a deliberate hand-off of one bond from a conversation to its
 * replacement, as opposed to the ambient donor-scavenging that used to run on
 * every attach and could pick up a stranger's file.
 *
 * The old version of this suite asserted the opposite invariant — "state must
 * not be keyed by OpenCode session id" — which was true of the design it was
 * written for and is exactly what this rewrite inverts.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, afterEach, after, mock } from 'node:test'
import {
  forgetOpenCodeBond,
  listOpenCodeBondSessions,
  readState,
  rememberOpenCodeBond,
  resetBondsForTests,
  runWithBondAsync,
  devspecSessionForBond,
  isBondedOpenCodeSession,
  wipeOpenCodeContextInPlace,
  writeState,
} from '../dist/remote-control.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-wipe-'))
}

describe('wipeOpenCodeContextInPlace (8718be5a + a72a4e22)', () => {
  const dirs = []
  let tmpHome
  let restoreHomedir
  let priorHome

  beforeEach(() => {
    resetBondsForTests()
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-wipe-home-'))
    restoreHomedir = mock.method(os, 'homedir', () => tmpHome)
    priorHome = process.env.HOME
    process.env.HOME = tmpHome
  })

  afterEach(() => {
    restoreHomedir?.mock?.restore?.()
    mock.restoreAll()
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
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

  it('moves the bond to the fresh chat, keeping the DevSpec session and connection', async () => {
    const dir = tmpDir()
    dirs.push(dir)
    const devspecSession = 'f9c54dad-68e0-4ff8-859f-7e3219b9b210'
    const oldOpenCode = 'ses_old_context'
    const newOpenCode = 'ses_blank_after_new'

    await runWithBondAsync(oldOpenCode, async () => {
      writeState({
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
    })
    rememberOpenCodeBond(oldOpenCode, devspecSession)

    const result = await wipeOpenCodeContextInPlace({
      client: { session: { create: async () => ({ data: { id: newOpenCode } }) } },
      directory: dir,
      opencodeSessionId: oldOpenCode,
    })

    assert.equal(result.newOpenCodeSessionId, newOpenCode)
    assert.equal(result.preservedDevspecSessionId, devspecSession)

    // The state travelled to the new chat's key, carrying the room and the
    // DevSpec delivery cursors, and dropping only OpenCode-message-scoped ones.
    const moved = await runWithBondAsync(newOpenCode, async () => readState())
    assert.equal(moved?.sessionId, devspecSession, 'DevSpec session_id must stay put')
    assert.equal(moved?.connectionId, '1cce2c8c-549c-4388-96d0-8e480b3a1ce4')
    assert.equal(moved?.codename, 'Gliding Coyote')
    assert.equal(moved?.lastDeliveredMessageId, 'owner-msg-keep')
    assert.deepEqual(moved?.deliveredMessageIds, ['owner-msg-keep'])
    assert.equal(moved?.lastMirroredMessageId, null)
    assert.equal(moved?.awaitingRemoteReply, false)
    assert.equal(moved?.replyAfterOpenCodeMessageId, null)

    assert.equal(devspecSessionForBond(newOpenCode), devspecSession)
    assert.deepEqual(listOpenCodeBondSessions(), [newOpenCode])
  })

  it('leaves the abandoned chat with no bond and no state file', async () => {
    const dir = tmpDir()
    dirs.push(dir)
    const devspecSession = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const oldOpenCode = 'ses_abandoned'
    const newOpenCode = 'ses_fresh'

    await runWithBondAsync(oldOpenCode, async () => {
      writeState({ connectionId: 'conn-1', sessionId: devspecSession, codename: 'Test Bird' })
    })
    rememberOpenCodeBond(oldOpenCode, devspecSession)

    await wipeOpenCodeContextInPlace({
      client: { session: { create: async () => ({ data: { id: newOpenCode } }) } },
      directory: dir,
      opencodeSessionId: oldOpenCode,
    })

    // The chat the owner walked away from must not be able to speak as this
    // identity afterwards — no bond, and nothing left on disk to resume from.
    assert.equal(isBondedOpenCodeSession(oldOpenCode), false)
    assert.equal(devspecSessionForBond(oldOpenCode), undefined)
    const stale = await runWithBondAsync(oldOpenCode, async () => readState())
    assert.equal(stale, null, 'the abandoned session must have no state file left')

    const live = await runWithBondAsync(newOpenCode, async () => readState())
    assert.equal(live?.sessionId, devspecSession)

    forgetOpenCodeBond(newOpenCode)
  })
})
