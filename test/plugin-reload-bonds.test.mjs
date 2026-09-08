#!/usr/bin/env node
/**
 * Item dd722e4c — survive plugin-module reload without stranding live bonds.
 *
 * The on-disk state files now persist `opencodeSessionId` (item dd722e4c), and
 * `recoverBondsFromStateFiles()` re-attachs every recorded bond into the
 * in-memory `openCodeBonds` Map. This test simulates a module reload by
 * clearing the Map with `resetBondsForTests()` and then calling the recovery
 * function on the same state directory.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import {
  isBondedOpenCodeSession,
  listOpenCodeBondSessions,
  readState,
  recoverBondsFromStateFiles,
  rememberOpenCodeBond,
  resetBondsForTests,
  runWithBond,
  writeState,
} from '../dist/remote-control.js'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-reload-bonds-home-'))

const TEST_BOND_A = 'ses_reload_a'
const TEST_BOND_B = 'ses_reload_b'
const TEST_BOND_NOID = 'ses_reload_noid'

after(() => {
  resetBondsForTests()
})

before(() => {
  fs.mkdirSync(path.join(os.homedir(), '.devspec', 'opencode-remote-control'), {
    recursive: true,
  })
})

beforeEach(() => {
  resetBondsForTests()
  // Clean any leftover state files from prior runs.
  const dir = path.join(os.homedir(), '.devspec', 'opencode-remote-control')
  for (const entry of fs.readdirSync(dir)) {
    if (entry.endsWith('.json')) {
      try { fs.unlinkSync(path.join(dir, entry)) } catch { /* ignore */ }
    }
  }
})

function seedStateWithSessionId(opencodeSessionId, connectionId, sessionId) {
  runWithBond(opencodeSessionId, () => {
    writeState({
      connectionId,
      sessionId,
      codename: 'Reload Test',
      opencodeSessionId,
      busy: false,
    })
  })
  rememberOpenCodeBond(opencodeSessionId, sessionId)
}

describe('recoverBondsFromStateFiles (item dd722e4c)', () => {
  it('is a no-op when the directory has no state files', () => {
    const recovered = recoverBondsFromStateFiles()
    assert.deepEqual(recovered, [])
    assert.equal(listOpenCodeBondSessions().length, 0)
  })

  it('restores a single bond after the in-memory map is cleared (simulated module reload)', () => {
    seedStateWithSessionId(TEST_BOND_A, 'conn-aaaa', 'sess-aaaa')

    // The bond IS registered in memory at this point. Simulate a module
    // reload by clearing the in-memory map WITHOUT touching disk.
    resetBondsForTests()
    assert.equal(isBondedOpenCodeSession(TEST_BOND_A), false, 'precondition: map is empty')

    // Recovery re-attaches every bond on disk into the in-memory map.
    const recovered = recoverBondsFromStateFiles()
    assert.deepEqual(recovered, [TEST_BOND_A])
    assert.equal(isBondedOpenCodeSession(TEST_BOND_A), true)
    assert.deepEqual(listOpenCodeBondSessions(), [TEST_BOND_A])

    // State is still readable — the recovery did not corrupt anything.
    const after = runWithBond(TEST_BOND_A, () => readState())
    // readState uses currentBondSessionId() which needs runWithBond scope.
    // After recovery, openCodeBonds has TEST_BOND_A, so we can read state.
    assert.ok(after)
    assert.equal(after.connectionId, 'conn-aaaa')
    assert.equal(after.sessionId, 'sess-aaaa')
  })

  it('restores multiple bonds in a single recovery pass', () => {
    seedStateWithSessionId(TEST_BOND_A, 'conn-aaaa', 'sess-aaaa')
    seedStateWithSessionId(TEST_BOND_B, 'conn-bbbb', 'sess-bbbb')
    assert.equal(listOpenCodeBondSessions().length, 2)

    resetBondsForTests()
    assert.equal(listOpenCodeBondSessions().length, 0)

    const recovered = recoverBondsFromStateFiles()
    assert.equal(recovered.length, 2)
    assert.ok(recovered.includes(TEST_BOND_A))
    assert.ok(recovered.includes(TEST_BOND_B))
    assert.equal(isBondedOpenCodeSession(TEST_BOND_A), true)
    assert.equal(isBondedOpenCodeSession(TEST_BOND_B), true)
  })

  it('is a no-op for state files written before dd722e4c (no opencodeSessionId field)', () => {
    // Simulate a pre-fix state file: write JSON without the opencodeSessionId
    // field by hand, mimicking what older plugin versions wrote.
    const dir = path.join(os.homedir(), '.devspec', 'opencode-remote-control')
    const filename = 'pre-fix-state.json'
    fs.writeFileSync(
      path.join(dir, filename),
      JSON.stringify({
        connectionId: 'conn-legacy',
        sessionId: 'sess-legacy',
        codename: 'Legacy',
        busy: false,
      }),
    )

    const recovered = recoverBondsFromStateFiles()
    assert.deepEqual(recovered, [], 'legacy state file is skipped — it has no session id to recover')
    assert.equal(listOpenCodeBondSessions().length, 0)
  })

  it('recovers the bond even when the live plugin has not seen it since reload', () => {
    // This is the exact Brave Lizard 2026-09-08 scenario: one process registered
    // the connection, the module reloaded (Map cleared), and the new module
    // calls recoverBondsFromStateFiles on startup.
    seedStateWithSessionId(TEST_BOND_A, 'conn-brave-lizard', 'sess-brave-lizard')
    resetBondsForTests() // simulate module reload

    // No agent activity since reload — just the recovery on pump start.
    const recovered = recoverBondsFromStateFiles()
    assert.deepEqual(recovered, [TEST_BOND_A])
    assert.equal(isBondedOpenCodeSession(TEST_BOND_A), true)
  })
})
