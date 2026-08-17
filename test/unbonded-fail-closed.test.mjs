#!/usr/bin/env node
/**
 * Regression (item 2a5d212b): an OpenCode session with NO DevSpec bond must be
 * completely inert — no mirror, no trail, no client call, no state write.
 *
 * Live failure, 2026-08-17, DevSpec session 8fd18ec0: an unbonded `@explore`
 * child (`ses_fef87a…`) produced 3,886 tokens of internal handoff material, and
 * on its `session.idle` the plugin published that text into the room under
 * bonded connection 7695c4dc / "Drifting Mongoose". The cause was
 * an unbonded session resolving to 'no bond' and both `mirrorNow` and
 * `postWorkTrail` reading that as "fall back to the process-global bind"
 * instead of "refuse".
 *
 * The fixture is a fully live bonded connection in the same process, so the
 * unbonded session has something real to leak INTO. A test whose bonded state
 * was empty would pass against the bug for the wrong reason.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import {
  forgetOpenCodeBond,
  mirrorNow,
  postWorkTrail,
  rememberOpenCodeBond,
  resetBondsForTests,
  runWithBond,
  writeState,
} from '../dist/remote-control.js'

const BONDED_OPENCODE_SESSION = 'ses_parent_bonded'
const EXPLORE_CHILD_SESSION = 'ses_fef87a_explore_child'
const UNRELATED_SIBLING_SESSION = 'ses_unrelated_sibling'

/**
 * Records every call the plugin makes into OpenCode. `session.messages` is the
 * first thing both mirror and trail reach for, so "was it called" is the exact
 * observable for "did this unbonded session start speaking".
 */
function recordingClient() {
  const calls = []
  return {
    calls,
    session: {
      messages: async (args) => {
        calls.push(`session.messages:${args?.path?.id}`)
        return { data: [] }
      },
      promptAsync: async () => {
        calls.push('session.promptAsync')
        return {}
      },
    },
  }
}

/** A fully live bonded connection, as it sits on disk mid-turn. */
function liveState(overrides = {}) {
  return {
    connectionId: '7695c4dc-872e-48b2-92ea-6ca86e7c72bd',
    sessionId: '8fd18ec0-2a4f-4242-8172-1c76e06a3b8e',
    codename: 'Drifting Mongoose',
    busy: true,
    awaitingRemoteReply: true,
    deliveredMessageIds: [],
    mirroredMessageIds: [],
    recentPostedContentHashes: [],
    ...overrides,
  }
}

describe('unbonded OpenCode sessions are inert (2a5d212b)', () => {
  let tmpHome
  let projectDir
  let restoreHomedir
  let priorHome
  let priorToken
  let priorUrl

  beforeEach(() => {
    resetBondsForTests()
    forgetOpenCodeBond(BONDED_OPENCODE_SESSION)
    forgetOpenCodeBond(EXPLORE_CHILD_SESSION)
    forgetOpenCodeBond(UNRELATED_SIBLING_SESSION)

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-unbonded-home-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-unbonded-proj-'))
    // State files and the auth resolver's global-config probe both hang off the
    // home directory — point both at a temp root so this test never reads or
    // writes the real machine's remote-control state.
    restoreHomedir = mock.method(os, 'homedir', () => tmpHome)
    priorHome = process.env.HOME
    priorToken = process.env.DEVSPEC_MCP_TOKEN
    priorUrl = process.env.DEVSPEC_MCP_URL
    process.env.HOME = tmpHome
    // Auth must RESOLVE for this test to mean anything: the point is that the
    // bond gate stops an unbonded session that could otherwise have posted.
    process.env.DEVSPEC_MCP_TOKEN = 'dvs_test_token_not_a_real_credential'
    process.env.DEVSPEC_MCP_URL = 'http://127.0.0.1:9/api/mcp'

    // The bonded parent, keyed folder-only — the live shape from 8fd18ec0.
    rememberOpenCodeBond(BONDED_OPENCODE_SESSION, '8fd18ec0-2a4f-4242-8172-1c76e06a3b8e')
    runWithBond(BONDED_OPENCODE_SESSION, () => {
      writeState(liveState())
    })
  })

  afterEach(() => {
    restoreHomedir?.mock?.restore?.()
    mock.restoreAll()
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    if (priorToken === undefined) delete process.env.DEVSPEC_MCP_TOKEN
    else process.env.DEVSPEC_MCP_TOKEN = priorToken
    if (priorUrl === undefined) delete process.env.DEVSPEC_MCP_URL
    else process.env.DEVSPEC_MCP_URL = priorUrl
    forgetOpenCodeBond(BONDED_OPENCODE_SESSION)
    resetBondsForTests()
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it('an unbonded @explore child never mirrors, even with a live bonded connection in scope', async () => {
    const client = recordingClient()
    await mirrorNow(client, projectDir, EXPLORE_CHILD_SESSION, { force: true })
    assert.deepEqual(
      client.calls,
      [],
      'the child session must not be read or published — this is the 3,886-token leak',
    )
  })

  it('an unbonded @explore child never opens a work trail', async () => {
    const client = recordingClient()
    await postWorkTrail(client, projectDir, EXPLORE_CHILD_SESSION, { force: true })
    assert.deepEqual(client.calls, [], 'a child session is not the trail of any remote turn')
  })

  it('an unrelated unbonded top-level sibling is inert on both paths', async () => {
    const client = recordingClient()
    await mirrorNow(client, projectDir, UNRELATED_SIBLING_SESSION, { force: true })
    await postWorkTrail(client, projectDir, UNRELATED_SIBLING_SESSION, { force: true })
    assert.deepEqual(client.calls, [], 'another tab in the same process is not this bond')
  })

  it('the BONDED session still mirrors — fail-closed must not mean fail-silent', async () => {
    const client = recordingClient()
    await mirrorNow(client, projectDir, BONDED_OPENCODE_SESSION, { force: true })
    assert.deepEqual(
      client.calls,
      [`session.messages:${BONDED_OPENCODE_SESSION}`],
      'the bonded session is exactly the one that should still be read and published',
    )
  })

  it('the BONDED session still opens a work trail', async () => {
    const client = recordingClient()
    await postWorkTrail(client, projectDir, BONDED_OPENCODE_SESSION, { force: true })
    assert.deepEqual(client.calls, [`session.messages:${BONDED_OPENCODE_SESSION}`])
  })
})
