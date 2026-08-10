#!/usr/bin/env node
/**
 * Live work trail serialization + throttle (DevSpec item bfca2495).
 *
 * The trail is the opposite of the mirror: unfiltered, cumulative, and posted
 * many times per turn. These cover the three things that would break the feature
 * quietly — losing a tool call to an unfamiliar part shape, republishing an older
 * turn as live work, and turning `message.updated` into an MCP call per token.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  TRAIL_MAX_CHARS,
  TRAIL_POST_MIN_GAP_MS,
  TRAIL_SEED_TEXT,
  TRAIL_TRIM_NOTICE,
  clampTrail,
  elideLongOutput,
  serializeTrailPart,
  serializeTurnTrail,
  shouldPostTrail,
} from '../dist/work-trail.js'
import { extractPostedMessageId } from '../dist/remote-control.js'

const assistant = (id, parts) => ({ info: { id, role: 'assistant' }, parts })

describe('serializeTrailPart', () => {
  it('keeps assistant text verbatim (no chrome filtering)', () => {
    assert.equal(
      serializeTrailPart({ type: 'text', text: '━━━ DevSpec Remote Control ━━━' }),
      '━━━ DevSpec Remote Control ━━━',
    )
  })

  it('drops empty text and step boundaries — structure, not output', () => {
    assert.equal(serializeTrailPart({ type: 'text', text: '   ' }), null)
    assert.equal(serializeTrailPart({ type: 'step-start' }), null)
    assert.equal(serializeTrailPart({ type: 'step-finish' }), null)
  })

  it('renders a running tool call as a command line with a running marker', () => {
    const out = serializeTrailPart({
      type: 'tool',
      tool: 'bash',
      state: { status: 'running', input: { command: 'npm run typecheck' } },
    })
    assert.equal(out, '$ bash command=npm run typecheck\n  … running')
  })

  it('renders a completed tool call with its output', () => {
    const out = serializeTrailPart({
      type: 'tool',
      tool: 'read',
      state: { status: 'completed', input: { filePath: 'src/a.ts' }, output: 'line one\nline two' },
    })
    assert.equal(out, '$ read filePath=src/a.ts\nline one\nline two')
  })

  it('surfaces a tool error instead of its (absent) output', () => {
    const out = serializeTrailPart({
      type: 'tool',
      tool: 'bash',
      state: { status: 'error', input: { command: 'exit 1' }, error: 'exit code 1' },
    })
    assert.equal(out, '$ bash command=exit 1\nerror: exit code 1')
  })

  it('elides a single part only when it alone exceeds the trail budget', () => {
    const body = `HEAD${'x'.repeat(TRAIL_MAX_CHARS + 10_000)}TAIL`
    const out = serializeTrailPart({
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', output: body },
    })
    assert.ok(out.length < body.length)
    assert.ok(out.includes('chars elided'))
    assert.ok(out.includes('HEAD'))
    assert.ok(out.endsWith('TAIL'))
  })

  it('keeps an unfamiliar part rather than dropping it', () => {
    const out = serializeTrailPart({ type: 'snapshot', snapshot: 'abc123' })
    assert.ok(out.startsWith('[snapshot] '))
    assert.ok(out.includes('abc123'))
  })

  it('renders reasoning with a marker so it is not mistaken for the answer', () => {
    assert.equal(serializeTrailPart({ type: 'reasoning', text: 'thinking about it' }), '» thinking about it')
  })
})

describe('elideLongOutput', () => {
  it('leaves output under the cap untouched', () => {
    assert.equal(elideLongOutput('short'), 'short')
  })
})

describe('serializeTurnTrail', () => {
  it('serializes only assistant messages after the pre-inject baseline', () => {
    const trail = serializeTurnTrail(
      [
        assistant('a1', [{ type: 'text', text: 'OLD TURN' }]),
        assistant('a2', [{ type: 'text', text: 'new work' }]),
        assistant('a3', [{ type: 'text', text: 'more work' }]),
      ],
      { afterMessageId: 'a1' },
    )
    assert.ok(!trail.includes('OLD TURN'))
    assert.equal(trail, 'new work\n\nmore work')
  })

  it('falls back to the newest assistant only — never the whole history', () => {
    const trail = serializeTurnTrail([
      assistant('a1', [{ type: 'text', text: 'OLD TURN' }]),
      assistant('a2', [{ type: 'text', text: 'current' }]),
    ])
    assert.equal(trail, 'current')
  })

  it('ignores a vanished baseline the same way (newest assistant only)', () => {
    const trail = serializeTurnTrail(
      [assistant('a1', [{ type: 'text', text: 'only' }])],
      { afterMessageId: 'gone' },
    )
    assert.equal(trail, 'only')
  })

  it('skips user messages and empty sessions', () => {
    assert.equal(serializeTurnTrail([{ info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'hi' }] }]), '')
    assert.equal(serializeTurnTrail([]), '')
    assert.equal(serializeTurnTrail(null), '')
  })
})

describe('clampTrail', () => {
  it('keeps the most recent output and marks the trim', () => {
    const clamped = clampTrail('A'.repeat(TRAIL_MAX_CHARS + 500) + 'END')
    assert.ok(clamped.length <= TRAIL_MAX_CHARS)
    assert.ok(clamped.startsWith(TRAIL_TRIM_NOTICE))
    assert.ok(clamped.endsWith('END'))
  })
})

describe('shouldPostTrail', () => {
  const base = { trail: 'work', trailHash: 'h1', now: 10_000 }

  it('posts the first update of a turn immediately', () => {
    assert.equal(shouldPostTrail({ ...base, lastPostedAt: null, lastPostedTrailHash: null }), true)
  })

  it('never posts an empty trail (would open a bubble with nothing in it)', () => {
    assert.equal(shouldPostTrail({ ...base, trail: '   ' }), false)
  })

  it('skips an unchanged trail even after the throttle window', () => {
    assert.equal(
      shouldPostTrail({ ...base, lastPostedTrailHash: 'h1', lastPostedAt: 0 }),
      false,
    )
  })

  it('throttles a changed trail inside the minimum gap', () => {
    assert.equal(
      shouldPostTrail({
        ...base,
        lastPostedTrailHash: 'h0',
        lastPostedAt: base.now - (TRAIL_POST_MIN_GAP_MS - 1),
      }),
      false,
    )
  })

  it('posts a changed trail once the gap has elapsed', () => {
    assert.equal(
      shouldPostTrail({
        ...base,
        lastPostedTrailHash: 'h0',
        lastPostedAt: base.now - TRAIL_POST_MIN_GAP_MS,
      }),
      true,
    )
  })

  it('force overrides the throttle but not the no-change guard', () => {
    assert.equal(
      shouldPostTrail({ ...base, lastPostedTrailHash: 'h0', lastPostedAt: base.now, force: true }),
      true,
    )
    assert.equal(
      shouldPostTrail({ ...base, lastPostedTrailHash: 'h1', lastPostedAt: base.now, force: true }),
      false,
    )
  })

  // Item 05a88ed5: eager "Working…" trail on turn start.
  describe('force + seed (turn-start placeholder)', () => {
    const emptyBase = { trail: '', trailHash: 'empty-hash', now: 10_000 }

    it('refuses an empty trail even when seeded, unless also forced', () => {
      assert.equal(
        shouldPostTrail({ ...emptyBase, lastPostedAt: null, lastPostedTrailHash: null, seed: true }),
        false,
      )
    })

    it('refuses a forced empty trail when not seeded (no placeholder requested)', () => {
      assert.equal(
        shouldPostTrail({ ...emptyBase, lastPostedAt: null, lastPostedTrailHash: null, force: true }),
        false,
      )
    })

    it('allows a forced + seeded empty trail through — the turn-start placeholder', () => {
      assert.equal(
        shouldPostTrail({
          ...emptyBase,
          lastPostedAt: null,
          lastPostedTrailHash: null,
          force: true,
          seed: true,
        }),
        true,
      )
    })

    it('still refuses a repeat seed post once the placeholder already landed', () => {
      assert.equal(
        shouldPostTrail({
          ...emptyBase,
          lastPostedAt: 9_000,
          lastPostedTrailHash: 'empty-hash',
          force: true,
          seed: true,
        }),
        false,
      )
    })

    it('never lets seed clobber real content — a non-empty trail ignores the flag', () => {
      // Real content always takes the normal (non-seed) path, so a race between
      // the eager seed call and a message.updated-triggered post can never
      // regress real content back to the placeholder (item 05a88ed5, "one trail row").
      assert.equal(
        shouldPostTrail({
          trail: 'real progress',
          trailHash: 'real-hash',
          lastPostedAt: null,
          lastPostedTrailHash: null,
          now: 10_000,
          seed: true,
        }),
        true,
      )
    })
  })
})

describe('TRAIL_SEED_TEXT', () => {
  it('is a non-empty placeholder distinct from any real trail content', () => {
    assert.equal(typeof TRAIL_SEED_TEXT, 'string')
    assert.ok(TRAIL_SEED_TEXT.trim().length > 0)
  })
})

describe('extractPostedMessageId', () => {
  it('reads message_id out of the MCP text content block', () => {
    const result = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, message_id: 'msg-1' }) }],
    }
    assert.equal(extractPostedMessageId(result), 'msg-1')
  })

  it('reads message_id from the unwrapped mcpToolsCall success object', () => {
    // Live path: mcpToolsCall JSON.parses the tool body and returns it directly.
    assert.equal(
      extractPostedMessageId({
        message_id: '6705e707-18d6-4d42-923b-29ae8a801af8',
        session_id: 'bf7acd8c-61e5-4f44-8e93-2dfc668f8b35',
        phase: 'answer',
        complete_turn: true,
      }),
      '6705e707-18d6-4d42-923b-29ae8a801af8',
    )
  })

  it('returns null for a plain-text or malformed result rather than throwing', () => {
    assert.equal(extractPostedMessageId({ content: [{ type: 'text', text: 'Session not found' }] }), null)
    assert.equal(extractPostedMessageId({ content: [] }), null)
    assert.equal(extractPostedMessageId(null), null)
    assert.equal(extractPostedMessageId({ ok: true }), null)
  })
})
