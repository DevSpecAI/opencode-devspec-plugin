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
  recoverBondsFromStateFiles,
  runWithBondAsync,
  devspecSessionForBond,
  isBondedOpenCodeSession,
  wipeOpenCodeContextInPlace,
  writeState,
} from '../dist/remote-control.js'
import {
  captureConnectionCapability,
  clearConnectionCapability,
  hasConnectionCapability,
} from '../dist/manage-plan-tool.js'

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
    clearConnectionCapability()
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-wipe-home-'))
    restoreHomedir = mock.method(os, 'homedir', () => tmpHome)
    priorHome = process.env.HOME
    process.env.HOME = tmpHome
  })

  afterEach(() => {
    clearConnectionCapability()
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
        replyAfterOpenCodeMessageId: 'msg_prior',
        replyBaselineCaptured: true,
        awaitingRemoteReply: true,
        lastDeliveredMessageId: 'owner-msg-keep',
        deliveredMessageIds: ['owner-msg-keep'],
      })
    })
    rememberOpenCodeBond(oldOpenCode, devspecSession)
    captureConnectionCapability(oldOpenCode, {
      _meta: { devspec: { connection_capability: { version: 1, value: 'dvsc_wipe-test' } } },
    })

    const result = await wipeOpenCodeContextInPlace({
      client: { session: { create: async () => ({ data: { id: newOpenCode } }) } },
      directory: dir,
      opencodeSessionId: oldOpenCode,
      selectOpenCodeSession: async (sessionId) => {
        assert.equal(sessionId, newOpenCode)
        assert.equal(isBondedOpenCodeSession(oldOpenCode), true, 'old bond must remain until the TUI moves')
        assert.equal(isBondedOpenCodeSession(newOpenCode), false)
      },
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
    assert.equal(moved?.awaitingRemoteReply, false)
    assert.equal(moved?.replyAfterOpenCodeMessageId, null)

    assert.equal(devspecSessionForBond(newOpenCode), devspecSession)
    assert.deepEqual(listOpenCodeBondSessions(), [newOpenCode])
    assert.equal(hasConnectionCapability(oldOpenCode), false)
    assert.equal(hasConnectionCapability(newOpenCode), true, 'context wipe must preserve the hidden plan capability')
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
      selectOpenCodeSession: async () => {},
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

  it('writes the new session id into the wiped state file so a later module reload recovers the bond on the right key (item 7a9b7b0f)', async () => {
    const dir = tmpDir()
    dirs.push(dir)
    const devspecSession = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const oldOpenCode = 'ses_wipe_donor'
    const newOpenCode = 'ses_wipe_recipient'

    await runWithBondAsync(oldOpenCode, async () => {
      writeState({
        connectionId: 'conn-wipe-reload',
        sessionId: devspecSession,
        codename: 'Reloading Tern',
      })
    })
    rememberOpenCodeBond(oldOpenCode, devspecSession)

    await wipeOpenCodeContextInPlace({
      client: { session: { create: async () => ({ data: { id: newOpenCode } }) } },
      directory: dir,
      opencodeSessionId: oldOpenCode,
      selectOpenCodeSession: async () => {},
    })

    // The state file is keyed by `bondLocalId(opencodeSessionId)`, so its
    // content's `opencodeSessionId` MUST equal the same id — otherwise
    // `recoverBondsFromStateFiles` puts the bond back on a key that no file
    // points at. This is the round-trip that 7a9b7b0f / 42831f3e caught:
    // the wipe previously left content.opencodeSessionId = oldId while the
    // file lived at hash(newId).
    const stateFileDir = path.join(tmpHome, '.devspec', 'opencode-remote-control')
    const expectedNewHash = (await import('node:crypto'))
      .createHash('sha256')
      .update(newOpenCode)
      .digest('base64url')
      .slice(0, 32)
    const newFile = JSON.parse(
      fs.readFileSync(path.join(stateFileDir, `${expectedNewHash}.json`), 'utf8'),
    )
    assert.equal(
      newFile.opencodeSessionId,
      newOpenCode,
      'wiped state file content.opencodeSessionId must match the new id, so filename↔content alignment holds for recovery',
    )

    // A simulated plugin-module reload (in-memory map cleared) followed by the
    // recovery scanner must restore the bond on `newOpenCode` — not on
    // `oldOpenCode`, where the file no longer lives.
    resetBondsForTests()
    assert.equal(isBondedOpenCodeSession(newOpenCode), false, 'precondition: map cleared')
    const recovered = recoverBondsFromStateFiles()
    assert.ok(recovered.includes(newOpenCode), 'recovery must restore the bond on the new id')
    assert.equal(
      recovered.includes(oldOpenCode),
      false,
      'no donor file remains, so the old id must not appear in the recovered set',
    )
    assert.equal(isBondedOpenCodeSession(newOpenCode), true)
    assert.equal(
      devspecSessionForBond(newOpenCode),
      devspecSession,
      'recovered bond must still point at the original DevSpec room',
    )
  })

  it('retains the visible bond when TUI navigation fails', async () => {
    const dir = tmpDir()
    dirs.push(dir)
    const devspecSession = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const oldOpenCode = 'ses_visible'
    const newOpenCode = 'ses_invisible'

    await runWithBondAsync(oldOpenCode, async () => {
      writeState({ connectionId: 'conn-visible', sessionId: devspecSession, codename: 'Visible Bird' })
    })
    rememberOpenCodeBond(oldOpenCode, devspecSession)

    await assert.rejects(
      wipeOpenCodeContextInPlace({
        client: { session: { create: async () => ({ data: { id: newOpenCode } }) } },
        directory: dir,
        opencodeSessionId: oldOpenCode,
        selectOpenCodeSession: async () => { throw new Error('no attached TUI') },
      }),
      /no attached TUI/,
    )

    assert.equal(isBondedOpenCodeSession(oldOpenCode), true)
    assert.equal(isBondedOpenCodeSession(newOpenCode), false)
    assert.equal(
      (await runWithBondAsync(oldOpenCode, async () => readState()))?.connectionId,
      'conn-visible',
    )
    assert.equal(await runWithBondAsync(newOpenCode, async () => readState()), null)
  })
})
