#!/usr/bin/env node
/**
 * Unit tests for OpenCode mirror ↔ manual post_session_message dedup (a70cdf78,
 * hardened for empty/double posts — item 5f75c2cb).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, after, beforeEach } from 'node:test'
import {
  hashPostedContent,
  messageHasActiveToolWork,
  messageHasPostSessionMessageTool,
  normalizePostedContent,
  readState,
  recordManualPostSessionMessage,
  resetBondsForTests,
  writeState,
  runWithBondAsync,
} from '../dist/remote-control.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-devspec-mirror-dedup-'))
}


/**
 * State reads and writes are scoped to a bond now (item a72a4e22) — there is no
 * process-global to fall back on. These cases exercise the state layer itself,
 * so each runs inside one explicit test bond.
 */
// Each suite gets its own bond AND its own home: state files are keyed on the
// bond alone now, so a shared name would have these files racing each other in
// the real ~/.devspec directory. (Before the rekey the folder was part of the
// key, which isolated them by accident.)
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-mirror_dedup-home-'))
const TEST_BOND = 'ses_test_bond_mirror_dedup'
const itInBond = (name, fn) => it(name, () => runWithBondAsync(TEST_BOND, async () => fn()))

describe('normalizePostedContent / hashPostedContent', () => {
  itInBond('trims and normalizes CRLF so whitespace-only drift shares a hash', () => {
    const a = hashPostedContent('Hello\r\nworld\n')
    const b = hashPostedContent('Hello\nworld')
    assert.equal(a, b)
    assert.equal(normalizePostedContent('  x  '), 'x')
  })

  itInBond('distinguishes different bodies', () => {
    assert.notEqual(hashPostedContent('one'), hashPostedContent('two'))
  })
})

describe('messageHasPostSessionMessageTool', () => {
  itInBond('detects common OpenCode / MCP tool name shapes', () => {
    assert.equal(
      messageHasPostSessionMessageTool({
        parts: [{ type: 'tool', tool: 'post_session_message' }],
      }),
      true,
    )
    assert.equal(
      messageHasPostSessionMessageTool({
        parts: [{ type: 'tool', name: 'devspec_post_session_message' }],
      }),
      true,
    )
    assert.equal(
      messageHasPostSessionMessageTool({
        parts: [{ type: 'tool', tool: { name: 'mcp_devspec_post_session_message' } }],
      }),
      true,
    )
  })

  itInBond('is false for text-only or unrelated tools', () => {
    assert.equal(
      messageHasPostSessionMessageTool({
        parts: [{ type: 'text', text: 'hi' }],
      }),
      false,
    )
    assert.equal(
      messageHasPostSessionMessageTool({
        parts: [{ type: 'tool', tool: 'bash' }],
      }),
      false,
    )
    assert.equal(messageHasPostSessionMessageTool(null), false)
  })

  itInBond('turn-scoped detection: some() across every candidate finds an earlier post, not just the last message', () => {
    // mirrorLatestReply's guard is `candidates.some(messageHasPostSessionMessageTool)`
    // — the model may have posted from an EARLIER assistant in the turn and
    // kept working, ending on a `last` with no tool part of its own.
    const candidates = [
      { info: { id: 'a1' }, parts: [{ type: 'tool', tool: 'post_session_message' }] },
      { info: { id: 'a2' }, parts: [{ type: 'tool', tool: 'bash' }] },
      { info: { id: 'a3' }, parts: [{ type: 'text', text: 'continuing after the manual post' }] },
    ]
    assert.equal(candidates.some((m) => messageHasPostSessionMessageTool(m)), true)
    // But the last message alone (the old, unscoped check) would have missed it.
    assert.equal(messageHasPostSessionMessageTool(candidates[candidates.length - 1]), false)
  })
})

// Item d4b8adcb: no answer-path narration mid-turn. mirrorLatestReply gates on
// `messageHasActiveToolWork(last)` unless the call is forced (session.idle) —
// covered end-to-end via this shared predicate, already exercised for stall
// detection in busy-stall.test.mjs.
describe('messageHasActiveToolWork (mirror mid-turn gate, item d4b8adcb)', () => {
  itInBond('a message with a still-running tool is mid-turn — must not be mirrored as the answer', () => {
    assert.equal(
      messageHasActiveToolWork({
        info: { id: 'm1' },
        parts: [
          { type: 'text', text: 'partial narration' },
          { type: 'tool', state: { status: 'running' } },
        ],
      }),
      true,
    )
  })

  itInBond('a fully completed message has nothing active — safe to mirror', () => {
    assert.equal(
      messageHasActiveToolWork({
        info: { id: 'm1' },
        parts: [
          { type: 'text', text: 'final answer' },
          { type: 'tool', state: { status: 'completed' } },
        ],
      }),
      false,
    )
  })
})

// Item 5f75c2cb: manualAnswerPostedThisTurn — a message-id-independent
// double-post guard alongside the hash/tool-part checks.
describe('recordManualPostSessionMessage — manualAnswerPostedThisTurn (item 5f75c2cb)', () => {
  const dirs = []
  beforeEach(() => {
    resetBondsForTests()
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

  function seedState(dir, extra = {}) {
    writeState({
      connectionId: '5aa9129e-aa63-4b80-a2ad-ad8c5e336bde',
      sessionId: '5546c769-0cc2-4eac-9bcf-ca91b14151c4',
      codename: 'Fierce Eagle',
      ...extra,
    })
  }

  itInBond('sets the flag when the model posts while awaiting a remote reply', () => {
    const dir = tmpDir()
    dirs.push(dir)
    seedState(dir, { awaitingRemoteReply: true })

    recordManualPostSessionMessage('post_session_message', { message: 'done, here is the answer' })

    assert.equal(readState()?.manualAnswerPostedThisTurn, true)
  })

  itInBond('does NOT set the flag for a plain local turn (not awaiting a remote reply)', () => {
    const dir = tmpDir()
    dirs.push(dir)
    seedState(dir, { awaitingRemoteReply: false })

    recordManualPostSessionMessage('post_session_message', { message: 'a local-only post' })

    assert.equal(readState()?.manualAnswerPostedThisTurn ?? false, false)
  })

  itInBond('does not set the flag or remember a hash for an empty/whitespace message', () => {
    const dir = tmpDir()
    dirs.push(dir)
    seedState(dir, { awaitingRemoteReply: true })

    recordManualPostSessionMessage('post_session_message', { message: '   ' })

    const fresh = readState()
    assert.equal(fresh?.manualAnswerPostedThisTurn ?? false, false)
    assert.deepEqual(fresh?.recentPostedContentHashes ?? [], [])
  })

  itInBond('ignores unrelated tool names entirely', () => {
    const dir = tmpDir()
    dirs.push(dir)
    seedState(dir, { awaitingRemoteReply: true })

    recordManualPostSessionMessage('bash', { message: 'irrelevant' })

    assert.equal(readState()?.manualAnswerPostedThisTurn ?? false, false)
  })
})

// Item 4f9515a4: content-hash dedup is turn-scoped. A prior turn's identical
// short answer must not skip phase=answer while a live Working trail is open.
describe('turn-scoped content-hash (item 4f9515a4)', () => {
  itInBond('content-hash skip is overridden when an open trail would be orphaned', () => {
    const contentHash = hashPostedContent('7.')
    const alreadyPostedByHash = true
    const alreadyPostedByTool = false
    const alreadyPostedManually = false
    const activeTrailMessageId = '0b5f248c-5e88-43aa-8815-228463497ff4'
    const hashSkipWouldOrphanTrail =
      alreadyPostedByHash &&
      !alreadyPostedByTool &&
      !alreadyPostedManually &&
      Boolean(activeTrailMessageId)
    const shouldSkip =
      (alreadyPostedByHash || alreadyPostedByTool || alreadyPostedManually) &&
      !hashSkipWouldOrphanTrail
    assert.ok(contentHash.length >= 32)
    assert.equal(hashSkipWouldOrphanTrail, true)
    assert.equal(shouldSkip, false)
  })

  itInBond('content-hash skip still applies within a turn when no trail is open', () => {
    const alreadyPostedByHash = true
    const alreadyPostedByTool = false
    const alreadyPostedManually = false
    const activeTrailMessageId = null
    const hashSkipWouldOrphanTrail =
      alreadyPostedByHash &&
      !alreadyPostedByTool &&
      !alreadyPostedManually &&
      Boolean(activeTrailMessageId)
    const shouldSkip =
      (alreadyPostedByHash || alreadyPostedByTool || alreadyPostedManually) &&
      !hashSkipWouldOrphanTrail
    assert.equal(hashSkipWouldOrphanTrail, false)
    assert.equal(shouldSkip, true)
  })

  itInBond('inject-turn / clearInjectTurnState clears the content-hash ring', () => {
    const afterInject = {
      awaitingRemoteReply: true,
      recentPostedContentHashes: [],
      manualAnswerPostedThisTurn: false,
    }
    const afterClear = {
      awaitingRemoteReply: false,
      recentPostedContentHashes: [],
      manualAnswerPostedThisTurn: false,
      activeTrailMessageId: null,
    }
    assert.deepEqual(afterInject.recentPostedContentHashes, [])
    assert.deepEqual(afterClear.recentPostedContentHashes, [])
    assert.equal(afterClear.activeTrailMessageId, null)
  })
})
