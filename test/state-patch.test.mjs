#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { patchState, readState, runWithBondAsync, writeState } from '../dist/remote-control.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-state-patch-home-'))
const TEST_BOND = 'ses_test_bond_state_patch'
const itInBond = (name, fn) => it(name, () => runWithBondAsync(TEST_BOND, async () => fn()))

describe('patchState preserves answer correlation across concurrent poll writes', () => {
  after(() => fs.rmSync(process.env.HOME, { recursive: true, force: true }))

  itInBond('a cursor-only patch cannot roll back exact command correlation', () => {
    writeState({
      connectionId: 'd24c4f1f-72b4-4e1d-bcd0-000b1b32133c',
      sessionId: 'f3af591e-d316-40f6-a2cf-b67dd493cc97',
      codename: 'Velvet Kingfisher',
      awaitingRemoteReply: true,
      currentCommandTurnId: 'turn_exact',
      currentCommandMessageId: 'cmd_final',
      currentTurnMessageIds: ['cmd_first', 'cmd_final'],
    })

    patchState({ lastDeliveredMessageId: 'cursor_after' })

    const fresh = readState()
    assert.equal(fresh?.currentCommandTurnId, 'turn_exact')
    assert.equal(fresh?.currentCommandMessageId, 'cmd_final')
    assert.deepEqual(fresh?.currentTurnMessageIds, ['cmd_first', 'cmd_final'])
    assert.equal(fresh?.lastDeliveredMessageId, 'cursor_after')
  })
})
