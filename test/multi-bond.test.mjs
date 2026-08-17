#!/usr/bin/env node
/**
 * Regression (7a9b7b0f / Ivory Panda): a second /devspec.remote in the same
 * OpenCode process must ADD a bond, not overwrite a single lastKnownSessionId.
 * Overwriting starved poll_connection on the first connection → idle_timeout.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import {
  forgetOpenCodeBond,
  listOpenCodeBondSessions,
  rememberOpenCodeBond,
  resetBondsForTests,
  runWithBond,
  devspecSessionForBond,
  writeState,
  readState,
} from '../dist/remote-control.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('multi-bond registry (7a9b7b0f)', () => {
  beforeEach(() => {
    resetBondsForTests()
  })

  it('second remember keeps the first bond active', () => {
    rememberOpenCodeBond('ses_ivory', 'b4fc6bbb-a9d0-4f03-83a0-e8880c70c262')
    rememberOpenCodeBond('ses_dolphin', '88d61d19-59b0-4053-8d97-c678c9595961')

    const sessions = listOpenCodeBondSessions().sort()
    assert.deepEqual(sessions, ['ses_dolphin', 'ses_ivory'])
    assert.equal(devspecSessionForBond('ses_ivory'), 'b4fc6bbb-a9d0-4f03-83a0-e8880c70c262')
    assert.equal(devspecSessionForBond('ses_dolphin'), '88d61d19-59b0-4053-8d97-c678c9595961')
  })

  it('forget removes only the ended bond', () => {
    rememberOpenCodeBond('ses_a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    rememberOpenCodeBond('ses_b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    forgetOpenCodeBond('ses_a')

    assert.deepEqual(listOpenCodeBondSessions(), ['ses_b'])
    assert.equal(devspecSessionForBond('ses_a'), undefined)
    assert.equal(devspecSessionForBond('ses_b'), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  })

  it('re-remember same OpenCode session upgrades state key (register → attach)', () => {
    rememberOpenCodeBond('ses_x', null)
    assert.equal(devspecSessionForBond('ses_x'), null)
    rememberOpenCodeBond('ses_x', 'cccccccc-cccc-cccc-cccc-cccccccccccc')
    assert.equal(devspecSessionForBond('ses_x'), 'cccccccc-cccc-cccc-cccc-cccccccccccc')
    assert.deepEqual(listOpenCodeBondSessions(), ['ses_x'])
  })

  it('runWithBond isolates state files across concurrent logical bonds', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-multibond-'))
    try {
      runWithBond('sess-one', () => {
        writeState({
          connectionId: 'conn-1',
          sessionId: 'sess-one',
          codename: 'Ivory Panda',
        })
      })
      runWithBond('sess-two', () => {
        writeState({
          connectionId: 'conn-2',
          sessionId: 'sess-two',
          codename: 'Racing Dolphin',
        })
      })

      const one = runWithBond('sess-one', () => readState())
      const two = runWithBond('sess-two', () => readState())
      assert.equal(one?.connectionId, 'conn-1')
      assert.equal(one?.codename, 'Ivory Panda')
      assert.equal(two?.connectionId, 'conn-2')
      assert.equal(two?.codename, 'Racing Dolphin')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
