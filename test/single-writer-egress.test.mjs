#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { DevSpecPlugin } from '../dist/plugin.js'
import {
  readState,
  rememberOpenCodeBond,
  resetBondsForTests,
  runWithBond,
  shouldDeferCanonicalPrompt,
  writeState,
} from '../dist/remote-control.js'

const BONDED = 'ses_bonded_chat'
const UNBONDED = 'ses_plain_chat'
const CONNECTION = '7695c4dc-872e-48b2-92ea-6ca86e7c72bd'
const ROOM = '8fd18ec0-2a4f-4242-8172-1c76e06a3b8e'

async function startStubMcp() {
  const calls = []
  let fail = false
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const request = JSON.parse(body)
      calls.push({ name: request.params.name, arguments: request.params.arguments })
      if (fail) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'forced failure' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({ message_id: 'msg_error', closed_trail_turn: true }),
          }],
        },
      }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    calls,
    setFail: (value) => { fail = value },
    url: `http://127.0.0.1:${server.address().port}/api/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const successfulPost = (messageId = 'msg_answer') => ({
  content: [{ type: 'text', text: JSON.stringify({ message_id: messageId }) }],
})

describe('agent-canonical bonded answer egress', () => {
  let tmpHome
  let projectDir
  let restoreHomedir
  let priorHome
  let priorToken
  let priorUrl
  let hooks
  let mcp
  let clientReads
  let clientMessages

  const seed = (overrides = {}) => runWithBond(BONDED, () => {
    writeState({
      connectionId: CONNECTION,
      sessionId: ROOM,
      codename: 'Drifting Mongoose',
      busy: true,
      ...overrides,
    })
  })
  const state = () => runWithBond(BONDED, () => readState())
  const before = async (sessionID, args, callID = 'post-call') => {
    const output = { args }
    await hooks['tool.execute.before'](
      { tool: 'devspec_post_session_message', sessionID, callID },
      output,
    )
    return output.args
  }
  const after = (output, args = { message: 'answer' }, callID = 'post-call') => hooks['tool.execute.after'](
    {
      tool: 'devspec_post_session_message',
      sessionID: BONDED,
      callID,
      args,
    },
    output,
  )

  beforeEach(async () => {
    resetBondsForTests()
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-egress-home-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-egress-proj-'))
    restoreHomedir = mock.method(os, 'homedir', () => tmpHome)
    priorHome = process.env.HOME
    priorToken = process.env.DEVSPEC_MCP_TOKEN
    priorUrl = process.env.DEVSPEC_MCP_URL
    process.env.HOME = tmpHome
    mcp = await startStubMcp()
    process.env.DEVSPEC_MCP_TOKEN = 'dvs_test_token_not_a_real_credential'
    process.env.DEVSPEC_MCP_URL = mcp.url
    clientReads = []
    clientMessages = [{
      info: {
        id: 'assistant_current',
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5.6-sol',
      },
      parts: [
        { type: 'tool', callID: 'post-call' },
        { type: 'tool', callID: 'old-call' },
        { type: 'tool', callID: 'new-call' },
        { type: 'tool', callID: 'next-call' },
      ],
    }]
    hooks = await DevSpecPlugin({
      directory: projectDir,
      client: {
        session: {
          messages: async (input) => {
            clientReads.push(input)
            return { data: clientMessages }
          },
        },
      },
    })
    rememberOpenCodeBond(BONDED, ROOM)
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
    resetBondsForTests()
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  it('binds a remote post to the current connection and exact final command', async () => {
    seed({
      awaitingRemoteReply: true,
      currentCommandTurnId: 'turn_canonical',
      currentCommandMessageId: 'cmd_final',
    })
    const args = await before(BONDED, {
      message: 'complete answer',
      connection_id: 'hostile-connection',
      session_id: 'hostile-room',
      agent_name: 'Impostor',
      turn_kind: 'local_prompt',
      phase: 'trail',
      complete_turn: false,
      command_turn_id: 'wrong-turn',
      command_message_id: 'wrong-message',
      command_turn_unbound: true,
      model: { providerID: 'wrong', modelID: 'wrong' },
    })

    assert.deepEqual(args, {
      message: 'complete answer',
      connection_id: CONNECTION,
      agent_name: 'OpenCode',
      turn_kind: 'agent',
      phase: 'answer',
      complete_turn: true,
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
      command_turn_id: 'turn_canonical',
      command_message_id: 'cmd_final',
    })
  })

  it('binds a local terminal post to the current connection as explicitly unbound', async () => {
    seed({ awaitingRemoteReply: false })
    const args = await before(BONDED, {
      message: 'local answer',
      session_id: 'wrong-room',
      command_turn_id: 'stale-turn',
      command_message_id: 'stale-message',
    })
    assert.deepEqual(args, {
      message: 'local answer',
      connection_id: CONNECTION,
      agent_name: 'OpenCode',
      turn_kind: 'agent',
      phase: 'answer',
      complete_turn: true,
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
      command_turn_unbound: true,
    })
  })

  it('stamps the model from the assistant containing the firing tool call', async () => {
    seed({ awaitingRemoteReply: false })
    clientMessages = [
      {
        info: {
          id: 'assistant_firing',
          role: 'assistant',
          providerID: 'anthropic',
          modelID: 'claude-sonnet-4-5',
        },
        parts: [{ type: 'tool', callID: 'post-call' }],
      },
      {
        info: {
          id: 'assistant_newer_unrelated',
          role: 'assistant',
          providerID: 'wrong',
          modelID: 'wrong',
        },
        parts: [],
      },
    ]

    const args = await before(BONDED, { message: 'model-bound answer' })
    assert.deepEqual(args.model, {
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-5',
    })
  })

  it('refuses an unbonded child or sibling post before it reaches DevSpec', async () => {
    const supplied = {
      message: 'child answer',
      session_id: 'child-room',
      agent_name: 'Child',
      command_turn_id: 'child-turn',
    }
    await assert.rejects(
      before(UNBONDED, supplied),
      /unavailable outside this conversation's active bond/,
    )
  })

  it('settles local lifecycle only after a confirmed message_id', async () => {
    seed({
      awaitingRemoteReply: true,
      currentTurnMessageIds: ['cmd_final'],
      currentCommandTurnId: 'turn_canonical',
      currentCommandMessageId: 'cmd_final',
      replyAfterOpenCodeMessageId: 'assistant_before',
      replyBaselineCaptured: true,
      activeTrailMessageId: 'trail_open',
    })
    const answerArgs = await before(BONDED, { message: 'answer' })
    await after(successfulPost(), answerArgs)
    assert.equal(state().busy, false)
    assert.equal(state().awaitingRemoteReply, false)
    assert.equal(state().currentCommandTurnId, null)
    assert.equal(state().currentCommandMessageId, null)
    assert.equal(state().replyAfterOpenCodeMessageId, null)
    assert.equal(state().activeTrailMessageId, null)
    assert.equal(state().answerPostedThisTurn, true)
    assert.deepEqual(mcp.calls, [], 'complete_turn is atomic; no broad report_complete follows')

    await assert.rejects(
      before(BONDED, { message: 'duplicate answer' }),
      /already posted its answer/,
    )
  })

  it('does not falsely settle a malformed or failed-looking tool result', async () => {
    seed({
      awaitingRemoteReply: true,
      currentCommandTurnId: 'turn_canonical',
      currentCommandMessageId: 'cmd_final',
    })
    await after({ content: [{ type: 'text', text: JSON.stringify({ ok: false }) }] })
    assert.equal(state().busy, true)
    assert.equal(state().awaitingRemoteReply, true)
    assert.equal(state().currentCommandTurnId, 'turn_canonical')

    await before(BONDED, { message: 'retry after failed post' })
    await after({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ message_id: 'must_not_settle' }) }],
    })
    assert.equal(state().busy, true)
    assert.equal(state().awaitingRemoteReply, true)
  })

  it('never mirrors assistant text from message.updated or a settled idle event', async () => {
    seed({ busy: false, awaitingRemoteReply: false })
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'assistant_secret', sessionID: BONDED, role: 'assistant' } },
      },
    })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: BONDED } } })
    assert.deepEqual(clientReads, [], 'answer paths never read assistant text')
    assert.deepEqual(mcp.calls, [], 'settled idle emits no answer or lifecycle duplicate')
  })

  it('keeps the connect/status handshake terminal-only', async () => {
    seed({ busy: true, awaitingRemoteReply: false, connectHandshakePending: true })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: BONDED } } })
    assert.deepEqual(mcp.calls, [])
    assert.equal(state().connectHandshakePending, false, 'idle releases deferred command injection')
    assert.equal(state().busy, false)
  })

  it('idle after an omitted remote post emits one bounded error and clears state', async () => {
    seed({
      awaitingRemoteReply: true,
      deliveredMessageIds: ['cmd_final'],
      currentTurnMessageIds: ['cmd_final'],
      currentCommandTurnId: 'turn_canonical',
      currentCommandMessageId: 'cmd_final',
      activeTrailMessageId: 'trail_open',
    })
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: BONDED } } })
    const posts = mcp.calls.filter((call) => call.name === 'post_session_message')
    assert.equal(posts.length, 1)
    assert.equal(posts[0].arguments.phase, 'error')
    assert.equal(posts[0].arguments.complete_turn, true)
    assert.equal(posts[0].arguments.command_turn_id, 'turn_canonical')
    assert.equal(posts[0].arguments.command_message_id, 'cmd_final')
    assert.match(posts[0].arguments.message, /without posting an answer/)
    assert.deepEqual(clientReads, [], 'idle recovery never reads terminal assistant text')
    assert.equal(state().busy, false)
    assert.equal(state().awaitingRemoteReply, false)
    assert.equal(state().currentCommandTurnId, null)
    assert.deepEqual(state().deliveredMessageIds, [])
  })

  it('preserves an unanswered command when idle error settlement fails', async () => {
    seed({
      awaitingRemoteReply: true,
      deliveredMessageIds: ['cmd_final'],
      currentTurnMessageIds: ['cmd_final'],
      currentCommandTurnId: 'turn_canonical',
      currentCommandMessageId: 'cmd_final',
      activeTrailMessageId: 'trail_open',
    })
    mcp.setFail(true)

    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: BONDED } } })

    assert.equal(state().busy, true)
    assert.equal(state().awaitingRemoteReply, true)
    assert.equal(state().currentCommandTurnId, 'turn_canonical')
    assert.deepEqual(state().deliveredMessageIds, ['cmd_final'])
  })

  it('serializes follow-up prompts without blocking a pending question reply', () => {
    assert.equal(shouldDeferCanonicalPrompt({ busy: true }), true)
    assert.equal(shouldDeferCanonicalPrompt({ awaitingRemoteReply: true }), true)
    assert.equal(
      shouldDeferCanonicalPrompt({
        awaitingRemoteReply: true,
        pendingQuestionRequestId: 'question_1',
      }),
      false,
    )
  })

  it('releases the exactly-once latch at the next local user-turn boundary', async () => {
    seed({ busy: true, awaitingRemoteReply: false })
    const firstArgs = await before(BONDED, { message: 'first local answer' })
    await after(successfulPost('msg_first'), firstArgs)
    assert.equal(state().answerPostedThisTurn, true)

    await hooks.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'user_next', sessionID: BONDED, role: 'user' } },
      },
    })

    const nextArgs = await before(BONDED, { message: 'next local answer' }, 'next-call')
    assert.equal(nextArgs.command_turn_unbound, true)
  })

  it('reclaims a same-process orphan at the next user turn and ignores its late result', async () => {
    seed({ busy: true, awaitingRemoteReply: false })
    await before(BONDED, { message: 'old answer' }, 'old-call')
    await hooks.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'user_next', sessionID: BONDED, role: 'user' } },
      },
    })
    await before(BONDED, { message: 'new answer' }, 'new-call')

    await after(successfulPost('msg_old'), { message: 'old answer' }, 'old-call')
    assert.equal(state().answerPostInFlight, true)
    assert.equal(state().answerPostCallId, 'new-call')
    assert.equal(state().busy, true, 'the stale result cannot settle the current turn')

    await after(successfulPost('msg_new'), { message: 'new answer' }, 'new-call')
    assert.equal(state().answerPostInFlight, false)
    assert.equal(state().answerPostedThisTurn, true)
  })

  it('reclaims an in-flight answer reservation left by an earlier process', async () => {
    seed({
      busy: false,
      awaitingRemoteReply: false,
      answerPostInFlight: true,
      answerPostCallId: 'dead-call',
      answerPostProcessId: 'dead-process',
    })

    const args = await before(BONDED, { message: 'answer after restart' }, 'next-call')
    assert.equal(args.command_turn_unbound, true)
    assert.equal(state().answerPostCallId, 'next-call')
    assert.notEqual(state().answerPostProcessId, 'dead-process')
  })

  it('keeps the next local terminal answer working after a remote permission wait settles', async () => {
    seed({
      awaitingRemoteReply: true,
      currentCommandTurnId: 'turn_remote',
      currentCommandMessageId: 'cmd_remote',
      permissionAskedPending: true,
      pendingPermissions: [{ requestId: 'perm_1', askedAt: 1 }],
    })
    await hooks.event({
      event: {
        type: 'permission.replied',
        properties: { sessionID: BONDED, requestID: 'perm_1' },
      },
    })
    const remoteArgs = await before(BONDED, { message: 'remote answer' })
    assert.equal(remoteArgs.command_turn_id, 'turn_remote')
    await after(successfulPost('msg_remote'), remoteArgs)

    seed({ busy: true, awaitingRemoteReply: false })
    const localArgs = await before(BONDED, { message: 'terminal answer' })
    assert.equal(localArgs.command_turn_unbound, true)
    assert.equal('command_turn_id' in localArgs, false)
    await after(successfulPost('msg_local'), localArgs)
    assert.equal(state().busy, false)
    assert.equal(state().awaitingRemoteReply, false)
  })
})
