#!/usr/bin/env node
/**
 * What survives in mirror-chrome after egress stopped reading text (68cc567c).
 *
 * This file used to be the home of the classifier suite: `prepareMirrorText`
 * fence-awareness (0ffe97cb), variant status-block detection (Dashing Osprey /
 * 7976fffb), `shouldSkipConnectTurnMirror` (e7ecc1de) and
 * `shouldClaimConnectTurnSuppress` (b156e680). Every one of those was added
 * after a live failure, and the last of them let "Done." through into DevSpec
 * session 8fd18ec0 on 2026-08-17 because it did not look like chrome.
 *
 * The decision moved to what a turn DID — a handshake turn has no answer to
 * post — so the classifiers are deleted rather than tuned. What is left here is
 * formatting that cannot change whether something is posted, a command NAME
 * test, and inject sequencing during connect.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  collapseOrphanMarkdownFences,
  isDevspecRemoteControlCommand,
  shouldDeferInjectDuringConnect,
  unwrapSingleOuterMarkdownFence,
} from '../dist/mirror-chrome.js'
import { unansweredCommands } from '../dist/poll-turn.js'

const FENCED = '```\n━━━ DevSpec Remote Control ━━━\nAgent: OpenCode\n```'

describe('formatting helpers are content-blind', () => {
  it('unwraps a single outer fence without judging what is inside', () => {
    const out = unwrapSingleOuterMarkdownFence(FENCED)
    assert.equal(out.startsWith('```'), false)
    assert.equal(out.includes('━━━ DevSpec Remote Control ━━━'), true, 'content is preserved verbatim')
  })

  it('leaves non-fenced text exactly as written', () => {
    assert.equal(unwrapSingleOuterMarkdownFence('hello world'), 'hello world')
    assert.equal(collapseOrphanMarkdownFences('hello world'), 'hello world')
  })

  it('collapses an orphan fence pair to nothing postable', () => {
    assert.equal(collapseOrphanMarkdownFences('```\n```').trim(), '')
  })
})

describe('isDevspecRemoteControlCommand — a NAME test, not a text test', () => {
  it('matches the two remote-control commands', () => {
    assert.equal(isDevspecRemoteControlCommand('devspec.remote'), true)
    assert.equal(isDevspecRemoteControlCommand('devspec.remote-stop'), true)
  })

  it('rejects anything else, including near misses and non-strings', () => {
    assert.equal(isDevspecRemoteControlCommand('devspec.work'), false)
    assert.equal(isDevspecRemoteControlCommand('remote'), false)
    assert.equal(isDevspecRemoteControlCommand(null), false)
    assert.equal(isDevspecRemoteControlCommand(42), false)
  })
})

describe('shouldDeferInjectDuringConnect — sequencing, not egress (6990fd9e)', () => {
  it('defers an owner command while the handshake is still settling', () => {
    assert.equal(shouldDeferInjectDuringConnect({ connectMirrorSuppressed: true }), true)
  })

  it('does not defer once a real inject turn is in flight', () => {
    assert.equal(
      shouldDeferInjectDuringConnect({ connectMirrorSuppressed: true, awaitingRemoteReply: true }),
      false,
      'a turn already answering a command must not be starved by a stale handshake flag',
    )
  })

  it('does not defer when no handshake is in progress', () => {
    assert.equal(shouldDeferInjectDuringConnect({}), false)
  })
})

describe('unansweredCommands — a blank bubble is not an answer', () => {
  it('keeps a pending command when the only later agent bubble is empty fences', () => {
    const cmds = [{ id: 'math', created_at: '2026-08-04T11:16:30.000Z' }]
    const room = [
      {
        message_type: 'external_agent',
        author: { kind: 'external_agent', name: 'OpenCode · Ivory Ibis' },
        created_at: '2026-08-04T11:17:53.000Z',
        content: '```\n```',
      },
    ]
    assert.deepEqual(unansweredCommands(cmds, room).map((c) => c.id), ['math'])
  })

  it('settles when a real answer was posted after the command', () => {
    const cmds = [{ id: 'math', created_at: '2026-08-05T19:15:59.854Z' }]
    const room = [
      {
        message_type: 'external_agent',
        author: { kind: 'external_agent' },
        created_at: '2026-08-05T19:16:53.000Z',
        content: '2',
      },
    ]
    assert.deepEqual(unansweredCommands(cmds, room), [])
  })

  it('keeps a pending command when nothing was posted at all', () => {
    const cmds = [{ id: 'math', created_at: '2026-08-05T19:15:59.854Z' }]
    assert.deepEqual(unansweredCommands(cmds, []).map((c) => c.id), ['math'])
  })

  it('settles on an answer that would once have been filtered as chrome', () => {
    // The room-side chrome filter is gone with the mirror-side one. A short or
    // banner-ish reply is now taken at face value, because the plugin no longer
    // puts operational text in a room for anyone to filter back out.
    const cmds = [{ id: 'q', created_at: '2026-08-05T19:15:59.854Z' }]
    const room = [
      {
        message_type: 'external_agent',
        author: { kind: 'external_agent' },
        created_at: '2026-08-05T19:16:53.000Z',
        content: 'Done.',
      },
    ]
    assert.deepEqual(unansweredCommands(cmds, room), [])
  })
})
