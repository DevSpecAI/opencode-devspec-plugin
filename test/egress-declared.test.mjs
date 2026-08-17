#!/usr/bin/env node
/**
 * Egress is decided by what a turn DID, never by what it said (item 68cc567c).
 *
 * The live failure: on 2026-08-17 a `/devspec.remote` connect turn printed the
 * word "Done." and the plugin published it into DevSpec session 8fd18ec0 — a
 * room that conversation had not chosen, as a reply to nobody. The suppression
 * was real but text-shaped: it claimed the turn only when the output looked
 * like pure chrome, so anything else "fell through" and posted
 * (`connect-skip overridden — real answer text` in poll.log at 17:32:23).
 *
 * `c13d846c` had already marked that case fixed months earlier, and `b156e680`
 * and `1f1bafa4` were both patches to the same guess. So the cases below drive
 * the real `mirrorNow` and check the two directions that matter: a handshake
 * turn is silent WHATEVER it printed, and a turn that owes an answer posts it
 * verbatim, banner-ish text included.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import {
  mirrorNow,
  rememberOpenCodeBond,
  resetBondsForTests,
  runWithBond,
  writeState,
} from '../dist/remote-control.js'

const BOND = 'ses_bonded_chat'
const ROOM = '8fd18ec0-2a4f-4242-8172-1c76e06a3b8e'

/** OpenCode's assistant-message shape, as `assistantTextFromMessage` reads it. */
function assistantMessage(id, text) {
  return { info: { id, role: 'assistant' }, parts: [{ type: 'text', text }] }
}

function clientWith(messages) {
  return { session: { messages: async () => ({ data: messages }) } }
}

async function startStubMcp() {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        /* recorded below */
      }
      calls.push({
        name: parsed?.params?.name ?? '(unparsed)',
        arguments: parsed?.params?.arguments ?? {},
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed?.id ?? 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ message_id: 'devspec-msg-1' }) }],
          },
        }),
      )
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}/api/mcp`,
    posts: () => calls.filter((c) => c.name === 'post_session_message'),
    close: () => new Promise((r) => server.close(r)),
  }
}

describe('egress is a declared transition, not a text judgement (68cc567c)', () => {
  let tmpHome
  let projectDir
  let restoreHomedir
  let priorHome
  let priorToken
  let priorUrl
  let mcp

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
    rememberOpenCodeBond(BOND, ROOM)
  })

  afterEach(async () => {
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

  const seed = (overrides) =>
    runWithBond(BOND, () => {
      writeState({
        connectionId: '7695c4dc-872e-48b2-92ea-6ca86e7c72bd',
        sessionId: ROOM,
        codename: 'Drifting Mongoose',
        busy: true,
        ...overrides,
      })
    })

  it('a handshake turn posts nothing even when it prints ordinary prose', async () => {
    // The exact live case: connectMirrorSuppressed is set by the handshake, and
    // the model printed "Done." rather than the status banner.
    seed({ connectMirrorSuppressed: true, awaitingRemoteReply: false })
    await mirrorNow(clientWith([assistantMessage('msg_connect', 'Done.')]), projectDir, BOND, {
      force: true,
    })
    assert.deepEqual(mcp.posts(), [], '"Done." must not reach the room from a handshake turn')
  })

  it('a handshake turn posts nothing when it prints the banner either', async () => {
    // This direction always passed — it is the case the old classifier was
    // written for, and it must keep passing.
    seed({ connectMirrorSuppressed: true, awaitingRemoteReply: false })
    await mirrorNow(
      clientWith([
        assistantMessage('msg_banner', '━━━ DevSpec Remote Control ━━━\nAgent: OpenCode · Brave Fox'),
      ]),
      projectDir,
      BOND,
      { force: true },
    )
    assert.deepEqual(mcp.posts(), [])
  })

  it('a handshake turn posts nothing when it prints a long, answer-shaped essay', async () => {
    seed({ connectMirrorSuppressed: true, awaitingRemoteReply: false })
    await mirrorNow(
      clientWith([
        assistantMessage(
          'msg_essay',
          'I have reviewed the repository and here is a detailed summary of what I found across the indexing pipeline, including several concrete recommendations.',
        ),
      ]),
      projectDir,
      BOND,
      { force: true },
    )
    assert.deepEqual(
      mcp.posts(),
      [],
      'length and prose-likeness are not evidence that a turn owes the room an answer',
    )
  })

  it('a turn answering a delivered owner command posts, banner text and all (b156e680)', async () => {
    // What b156e680 protected: a real answer must not be swallowed because the
    // turn was tagged. Here it is preserved structurally — the turn is awaiting
    // a remote reply, so it is not a handshake turn at all.
    seed({
      connectMirrorSuppressed: true,
      awaitingRemoteReply: true,
      replyAfterOpenCodeMessageId: 'msg_before',
      replyBaselineCaptured: true,
    })
    await mirrorNow(
      clientWith([
        assistantMessage('msg_before', 'earlier'),
        assistantMessage('msg_answer', '━━━ DevSpec Remote Control ━━━\n\nThe answer is 2.'),
      ]),
      projectDir,
      BOND,
      { force: true },
    )
    const posts = mcp.posts()
    assert.equal(posts.length, 1, 'the answer must reach the room')
    assert.equal(
      posts[0].arguments.message,
      '━━━ DevSpec Remote Control ━━━\n\nThe answer is 2.',
      'and verbatim — the banner strip went with the classifier',
    )
  })

  it('an ordinary local turn in an attached chat still mirrors', async () => {
    // Not a handshake turn and not awaiting: the room is a shared transcript,
    // so what the owner and agent say locally still belongs in it.
    seed({ awaitingRemoteReply: false })
    await mirrorNow(
      clientWith([assistantMessage('msg_local', 'Sure — I renamed the helper.')]),
      projectDir,
      BOND,
      { force: true },
    )
    const posts = mcp.posts()
    assert.equal(posts.length, 1)
    assert.equal(posts[0].arguments.message, 'Sure — I renamed the helper.')
  })

  it('a turn with no text posts nothing — absence of content, not a verdict on it', async () => {
    seed({ awaitingRemoteReply: false })
    await mirrorNow(clientWith([assistantMessage('msg_empty', '   ')]), projectDir, BOND, {
      force: true,
    })
    assert.deepEqual(mcp.posts(), [])
  })
})
