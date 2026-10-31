#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import {
  forgetOpenCodeBond,
  handleSessionIdle,
  postWorkTrail,
  readState,
  rememberOpenCodeBond,
  resetBondsForTests,
  runWithBond,
  runWithBondAsync,
  writeState,
} from '../dist/remote-control.js'

const SESSION = 'ses_sessionless_automation_1'
const CONN_ID = '88888888-1111-4222-8333-444444444444'

function makeClient(getMessages) {
  return {
    session: {
      messages: async () => ({ data: getMessages() }),
      promptAsync: async () => ({}),
    },
  }
}

describe('sessionless automation live work-trail streaming (OpenCode)', () => {
  let tmpHome
  let projectDir
  let restoreHomedir
  let priorHome
  let priorToken
  let priorUrl
  let originalFetch

  beforeEach(() => {
    resetBondsForTests()
    forgetOpenCodeBond(SESSION)
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sessionless-trail-home-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sessionless-trail-proj-'))
    restoreHomedir = mock.method(os, 'homedir', () => tmpHome)
    priorHome = process.env.HOME
    priorToken = process.env.DEVSPEC_MCP_TOKEN
    priorUrl = process.env.DEVSPEC_MCP_URL
    originalFetch = globalThis.fetch
    process.env.HOME = tmpHome
    process.env.DEVSPEC_MCP_TOKEN = 'dvs_test_token_not_a_real_credential'
    process.env.DEVSPEC_MCP_URL = 'https://fixture.example.test/api/mcp'
    rememberOpenCodeBond(SESSION, null)
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreHomedir?.mock?.restore?.()
    mock.restoreAll()
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    if (priorToken === undefined) delete process.env.DEVSPEC_MCP_TOKEN
    else process.env.DEVSPEC_MCP_TOKEN = priorToken
    if (priorUrl === undefined) delete process.env.DEVSPEC_MCP_URL
    else process.env.DEVSPEC_MCP_URL = priorUrl
    forgetOpenCodeBond(SESSION)
    resetBondsForTests()
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it('skips Working seed when sessionId is null, retries after pre-claim refusal, streams once claimed, and stays silent on unattached local turns', async () => {
    runWithBond(SESSION, () => {
      writeState({
        connectionId: CONN_ID,
        sessionId: null,
        codename: 'Cosmic Lynx',
        busy: true,
        awaitingRemoteReply: false,
        activeAutomationRunIds: ['run-auto-1'],
        deliveredMessageIds: [],
      })
    })

    const mcpCalls = []
    let failPreClaim = true
    globalThis.fetch = async (_url, options) => {
      const rpc = JSON.parse(options.body)
      mcpCalls.push(rpc.params)
      if (rpc.params?.name === 'post_session_message' && failPreClaim) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'session_id is required when no running automation run' }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, attached_to_automation_run_id: 'run-auto-1' }) }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    let messages = []
    const client = makeClient(() => messages)

    // 1. Eager turn-start seed on sessionless automation must NOT post Working… or empty text
    await postWorkTrail(client, projectDir, SESSION, { force: true, seed: true })
    assert.equal(mcpCalls.length, 0)

    // 2. First real tool step before claim_automation_run is refused -> rolls back lastTrailHash & lastTrailPostedAt
    messages = [
      {
        info: { id: 'msg_asst_1', role: 'assistant' },
        parts: [
          {
            type: 'tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: { command: 'git status --porcelain' },
              output: 'clean',
            },
          },
        ],
      },
    ]
    await postWorkTrail(client, projectDir, SESSION)
    assert.equal(mcpCalls.length, 1)
    assert.equal(runWithBond(SESSION, () => readState()?.lastTrailHash ?? null), null)

    // 3. Immediately after claim_automation_run succeeds, the same/next trail update streams cleanly without throttle delay
    failPreClaim = false
    mcpCalls.length = 0
    await postWorkTrail(client, projectDir, SESSION)
    assert.equal(mcpCalls.length, 1)
    assert.equal(mcpCalls[0].name, 'post_session_message')
    assert.equal(mcpCalls[0].arguments.connection_id, CONN_ID)
    assert.equal(mcpCalls[0].arguments.session_id, undefined)
    assert.equal(mcpCalls[0].arguments.phase, 'trail')
    assert.match(mcpCalls[0].arguments.message, /git status --porcelain/)

    // 4. handleSessionIdle clears activeAutomationRunIds so subsequent unattached local turns never leak trails
    await runWithBondAsync(SESSION, () => handleSessionIdle(projectDir))
    assert.deepEqual(runWithBond(SESSION, () => readState()?.activeAutomationRunIds), [])

    runWithBond(SESSION, () => {
      writeState({
        ...readState(),
        busy: true,
        lastTrailHash: null,
        lastTrailPostedAt: null,
      })
    })
    mcpCalls.length = 0
    await postWorkTrail(client, projectDir, SESSION)
    assert.equal(mcpCalls.length, 0, 'unattached local prompt with no activeAutomationRunIds stays silent')
  })
})
