#!/usr/bin/env node
/**
 * Mirror chrome filter — fence-aware status strip + unansweredCommands settlement
 * (item 4973de1f / session 0ffe97cb).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isOperationalChrome,
  prepareMirrorText,
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
