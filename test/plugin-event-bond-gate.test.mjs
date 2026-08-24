#!/usr/bin/env node
/**
 * Regression (item 2a5d212b), plugin-hook layer: the `event` hook gates EVERY
 * branch on the firing session's bond, and `permission.ask` auto-allow is
 * bond-scoped rather than process-wide.
 *
 * Before this, each branch looked up the bond and, when there was none, ran the
 * side effect anyway against the process-global bind — so
 * an unbonded `@explore` child's `session.idle` sent a busy=false heartbeat for
 * the BONDED connection and cleared its busy flag, ending a remote turn that
 * was still running. `message.updated` did not consult the bond at all.
 *
 * A stub MCP endpoint stands in for DevSpec so both directions are observable:
 * an unbonded event must produce NO call, and a bonded one must still produce
 * the normal call. Without a resolvable endpoint every path would no-op for the
 * wrong reason and the test would pass against the bug.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import { DevSpecPlugin } from '../dist/plugin.js'
import {
  checkBusyStall,
  forgetOpenCodeBond,
  readState,
  rememberOpenCodeBond,
  resetBondsForTests,
  runWithBond,
  writeState,
} from '../dist/remote-control.js'

const BONDED = 'ses_parent_bonded'
const CHILD = 'ses_explore_child'

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

/** Minimal MCP JSON-RPC endpoint that records which tools were called. */
async function startStubMcp() {
  const toolCalls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        /* recorded as unknown below */
      }
      toolCalls.push({
        name: parsed?.params?.name ?? '(unparsed)',
        arguments: parsed?.params?.arguments ?? {},
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed?.id ?? 1,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] },
        }),
      )
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/api/mcp`,
    toolCalls,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

describe('plugin event hook is bond-gated (2a5d212b)', () => {
  let tmpHome
  let projectDir
  let restoreHomedir
  let priorHome
  let priorToken
  let priorUrl
  let hooks
  let client
  let mcp

  beforeEach(async () => {
    resetBondsForTests()
    forgetOpenCodeBond(BONDED)
    forgetOpenCodeBond(CHILD)

    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gate-home-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gate-proj-'))
    restoreHomedir = mock.method(os, 'homedir', () => tmpHome)
    priorHome = process.env.HOME
    priorToken = process.env.DEVSPEC_MCP_TOKEN
    priorUrl = process.env.DEVSPEC_MCP_URL
    process.env.HOME = tmpHome

    mcp = await startStubMcp()
    process.env.DEVSPEC_MCP_TOKEN = 'dvs_test_token_not_a_real_credential'
    process.env.DEVSPEC_MCP_URL = mcp.url

    client = recordingClient()
    // Build the plugin with NO bonds registered: the pump then idles on a purely
    // local check for the life of this test instead of polling the stub.
    hooks = await DevSpecPlugin({ client, directory: projectDir })

    rememberOpenCodeBond(BONDED, '8fd18ec0-2a4f-4242-8172-1c76e06a3b8e')
    runWithBond(BONDED, () => {
      writeState({
        connectionId: '7695c4dc-872e-48b2-92ea-6ca86e7c72bd',
        sessionId: '8fd18ec0-2a4f-4242-8172-1c76e06a3b8e',
        codename: 'Drifting Mongoose',
        busy: true,
        busySince: 1_000,
        awaitingRemoteReply: true,
        currentTurnMessageIds: ['cmd_remote'],
        deliveredMessageIds: ['cmd_remote'],
        activeTrailMessageId: 'trail_remote',
      })
    })
  })

  afterEach(async () => {
    await hooks?.dispose?.()
    await mcp?.close()
    restoreHomedir?.mock?.restore?.()
    mock.restoreAll()
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    if (priorToken === undefined) delete process.env.DEVSPEC_MCP_TOKEN
    else process.env.DEVSPEC_MCP_TOKEN = priorToken
    if (priorUrl === undefined) delete process.env.DEVSPEC_MCP_URL
    else process.env.DEVSPEC_MCP_URL = priorUrl
    forgetOpenCodeBond(BONDED)
    resetBondsForTests()
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  const readBonded = () => runWithBond(BONDED, () => readState())
  const heartbeats = () => mcp.toolCalls.filter((c) => c.name === 'heartbeat_connection')

  it('session.idle from an unbonded child does not end the bonded turn', async () => {
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: CHILD } } })
    assert.deepEqual(heartbeats(), [], 'no busy assertion may be sent for a child session')
    assert.equal(
      readBonded()?.busy,
      true,
      "a child going idle must not clear the bonded connection's busy flag",
    )
    assert.deepEqual(client.calls, [], 'nor read the child session for mirroring')
  })

  it('session.idle from the bonded session still ends the turn', async () => {
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: BONDED } } })
    const beats = heartbeats()
    assert.equal(beats.length, 1, 'the bonded session must still settle normally')
    assert.equal(beats[0].arguments.busy, false)
    assert.equal(readBonded()?.busy, false)
  })

  it('an event with no sessionID at all is inert', async () => {
    await hooks.event({ event: { type: 'session.idle', properties: {} } })
    assert.deepEqual(heartbeats(), [])
    assert.equal(
      readBonded()?.busy,
      true,
      'an unattributable event has no bond and must not fall back to one',
    )
  })

  it('message.updated from an unbonded child schedules no mirror or trail', async () => {
    await hooks.event({ event: { type: 'message.updated', properties: { sessionID: CHILD } } })
    // The gate must reject before scheduling, so nothing is pending and the
    // child session is never read.
    assert.deepEqual(client.calls, [])
  })

  it('question.asked from an unbonded child does not touch the bonded state', async () => {
    await hooks.event({
      event: {
        type: 'question.asked',
        properties: { sessionID: CHILD, questionID: 'q1', text: 'child question?' },
      },
    })
    assert.equal(
      readBonded()?.pendingQuestion ?? null,
      null,
      "a child's question must not become the bonded turn's Needs-your-input",
    )
  })

  it('command.executed from an unbonded child does not touch the bonded state', async () => {
    const before = readBonded()?.nonMirrorMessageIds ?? []
    await hooks.event({
      event: {
        type: 'command.executed',
        properties: { sessionID: CHILD, name: 'devspec.remote', messageID: 'msg_child' },
      },
    })
    assert.deepEqual(
      readBonded()?.nonMirrorMessageIds ?? [],
      before,
      "a child's command must not record a skip-mirror id on the bonded connection",
    )
  })

  it('permission.ask auto-allow is scoped to the bonded session', async () => {
    const unbondedOutput = { status: 'ask' }
    await hooks['permission.ask']({ sessionID: CHILD, type: 'bash' }, unbondedOutput)
    assert.equal(
      unbondedOutput.status,
      'ask',
      'an ordinary chat must keep its human safety prompt even while another chat is bonded',
    )

    const bondedOutput = { status: 'ask' }
    await hooks['permission.ask']({ sessionID: BONDED, type: 'bash' }, bondedOutput)
    assert.equal(bondedOutput.status, 'allow', 'the bonded remote turn still auto-allows')
  })

  it('keeps the same active turn while a permission is approved', async () => {
    await hooks.event({
      event: {
        type: 'permission.asked',
        properties: { sessionID: BONDED, id: 'perm_1' },
      },
    })

    const waiting = readBonded()
    assert.equal(waiting?.busy, true)
    assert.equal(waiting?.awaitingRemoteReply, true)
    assert.deepEqual(waiting?.currentTurnMessageIds, ['cmd_remote'])
    assert.deepEqual(waiting?.deliveredMessageIds, ['cmd_remote'])
    assert.equal(waiting?.activeTrailMessageId, 'trail_remote')
    assert.deepEqual(waiting?.pendingPermissions, [{ requestId: 'perm_1', askedAt: waiting.permissionAskedAt }])
    assert.equal(heartbeats().some((call) => call.arguments.busy === false), false)
    const notice = mcp.toolCalls.find((call) => call.name === 'post_session_message')
    assert.match(notice?.arguments?.message ?? '', /OpenCode terminal/)
    assert.doesNotMatch(notice?.arguments?.message ?? '', /perm_1|poll\.log|assistant/i)

    client.calls.length = 0
    await runWithBond(BONDED, () => checkBusyStall(client, projectDir, BONDED))
    assert.deepEqual(client.calls, [], 'the stall watchdog must not inspect or terminate a live permission wait')

    await hooks.event({
      event: {
        type: 'permission.replied',
        properties: { sessionID: BONDED, requestID: 'perm_1' },
      },
    })

    const resumed = readBonded()
    assert.equal(resumed?.busy, true)
    assert.equal(resumed?.awaitingRemoteReply, true)
    assert.deepEqual(resumed?.currentTurnMessageIds, ['cmd_remote'])
    assert.equal(resumed?.activeTrailMessageId, 'trail_remote')
    assert.deepEqual(resumed?.pendingPermissions, [])
    assert.equal(resumed?.permissionAskedPending, false)
    assert.ok(resumed?.busySince > 1_000, 'approval restarts the ordinary stall window')
  })

  it('does not let an old reply clear a newer permission request', async () => {
    await hooks.event({
      event: { type: 'permission.asked', properties: { sessionID: BONDED, id: 'perm_old' } },
    })
    await hooks.event({
      event: { type: 'permission.replied', properties: { sessionID: BONDED, requestID: 'perm_old' } },
    })
    await hooks.event({
      event: { type: 'permission.asked', properties: { sessionID: BONDED, id: 'perm_new' } },
    })
    await hooks.event({
      event: { type: 'permission.replied', properties: { sessionID: BONDED, requestID: 'perm_old' } },
    })

    assert.equal(readBonded()?.permissionAskedPending, true)
    assert.deepEqual(readBonded()?.pendingPermissions?.map((request) => request.requestId), ['perm_new'])
    assert.equal(heartbeats().some((call) => call.arguments.busy === false), false)

    await hooks.event({
      event: { type: 'permission.denied', properties: { sessionID: BONDED, requestID: 'perm_new' } },
    })
    assert.equal(readBonded()?.permissionAskedPending, false)
    assert.equal(readBonded()?.busy, true)
    assert.equal(readBonded()?.awaitingRemoteReply, true)
    assert.equal(readBonded()?.activeTrailMessageId, 'trail_remote')
  })

  it('accepts the SDK message.updated sessionID nested under info', async () => {
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: {
          info: { id: 'msg_assistant', sessionID: BONDED, role: 'assistant' },
        },
      },
    })
    assert.equal(readBonded()?.busy, true)
  })
})
