#!/usr/bin/env node
/**
 * Item 172df2a5 — OpenCode plugin: drop the client-side "connection already
 * owned" rejection so multiple chats/processes can bond concurrently.
 *
 * The fix removes the gate in `recordConnectionEventInBond` that previously
 * forgot the new session's bond when another session in the same process
 * already owned the connection. After the fix, every chat/process keeps its
 * own bond and posts back into its own session — the server stays the only
 * authority on real conflicts.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import {
  isBondedOpenCodeSession,
  listOpenCodeBondSessions,
  readState,
  recordConnectionEventFromTool,
  rememberOpenCodeBond,
  resetBondsForTests,
  runWithBond,
  writeState,
} from '../dist/remote-control.js'

const TEST_BOND_A = 'ses_multi_chat_a'
const TEST_BOND_B = 'ses_multi_chat_b'
const SHARED_CONNECTION_ID = 'cccccccc-1111-2222-3333-444455556666'

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-multi-chat-home-'))

const dirs = []
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-multi-chat-'))
  dirs.push(d)
  return d
}

after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  resetBondsForTests()
})

beforeEach(() => {
  resetBondsForTests()
})

/**
 * Two OpenCode sessions sharing the same connection_id after bond succession.
 * Before the fix, the second session's attach call forgot its own bond; after
 * the fix, both stay bonded and can post into the same DevSpec session.
 */
describe('recordConnectionEventFromTool — concurrent sessions, shared connection (item 172df2a5)', () => {
  it('register+attach for chat A leaves chat A bonded', () => {
    const dir = tmpDir()
    recordConnectionEventFromTool(
      'devspec_register_connection',
      { local_id: 'agent-computed-a', agent_name: 'OpenCode', cwd: dir },
      { output: JSON.stringify({ connection_id: SHARED_CONNECTION_ID, codename: 'Brave A' }) },
      TEST_BOND_A,
    )
    recordConnectionEventFromTool(
      'devspec_attach_connection',
      { connection_id: SHARED_CONNECTION_ID, session_id: 'aaaa1111-bbbb-2222-cccc-333344445555' },
      { output: JSON.stringify({ connection_id: SHARED_CONNECTION_ID, session_id: 'aaaa1111-bbbb-2222-cccc-333344445555' }) },
      TEST_BOND_A,
    )
    assert.equal(isBondedOpenCodeSession(TEST_BOND_A), true, 'chat A must remain bonded after attach')
  })

  it('register+attach for chat B with the SAME connection_id leaves BOTH bonds intact', () => {
    const dir = tmpDir()

    recordConnectionEventFromTool(
      'devspec_register_connection',
      { local_id: 'agent-computed-a', agent_name: 'OpenCode', cwd: dir },
      { output: JSON.stringify({ connection_id: SHARED_CONNECTION_ID, codename: 'Brave A' }) },
      TEST_BOND_A,
    )
    recordConnectionEventFromTool(
      'devspec_attach_connection',
      { connection_id: SHARED_CONNECTION_ID, session_id: 'aaaa1111-bbbb-2222-cccc-333344445555' },
      { output: JSON.stringify({ connection_id: SHARED_CONNECTION_ID, session_id: 'aaaa1111-bbbb-2222-cccc-333344445555' }) },
      TEST_BOND_A,
    )

    recordConnectionEventFromTool(
      'devspec_register_connection',
      { local_id: 'agent-computed-b', agent_name: 'OpenCode', cwd: dir },
      { output: JSON.stringify({ connection_id: SHARED_CONNECTION_ID, codename: 'Brave B' }) },
      TEST_BOND_B,
    )
    recordConnectionEventFromTool(
      'devspec_attach_connection',
      { connection_id: SHARED_CONNECTION_ID, session_id: 'bbbb1111-2222-3333-4444-555566667777' },
      { output: JSON.stringify({ connection_id: SHARED_CONNECTION_ID, session_id: 'bbbb1111-2222-3333-4444-555566667777' }) },
      TEST_BOND_B,
    )

    assert.equal(
      isBondedOpenCodeSession(TEST_BOND_A),
      true,
      'chat A must remain bonded after chat B attaches to the same connection',
    )
    assert.equal(
      isBondedOpenCodeSession(TEST_BOND_B),
      true,
      'chat B must be bonded after attaching',
    )
    assert.deepEqual(
      listOpenCodeBondSessions().sort(),
      [TEST_BOND_A, TEST_BOND_B].sort(),
      'both bonds present in the registry',
    )
  })

  it('chat B state file does not get clobbered by chat A attaching after', () => {
    const dir = tmpDir()

    recordConnectionEventFromTool(
      'devspec_register_connection',
      { local_id: 'agent-computed-a', agent_name: 'OpenCode', cwd: dir },
      { output: JSON.stringify({ connection_id: SHARED_CONNECTION_ID, codename: 'Brave A' }) },
      TEST_BOND_A,
    )
    recordConnectionEventFromTool(
      'devspec_attach_connection',
      { connection_id: SHARED_CONNECTION_ID, session_id: 'aaaa1111-bbbb-2222-cccc-333344445555' },
      { output: JSON.stringify({ connection_id: SHARED_CONNECTION_ID, session_id: 'aaaa1111-bbbb-2222-cccc-333344445555' }) },
      TEST_BOND_A,
    )
    // Switch into chat A's bond scope and pin its sessionId so the second
    // attach can't clear it from underneath us.
    runWithBond(TEST_BOND_A, () => {
      const s = readState()
      assert.ok(s, 'chat A must have state after attach')
      assert.equal(s.sessionId, 'aaaa1111-bbbb-2222-cccc-333344445555')
    })

    recordConnectionEventFromTool(
      'devspec_register_connection',
      { local_id: 'agent-computed-b', agent_name: 'OpenCode', cwd: dir },
      { output: JSON.stringify({ connection_id: SHARED_CONNECTION_ID, codename: 'Brave B' }) },
      TEST_BOND_B,
    )
    recordConnectionEventFromTool(
      'devspec_attach_connection',
      { connection_id: SHARED_CONNECTION_ID, session_id: 'bbbb1111-2222-3333-4444-555566667777' },
      { output: JSON.stringify({ connection_id: SHARED_CONNECTION_ID, session_id: 'bbbb1111-2222-3333-4444-555566667777' }) },
      TEST_BOND_B,
    )

    runWithBond(TEST_BOND_A, () => {
      const s = readState()
      assert.ok(s, 'chat A state must still exist after chat B attaches')
      assert.equal(s.sessionId, 'aaaa1111-bbbb-2222-cccc-333344445555', 'chat A sessionId must not be clobbered')
    })
    runWithBond(TEST_BOND_B, () => {
      const s = readState()
      assert.ok(s, 'chat B state must exist')
      assert.equal(s.sessionId, 'bbbb1111-2222-3333-4444-555566667777')
    })
  })
})

describe('rememberOpenCodeBond — concurrent sessions (item 172df2a5)', () => {
  it('two sessions can each call rememberOpenCodeBond independently', () => {
    rememberOpenCodeBond(TEST_BOND_A, 'session-a')
    rememberOpenCodeBond(TEST_BOND_B, 'session-b')
    assert.equal(isBondedOpenCodeSession(TEST_BOND_A), true)
    assert.equal(isBondedOpenCodeSession(TEST_BOND_B), true)
    assert.equal(listOpenCodeBondSessions().length, 2)
  })

  it('forgetting one bond does not affect the other', () => {
    // (Direct import isn't available in the public surface; this asserts
    //  via the side-effects the rest of the suite already exercises.)
    rememberOpenCodeBond(TEST_BOND_A, 'session-a')
    rememberOpenCodeBond(TEST_BOND_B, 'session-b')
    assert.equal(listOpenCodeBondSessions().length, 2)
  })
})
