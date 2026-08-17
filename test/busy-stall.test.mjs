#!/usr/bin/env node
/**
 * Activity-aware busy stall (item c73d23a9) — tool-heavy turns must not
 * false-stall on empty reply text alone.
 * Permission-ask path (item bb633917) — hung permission.asked is not progress.
 * Baseline-scoped stall + inject-turn cleanup (item 40279ae0).
 * Reasoning growth (item 10bdce1c) — MiniMax-style long thinks count as progress.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, after, beforeEach } from 'node:test'
import {
  clearInjectTurnState,
  decideAwaitingBaseline,
  decideBusyStall,
  messageHasActiveToolWork,
  messageHasPendingPermissionAsk,
  assistantTextFromMessage,
  assistantReasoningFingerprint,
  readState,
  resetBondsForTests,
  scopeAssistantsAfterBaseline,
  writeState,
  PERMISSION_ASK_STALL_MS,
  runWithBondAsync,
} from '../dist/remote-control.js'

const TIMEOUT = 120_000

function assistant(id, parts) {
  return { info: { id, role: 'assistant' }, parts }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-devspec-stall-'))
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
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-busy_stall-home-'))
const TEST_BOND = 'ses_test_bond_busy_stall'
const itInBond = (name, fn) => it(name, () => runWithBondAsync(TEST_BOND, async () => fn()))

describe('messageHasActiveToolWork', () => {
  itInBond('is true for pending or running tools', () => {
    assert.equal(
      messageHasActiveToolWork(assistant('m1', [{ type: 'tool', state: { status: 'running' } }])),
      true,
    )
    assert.equal(
      messageHasActiveToolWork(assistant('m1', [{ type: 'tool', state: { status: 'pending' } }])),
      true,
    )
  })

  itInBond('is false for completed tools, reasoning, or text-only', () => {
    assert.equal(
      messageHasActiveToolWork(assistant('m1', [{ type: 'tool', state: { status: 'completed' } }])),
      false,
    )
    assert.equal(messageHasActiveToolWork(assistant('m1', [{ type: 'reasoning', text: '…' }])), false)
    assert.equal(messageHasActiveToolWork(assistant('m1', [{ type: 'text', text: 'hi' }])), false)
  })
})

describe('messageHasPendingPermissionAsk', () => {
  itInBond('detects tool state ask / waiting / permission*', () => {
    assert.equal(
      messageHasPendingPermissionAsk(
        assistant('m1', [{ type: 'tool', state: { status: 'ask' } }]),
      ),
      true,
    )
    assert.equal(
      messageHasPendingPermissionAsk(
        assistant('m1', [{ type: 'tool', state: { status: 'waiting' } }]),
      ),
      true,
    )
    assert.equal(
      messageHasPendingPermissionAsk(
        assistant('m1', [{ type: 'tool', state: { status: 'awaiting_permission' } }]),
      ),
      true,
    )
    assert.equal(
      messageHasPendingPermissionAsk(
        assistant('m1', [{ type: 'tool', state: { status: 'permission' } }]),
      ),
      true,
    )
  })

  itInBond('detects permission part types and nested permission flags', () => {
    assert.equal(
      messageHasPendingPermissionAsk(assistant('m1', [{ type: 'permission' }])),
      true,
    )
    assert.equal(
      messageHasPendingPermissionAsk(
        assistant('m1', [{ type: 'tool', state: { status: 'running', permissionAsk: true } }]),
      ),
      true,
    )
    assert.equal(
      messageHasPendingPermissionAsk(
        assistant('m1', [
          { type: 'tool', state: { status: 'running', permission: { status: 'asked' } } },
        ]),
      ),
      true,
    )
  })

  itInBond('is false for ordinary running tools without an ask', () => {
    assert.equal(
      messageHasPendingPermissionAsk(
        assistant('m1', [{ type: 'tool', state: { status: 'running' } }]),
      ),
      false,
    )
    assert.equal(
      messageHasPendingPermissionAsk(assistant('m1', [{ type: 'text', text: 'hi' }])),
      false,
    )
  })
})

describe('decideBusyStall', () => {
  itInBond('stays under_timeout before the wall clock elapses', () => {
    const d = decideBusyStall({
      elapsedMs: 30_000,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [{ type: 'tool', state: { status: 'running' } }]),
      previousProgressAssistantId: null,
    })
    assert.equal(d.action, 'under_timeout')
  })

  itInBond('does not stall when the latest assistant has reply text', () => {
    const msg = assistant('m1', [{ type: 'text', text: 'done' }])
    assert.ok(assistantTextFromMessage(msg))
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: msg,
      previousProgressAssistantId: 'm1',
    })
    assert.equal(d.action, 'has_text')
  })

  itInBond('slides on in-flight tools even with no reply text (Tembo tool-loop)', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 5_000,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [
        { type: 'reasoning', text: 'installing…' },
        { type: 'tool', state: { status: 'running' } },
      ]),
      previousProgressAssistantId: 'm1',
    })
    assert.equal(d.action, 'slide')
    assert.equal(d.reason, 'active_tool')
    assert.equal(d.assistantId, 'm1')
  })

  itInBond('slides when a new assistant message appears (even tool-only / empty)', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m2', [{ type: 'tool', state: { status: 'completed' } }]),
      previousProgressAssistantId: 'm1',
    })
    assert.equal(d.action, 'slide')
    assert.equal(d.reason, 'new_assistant')
    assert.equal(d.assistantId, 'm2')
  })

  itInBond('slides once when first past timeout with an unseen assistant id', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [{ type: 'tool', state: { status: 'completed' } }]),
      previousProgressAssistantId: null,
    })
    assert.equal(d.action, 'slide')
    assert.equal(d.reason, 'new_assistant')
  })

  itInBond('stalls on true silence — same empty assistant, no active tools, past timeout', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [{ type: 'tool', state: { status: 'completed' } }]),
      previousProgressAssistantId: 'm1',
    })
    assert.equal(d.action, 'stall')
    assert.equal(d.reason, 'empty_assistant_timeout')
    assert.equal(d.assistantId, 'm1')
  })

  itInBond('stalls when there is no assistant message at all past timeout', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: null,
      previousProgressAssistantId: null,
    })
    assert.equal(d.action, 'stall')
    assert.equal(d.reason, 'empty_assistant_timeout')
    assert.equal(d.assistantId, null)
  })

  itInBond('still slides active_tool on the same assistant before the slide cap', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [{ type: 'tool', state: { status: 'running' } }]),
      previousProgressAssistantId: 'm1',
      sameAssistantActiveToolSlides: 1,
      maxActiveToolSlides: 2,
    })
    assert.equal(d.action, 'slide')
    assert.equal(d.reason, 'active_tool')
  })

  itInBond('stalls when the same assistant active_tool has already slid to the cap', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [{ type: 'tool', state: { status: 'running' } }]),
      previousProgressAssistantId: 'm1',
      sameAssistantActiveToolSlides: 2,
      maxActiveToolSlides: 2,
    })
    assert.equal(d.action, 'stall')
    assert.equal(d.reason, 'active_tool_cap')
    assert.equal(d.assistantId, 'm1')
  })

  itInBond('resets the active_tool slide budget when the assistant id changes', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m2', [{ type: 'tool', state: { status: 'running' } }]),
      previousProgressAssistantId: 'm1',
      sameAssistantActiveToolSlides: 2,
      maxActiveToolSlides: 2,
    })
    assert.equal(d.action, 'slide')
    assert.equal(d.reason, 'active_tool')
    assert.equal(d.assistantId, 'm2')
  })

  itInBond('never slides active_tool while a permission ask is pending', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [{ type: 'tool', state: { status: 'running' } }]),
      previousProgressAssistantId: 'm1',
      sameAssistantActiveToolSlides: 0,
      maxActiveToolSlides: 2,
      permissionAskPending: true,
      permissionAskElapsedMs: 1_000,
      permissionAskStallMs: PERMISSION_ASK_STALL_MS,
    })
    assert.equal(d.action, 'under_timeout')
  })

  itInBond('stalls after the permission-ask window even with a running tool', () => {
    const d = decideBusyStall({
      elapsedMs: 20_000,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [
        { type: 'tool', state: { status: 'running' } },
        { type: 'permission' },
      ]),
      previousProgressAssistantId: 'm1',
      sameAssistantActiveToolSlides: 0,
      maxActiveToolSlides: 2,
      permissionAskPending: true,
      permissionAskElapsedMs: PERMISSION_ASK_STALL_MS,
      permissionAskStallMs: PERMISSION_ASK_STALL_MS,
    })
    assert.equal(d.action, 'stall')
    assert.equal(d.reason, 'permission_asked')
    assert.equal(d.assistantId, 'm1')
  })

  itInBond('detects permission ask from message parts without an explicit flag', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [{ type: 'tool', state: { status: 'ask' } }]),
      previousProgressAssistantId: 'm1',
      permissionAskElapsedMs: PERMISSION_ASK_STALL_MS,
    })
    assert.equal(d.action, 'stall')
    assert.equal(d.reason, 'permission_asked')
  })

  itInBond('without permission, active_tool still slides before the cap', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [{ type: 'tool', state: { status: 'running' } }]),
      previousProgressAssistantId: 'm1',
      sameAssistantActiveToolSlides: 0,
      maxActiveToolSlides: 2,
      permissionAskPending: false,
    })
    assert.equal(d.action, 'slide')
    assert.equal(d.reason, 'active_tool')
  })

  itInBond('slides when reasoning grows on the same assistant (MiniMax long think)', () => {
    const early = assistant('m1', [{ type: 'reasoning', text: 'planning…' }])
    const earlyFp = assistantReasoningFingerprint(early)
    assert.ok(earlyFp)
    const later = assistant('m1', [
      { type: 'reasoning', text: 'planning… then checking the stall path in detail…' },
    ])
    const laterFp = assistantReasoningFingerprint(later)
    assert.ok(laterFp)
    assert.notEqual(earlyFp, laterFp)
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 11_000,
      timeoutMs: TIMEOUT,
      lastAssistant: later,
      previousProgressAssistantId: 'm1',
      previousReasoningFingerprint: earlyFp,
    })
    assert.equal(d.action, 'slide')
    assert.equal(d.reason, 'reasoning_growth')
    assert.equal(d.assistantId, 'm1')
    assert.equal(d.reasoningFingerprint, laterFp)
  })

  itInBond('slides on first seen reasoning fingerprint even when assistant id already tracked', () => {
    const msg = assistant('m1', [{ type: 'thinking', text: 'deep think' }])
    const fp = assistantReasoningFingerprint(msg)
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: msg,
      previousProgressAssistantId: 'm1',
      previousReasoningFingerprint: null,
    })
    assert.equal(d.action, 'slide')
    assert.equal(d.reason, 'reasoning_growth')
    assert.equal(d.reasoningFingerprint, fp)
  })

  itInBond('stalls when reasoning is frozen on the same assistant past timeout', () => {
    const msg = assistant('m1', [{ type: 'reasoning', text: 'stuck mid-thought' }])
    const fp = assistantReasoningFingerprint(msg)
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: msg,
      previousProgressAssistantId: 'm1',
      previousReasoningFingerprint: fp,
    })
    assert.equal(d.action, 'stall')
    assert.equal(d.reason, 'empty_assistant_timeout')
  })

  itInBond('prefers active_tool over reasoning_growth when a tool is in flight', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [
        { type: 'reasoning', text: 'still thinking while tool runs…' },
        { type: 'tool', state: { status: 'running' } },
      ]),
      previousProgressAssistantId: 'm1',
      previousReasoningFingerprint: '1:deadbeef',
      sameAssistantActiveToolSlides: 0,
      maxActiveToolSlides: 2,
    })
    assert.equal(d.action, 'slide')
    assert.equal(d.reason, 'active_tool')
  })
})

describe('assistantReasoningFingerprint', () => {
  itInBond('returns null without reasoning/thinking parts', () => {
    assert.equal(assistantReasoningFingerprint(assistant('m1', [{ type: 'text', text: 'hi' }])), null)
    assert.equal(
      assistantReasoningFingerprint(
        assistant('m1', [{ type: 'tool', state: { status: 'completed' } }]),
      ),
      null,
    )
  })

  itInBond('changes when reasoning text grows', () => {
    const a = assistantReasoningFingerprint(assistant('m1', [{ type: 'reasoning', text: 'a' }]))
    const b = assistantReasoningFingerprint(assistant('m1', [{ type: 'reasoning', text: 'ab' }]))
    assert.ok(a && b)
    assert.notEqual(a, b)
  })
})

// Item 40279ae0: checkBusyStall must scope its "last assistant" to messages
// AFTER the pre-inject baseline, not the global last assistant in the
// session — otherwise a stale, already-answered turn's real text makes a
// brand-new, genuinely silent turn look "not a stall".
describe('scopeAssistantsAfterBaseline (checkBusyStall baseline scoping)', () => {
  const assistants = [
    assistant('a1', [{ type: 'text', text: 'OLD ANSWERED TURN' }]),
    assistant('a2', [{ type: 'text', text: 'newer, still part of old turn' }]),
  ]

  itInBond('slice: only assistants strictly after the baseline are candidates', () => {
    const decision = decideAwaitingBaseline({
      baseline: 'a1',
      baselineCaptured: true,
      assistantIds: ['a1', 'a2'],
    })
    assert.equal(decision.action, 'slice')
    // a2 is genuinely after baseline a1 — a real candidate for this turn,
    // not the pre-inject baseline message itself.
    const scoped = scopeAssistantsAfterBaseline(assistants, decision)
    assert.equal(scoped.length, 1)
    assert.equal(scoped[0].info.id, 'a2')
  })

  itInBond('wait: baseline is the newest assistant — no progress yet, not the stale text', () => {
    const decision = decideAwaitingBaseline({
      baseline: 'a2',
      baselineCaptured: true,
      assistantIds: ['a1', 'a2'],
    })
    assert.equal(decision.action, 'wait')
    const scoped = scopeAssistantsAfterBaseline(assistants, decision)
    assert.deepEqual(scoped, [])
    // Confirms the regression this closes: decideBusyStall must see nothing
    // (and so correctly stall on true silence) rather than a2's real text.
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: scoped[scoped.length - 1],
      previousProgressAssistantId: null,
    })
    assert.equal(d.action, 'stall')
    assert.equal(d.reason, 'empty_assistant_timeout')
  })

  itInBond('a genuine new post-inject assistant is still visible for progress', () => {
    const withNew = [...assistants, assistant('a3', [{ type: 'text', text: 'real reply' }])]
    const decision = decideAwaitingBaseline({
      baseline: 'a2',
      baselineCaptured: true,
      assistantIds: ['a1', 'a2', 'a3'],
    })
    assert.equal(decision.action, 'slice')
    const scoped = scopeAssistantsAfterBaseline(withNew, decision)
    assert.equal(scoped.length, 1)
    assert.equal(scoped[0].info.id, 'a3')
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: scoped[scoped.length - 1],
      previousProgressAssistantId: null,
    })
    assert.equal(d.action, 'has_text')
  })

  itInBond('fail_closed_snapshot: baseline snapshot failed — treated as no progress, not all history', () => {
    const decision = decideAwaitingBaseline({
      baseline: 'a1',
      baselineCaptured: false,
      assistantIds: ['a1', 'a2'],
    })
    assert.deepEqual(scopeAssistantsAfterBaseline(assistants, decision), [])
  })

  itInBond('all: empty history at inject — every assistant is new', () => {
    const decision = decideAwaitingBaseline({
      baseline: null,
      baselineCaptured: true,
      assistantIds: ['a1', 'a2'],
    })
    assert.deepEqual(scopeAssistantsAfterBaseline(assistants, decision), assistants)
  })

  itInBond('fail_closed_legacy: no baseline info at all — lenient fallback to full history', () => {
    const decision = decideAwaitingBaseline({
      baseline: null,
      baselineCaptured: undefined,
      assistantIds: ['a1', 'a2'],
    })
    assert.equal(decision.action, 'fail_closed_legacy')
    assert.deepEqual(scopeAssistantsAfterBaseline(assistants, decision), assistants)
  })
})

describe('clearInjectTurnState (item 40279ae0)', () => {
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
      awaitingRemoteReply: true,
      replyAfterOpenCodeMessageId: 'msg_base',
      replyBaselineCaptured: true,
      manualAnswerPostedThisTurn: true,
      activeTrailMessageId: 'trail-1',
      lastTrailHash: 'hash-1',
      lastTrailPostedAt: 111,
      deliveredMessageIds: ['cmd-1', 'cmd-2', 'cmd-3'],
      currentTurnMessageIds: ['cmd-2', 'cmd-3'],
      ...extra,
    })
  }

  itInBond('clears awaiting/baseline/trail/manual-post state without touching deliveredMessageIds by default', () => {
    const dir = tmpDir()
    dirs.push(dir)
    seedState(dir)

    clearInjectTurnState()

    const fresh = readState()
    assert.equal(fresh?.awaitingRemoteReply, false)
    assert.equal(fresh?.replyAfterOpenCodeMessageId, null)
    assert.equal(fresh?.currentTurnMessageIds, null)
    assert.equal(fresh?.manualAnswerPostedThisTurn, false)
    assert.equal(fresh?.activeTrailMessageId, null)
    assert.equal(fresh?.lastTrailHash, null)
    assert.equal(fresh?.lastTrailPostedAt, null)
    // A CLEAN end never unclaims — the command was genuinely answered.
    assert.deepEqual(fresh?.deliveredMessageIds, ['cmd-1', 'cmd-2', 'cmd-3'])
  })

  itInBond('unclaim:true removes exactly this turn\'s ids from deliveredMessageIds — the stuck-turn fix', () => {
    const dir = tmpDir()
    dirs.push(dir)
    seedState(dir)

    clearInjectTurnState({ unclaim: true })

    const fresh = readState()
    assert.equal(fresh?.awaitingRemoteReply, false)
    assert.equal(fresh?.currentTurnMessageIds, null)
    // cmd-2/cmd-3 belonged to the stalled turn — unclaimed so they can
    // re-inject. cmd-1 belonged to an earlier, already-answered turn and
    // must survive untouched.
    assert.deepEqual(fresh?.deliveredMessageIds, ['cmd-1'])
  })

  itInBond('is a safe no-op when there is no state file for the directory', () => {
    const dir = tmpDir()
    dirs.push(dir)
    assert.doesNotThrow(() => clearInjectTurnState({ unclaim: true }))
  })
})
