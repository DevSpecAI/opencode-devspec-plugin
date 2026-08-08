#!/usr/bin/env node
/**
 * Activity-aware busy stall (item c73d23a9) — tool-heavy turns must not
 * false-stall on empty reply text alone.
 * Permission-ask path (item bb633917) — hung permission.asked is not progress.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decideBusyStall,
  messageHasActiveToolWork,
  messageHasPendingPermissionAsk,
  assistantTextFromMessage,
  PERMISSION_ASK_STALL_MS,
} from '../dist/remote-control.js'

const TIMEOUT = 120_000

function assistant(id, parts) {
  return { info: { id, role: 'assistant' }, parts }
}

describe('messageHasActiveToolWork', () => {
  it('is true for pending or running tools', () => {
    assert.equal(
      messageHasActiveToolWork(assistant('m1', [{ type: 'tool', state: { status: 'running' } }])),
      true,
    )
    assert.equal(
      messageHasActiveToolWork(assistant('m1', [{ type: 'tool', state: { status: 'pending' } }])),
      true,
    )
  })

  it('is false for completed tools, reasoning, or text-only', () => {
    assert.equal(
      messageHasActiveToolWork(assistant('m1', [{ type: 'tool', state: { status: 'completed' } }])),
      false,
    )
    assert.equal(messageHasActiveToolWork(assistant('m1', [{ type: 'reasoning', text: '…' }])), false)
    assert.equal(messageHasActiveToolWork(assistant('m1', [{ type: 'text', text: 'hi' }])), false)
  })
})

describe('messageHasPendingPermissionAsk', () => {
  it('detects tool state ask / waiting / permission*', () => {
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

  it('detects permission part types and nested permission flags', () => {
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

  it('is false for ordinary running tools without an ask', () => {
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
  it('stays under_timeout before the wall clock elapses', () => {
    const d = decideBusyStall({
      elapsedMs: 30_000,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [{ type: 'tool', state: { status: 'running' } }]),
      previousProgressAssistantId: null,
    })
    assert.equal(d.action, 'under_timeout')
  })

  it('does not stall when the latest assistant has reply text', () => {
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

  it('slides on in-flight tools even with no reply text (Tembo tool-loop)', () => {
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

  it('slides when a new assistant message appears (even tool-only / empty)', () => {
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

  it('slides once when first past timeout with an unseen assistant id', () => {
    const d = decideBusyStall({
      elapsedMs: TIMEOUT + 1,
      timeoutMs: TIMEOUT,
      lastAssistant: assistant('m1', [{ type: 'tool', state: { status: 'completed' } }]),
      previousProgressAssistantId: null,
    })
    assert.equal(d.action, 'slide')
    assert.equal(d.reason, 'new_assistant')
  })

  it('stalls on true silence — same empty assistant, no active tools, past timeout', () => {
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

  it('stalls when there is no assistant message at all past timeout', () => {
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

  it('still slides active_tool on the same assistant before the slide cap', () => {
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

  it('stalls when the same assistant active_tool has already slid to the cap', () => {
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

  it('resets the active_tool slide budget when the assistant id changes', () => {
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

  it('never slides active_tool while a permission ask is pending', () => {
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

  it('stalls after the permission-ask window even with a running tool', () => {
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

  it('detects permission ask from message parts without an explicit flag', () => {
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

  it('without permission, active_tool still slides before the cap', () => {
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
})
