#!/usr/bin/env node
/**
 * Mirror chrome filter — fence-aware status strip + unansweredCommands settlement
 * (item 4973de1f / session 0ffe97cb).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isDevspecRemoteControlCommand,
  isOperationalChrome,
  prepareMirrorText,
  shouldClaimConnectTurnSuppress,
  shouldDeferInjectDuringConnect,
  shouldSkipConnectTurnMirror,
  stripRemoteControlBanner,
  unwrapSingleOuterMarkdownFence,
} from '../dist/mirror-chrome.js'
import { unansweredCommands } from '../dist/poll-turn.js'

const FENCED_BANNER = `\`\`\`
━━━ DevSpec Remote Control ━━━
Agent:      OpenCode · Ivory Ibis
Connection: cc58a50b…
Session:    0ffe97cb… | (none — available)
Status:     registered | attached
Open:       Agents page
Stop with:  /devspec.remote-stop
───────────────────────────────
\`\`\``

const PLAIN_BANNER = `━━━ DevSpec Remote Control ━━━
Agent:      OpenCode · Ivory Ibis
Connection: cc58a50b…
Session:    0ffe97cb… | (none — available)
Status:     registered | attached
Open:       Agents page
Stop with:  /devspec.remote-stop
───────────────────────────────`

/** Live leak (Dashing Osprey): rule-only opener, no REMOTE_STATUS_BANNER title. */
const VARIANT_BANNER = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Agent:      OpenCode · Dashing Osprey
Connection: 1701c62c…
Session:    7976fffb… | attached
Status:     registered | attached
Open:       Agents page
Stop with:  /devspec.remote-stop
──────────────────────────────────`

const VARIANT_WITH_INTERNAL_NOTE = `${VARIANT_BANNER}

> **Internal note (not mirrored):** Oriented on the room. Session is "Explain DevSpec Project Intelligence Platform" — standing by for the next owner command.`

describe('prepareMirrorText — fence-aware chrome (0ffe97cb)', () => {
  it('returns null for a status banner wrapped in markdown code fences', () => {
    assert.equal(prepareMirrorText(FENCED_BANNER), null)
  })

  it('returns null for a plain (unfenced) status banner', () => {
    assert.equal(prepareMirrorText(PLAIN_BANNER), null)
  })

  it('returns null for fence-only leftovers after a banner strip', () => {
    assert.equal(prepareMirrorText('```\n```'), null)
    assert.equal(isOperationalChrome('```\n```'), true)
  })

  it('keeps a real answer that follows a pasted status block (banner stripped)', () => {
    const mixed = `${PLAIN_BANNER}\n\n2`
    assert.equal(prepareMirrorText(mixed), '2')
  })

  it('keeps an ordinary real reply', () => {
    assert.equal(prepareMirrorText('1 + 1 is 2.'), '1 + 1 is 2.')
  })
})

describe('prepareMirrorText — variant status chrome (Dashing Osprey / 7976fffb)', () => {
  it('returns null for a rule-only status block without the canonical title', () => {
    assert.equal(prepareMirrorText(VARIANT_BANNER), null)
    assert.equal(isOperationalChrome(VARIANT_BANNER), true)
  })

  it('returns null when variant banner is followed by Internal note chrome', () => {
    assert.equal(prepareMirrorText(VARIANT_WITH_INTERNAL_NOTE), null)
    assert.equal(isOperationalChrome(VARIANT_WITH_INTERNAL_NOTE), true)
  })

  it('returns null for a standalone Internal note (not mirrored) block', () => {
    const note =
      '> **Internal note (not mirrored):** Oriented on the room. Standing by for the next owner command.'
    assert.equal(prepareMirrorText(note), null)
  })

  it('keeps a real answer after a variant status block (fields stripped)', () => {
    assert.equal(prepareMirrorText(`${VARIANT_BANNER}\n\n2`), '2')
  })

  it('keeps a real answer after variant banner + Internal note (blank-line separated)', () => {
    assert.equal(prepareMirrorText(`${VARIANT_WITH_INTERNAL_NOTE}\n\n2`), '2')
  })

  it('does not strip a real reply that mentions Session once in prose', () => {
    const reply = 'The Session: field on that form is optional.'
    assert.equal(prepareMirrorText(reply), reply)
  })
})

describe('shouldSkipConnectTurnMirror — connect skill turn (e7ecc1de)', () => {
  it('skips when the message id was recorded from command.executed', () => {
    assert.equal(
      shouldSkipConnectTurnMirror({
        messageId: 'msg_connect',
        nonMirrorMessageIds: ['msg_connect'],
        connectMirrorSuppressed: false,
        awaitingRemoteReply: false,
      }),
      true,
    )
  })

  it('skips while handshake suppress is on and not awaiting an inject reply', () => {
    assert.equal(
      shouldSkipConnectTurnMirror({
        messageId: 'msg_other',
        nonMirrorMessageIds: [],
        connectMirrorSuppressed: true,
        awaitingRemoteReply: false,
      }),
      true,
    )
  })

  it('does not suppress a post-inject remote reply even during handshake', () => {
    assert.equal(
      shouldSkipConnectTurnMirror({
        messageId: 'msg_answer',
        nonMirrorMessageIds: [],
        connectMirrorSuppressed: true,
        awaitingRemoteReply: true,
      }),
      false,
    )
  })

  it('does not skip an ordinary local reply after handshake cleared', () => {
    assert.equal(
      shouldSkipConnectTurnMirror({
        messageId: 'msg_local',
        nonMirrorMessageIds: ['msg_connect'],
        connectMirrorSuppressed: false,
        awaitingRemoteReply: false,
      }),
      false,
    )
  })

  // Session 8a97effc / connection 4aab7fe0: late command.executed tagged the
  // inject answer with the connect-skill message id; nonMirrorMessageIds must
  // not win over awaitingRemoteReply.
  it('never skips while awaitingRemoteReply even if answer id is in nonMirrorMessageIds (8a97effc)', () => {
    assert.equal(
      shouldSkipConnectTurnMirror({
        messageId: 'msg_fd7a125e2001jMlrosBkXrxYbv',
        nonMirrorMessageIds: ['msg_fd7a125e2001jMlrosBkXrxYbv'],
        connectMirrorSuppressed: false,
        awaitingRemoteReply: true,
      }),
      false,
    )
  })

  it('recognises remote-control skill command names', () => {
    assert.equal(isDevspecRemoteControlCommand('devspec.remote'), true)
    assert.equal(isDevspecRemoteControlCommand('devspec.remote-stop'), true)
    assert.equal(isDevspecRemoteControlCommand('devspec.create'), false)
  })
})

describe('shouldDeferInjectDuringConnect — mid-handshake owner command (6990fd9e)', () => {
  it('defers inject while connectMirrorSuppressed and not awaiting a reply', () => {
    assert.equal(
      shouldDeferInjectDuringConnect({
        connectMirrorSuppressed: true,
        awaitingRemoteReply: false,
      }),
      true,
    )
  })

  it('does not defer after handshake suppress clears', () => {
    assert.equal(
      shouldDeferInjectDuringConnect({
        connectMirrorSuppressed: false,
        awaitingRemoteReply: false,
      }),
      false,
    )
  })

  it('does not defer when already awaiting an inject reply (suppress may still be set)', () => {
    assert.equal(
      shouldDeferInjectDuringConnect({
        connectMirrorSuppressed: true,
        awaitingRemoteReply: true,
      }),
      false,
    )
  })
})

describe('shouldClaimConnectTurnSuppress — real answer under false connect tag (b156e680)', () => {
  it('does not claim while awaitingRemoteReply', () => {
    assert.equal(
      shouldClaimConnectTurnSuppress({
        awaitingRemoteReply: true,
        preparedText: null,
      }),
      false,
    )
  })

  it('does not claim when prepareMirrorText still has a real answer (banner + -1)', () => {
    const mixed = `${PLAIN_BANNER}\n\n-1.`
    assert.equal(prepareMirrorText(mixed), '-1.')
    assert.equal(
      shouldClaimConnectTurnSuppress({
        awaitingRemoteReply: false,
        preparedText: prepareMirrorText(mixed),
      }),
      false,
    )
  })

  it('claims pure connect chrome so the status turn is not rechecked forever', () => {
    assert.equal(prepareMirrorText(PLAIN_BANNER), null)
    assert.equal(
      shouldClaimConnectTurnSuppress({
        awaitingRemoteReply: false,
        preparedText: null,
      }),
      true,
    )
  })
})

describe('unansweredCommands — connect narration must not settle (regression)', () => {
  it('keeps a pending dispatch when no agent bubble was mirrored (post-fix)', () => {
    // After the connect-turn skip-mirror fix, the narration never enters the
    // room — so the seed filter correctly keeps the mid-attach dispatch.
    const cmds = [{ id: 'math', created_at: '2026-08-05T19:15:59.854Z' }]
    const room = []
    assert.deepEqual(unansweredCommands(cmds, room).map((c) => c.id), ['math'])
  })

  it('still settles when a real answer was mirrored after the dispatch', () => {
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
})

describe('unwrapSingleOuterMarkdownFence', () => {
  it('unwraps a single outer fence so the banner header is visible', () => {
    assert.equal(unwrapSingleOuterMarkdownFence(FENCED_BANNER).includes('━━━ DevSpec Remote Control ━━━'), true)
    assert.equal(unwrapSingleOuterMarkdownFence(FENCED_BANNER).startsWith('```'), false)
  })

  it('leaves non-fenced text alone', () => {
    assert.equal(unwrapSingleOuterMarkdownFence(PLAIN_BANNER), PLAIN_BANNER)
  })
})

describe('stripRemoteControlBanner', () => {
  it('removes the banner through the trailing rule line', () => {
    assert.equal(stripRemoteControlBanner(`${PLAIN_BANNER}\n\nhello`).trim(), 'hello')
  })
})

describe('unansweredCommands — empty/chrome bubbles do not settle', () => {
  it('still returns a prior command when the only later agent bubble is empty fences', () => {
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

  it('still returns a prior command when the later bubble is a fenced status banner', () => {
    const cmds = [{ id: 'math', created_at: '2026-08-04T11:16:30.000Z' }]
    const room = [
      {
        message_type: 'external_agent',
        author: { kind: 'external_agent' },
        created_at: '2026-08-04T11:17:53.000Z',
        content: FENCED_BANNER,
      },
    ]
    assert.deepEqual(unansweredCommands(cmds, room).map((c) => c.id), ['math'])
  })

  it('settles commands before a real agent reply', () => {
    const cmds = [
      { id: 'old', created_at: '2026-08-04T11:16:30.000Z' },
      { id: 'live', created_at: '2026-08-04T11:18:00.000Z' },
    ]
    const room = [
      {
        message_type: 'external_agent',
        author: { kind: 'external_agent' },
        created_at: '2026-08-04T11:17:53.000Z',
        content: '2',
      },
    ]
    assert.deepEqual(unansweredCommands(cmds, room).map((c) => c.id), ['live'])
  })

  it('fails open when agent reply content is missing (keep timestamp settlement)', () => {
    const cmds = [{ id: 'old', created_at: '2026-08-04T11:16:30.000Z' }]
    const room = [
      {
        message_type: 'external_agent',
        author: { kind: 'external_agent' },
        created_at: '2026-08-04T11:17:53.000Z',
        // content omitted — cannot prove chrome; do not re-deliver finished turns
      },
    ]
    assert.deepEqual(unansweredCommands(cmds, room).map((c) => c.id), [])
  })
})
