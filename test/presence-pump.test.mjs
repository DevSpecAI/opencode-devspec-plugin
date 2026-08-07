#!/usr/bin/env node
/**
 * Presence must keep updating last_seen while inject/LLM-adjacent work runs.
 * Regression for idle_timeout mid-conversation (item 875d75b5) and the
 * automated remote-control lifecycle suite (item a0302190).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OPENCODE_SESSION_API_TIMEOUT_MS,
  PRESENCE_GAP_WARN_MS,
  withTimeout,
  recordSuccessfulPoll,
  getLastSuccessfulPollAt,
  maybeWarnPresenceGap,
  logConnectionEndedStory,
  forgetPumpState,
} from '../dist/remote-control.js'
import { logRemoteControlStory } from '../dist/remote-control-story.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

describe('presence pump contracts', () => {
  it('exports session API timeout below the server idle window', () => {
    assert.equal(OPENCODE_SESSION_API_TIMEOUT_MS, 5_000)
    assert.ok(OPENCODE_SESSION_API_TIMEOUT_MS < 90_000)
    assert.equal(PRESENCE_GAP_WARN_MS, 60_000)
  })

  it('withTimeout rejects when the underlying promise never settles', async () => {
    const started = Date.now()
    await assert.rejects(
      () => withTimeout(new Promise(() => {}), 40, 'hang'),
      /timed out after 40ms/,
    )
    const elapsed = Date.now() - started
    assert.ok(elapsed < 2_000, `timeout took too long: ${elapsed}ms`)
  })

  it('withTimeout resolves when the promise wins the race', async () => {
    const value = await withTimeout(Promise.resolve(42), 1_000, 'ok')
    assert.equal(value, 42)
  })

  it('records successful polls and computes presence gap age', () => {
    const id = 'test-conn-presence-1'
    forgetPumpState(id)
    const t0 = 1_000_000
    recordSuccessfulPoll(id, t0)
    assert.equal(getLastSuccessfulPollAt(id), t0)

    const warned = maybeWarnPresenceGap({
      connectionId: id,
      sessionId: 'sess',
      busy: true,
      now: t0 + PRESENCE_GAP_WARN_MS + 1,
    })
    assert.equal(warned, true)

    // cooldown — second warn within cooldown is suppressed
    const warnedAgain = maybeWarnPresenceGap({
      connectionId: id,
      busy: true,
      now: t0 + PRESENCE_GAP_WARN_MS + 2,
    })
    assert.equal(warnedAgain, false)
    forgetPumpState(id)
  })

  it('ended story includes last_poll_age_ms and end reason', () => {
    const id = 'test-conn-ended-1'
    forgetPumpState(id)
    const t0 = Date.now() - 12_000
    recordSuccessfulPoll(id, t0)

    const logDir = path.join(os.homedir(), '.devspec', 'opencode-remote-control')
    const logFile = path.join(logDir, 'poll.log')
    fs.mkdirSync(logDir, { recursive: true })
    const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').length : 0

    logConnectionEndedStory({
      connectionId: id,
      sessionId: 'sess-ended',
      codename: 'Test Bird',
      endReason: 'idle_timeout',
      via: 'recoverable_exhausted',
      busy: true,
      now: t0 + 12_000,
    })

    const after = fs.readFileSync(logFile, 'utf8').slice(before)
    assert.match(after, /"phase":"ended"/)
    assert.match(after, /"reason":"idle_timeout"/)
    assert.match(after, /"last_poll_age_ms":12000/)
    assert.match(after, /"via":"recoverable_exhausted"/)
    forgetPumpState(id)
  })

  it('inject schedule contract: hung baseline work does not block a follow-up tick', async () => {
    // Simulates the presence pump: schedule deliver work, then immediately
    // "poll" again. The hung deliver must not gate the second tick.
    let polls = 0
    let deliverStarted = false
    let deliverFinished = false

    const deliver = async () => {
      deliverStarted = true
      await new Promise(() => {}) // hang forever (inject baseline / LLM)
    }

    const pollOnce = async () => {
      polls++
      if (polls === 1) {
        void deliver().then(() => {
          deliverFinished = true
        })
        return { delayMs: 0, stop: false }
      }
      return { delayMs: 0, stop: false }
    }

    await pollOnce()
    assert.equal(deliverStarted, true)
    assert.equal(deliverFinished, false)
    await pollOnce()
    assert.equal(polls, 2)
    assert.equal(deliverFinished, false)
  })
})

describe('remote-control story vocabulary for drops', () => {
  it('accepts ended / pickup / presence_gap story lines', () => {
    const logDir = path.join(os.homedir(), '.devspec', 'opencode-remote-control')
    const logFile = path.join(logDir, 'poll.log')
    fs.mkdirSync(logDir, { recursive: true })
    const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').length : 0

    logRemoteControlStory({
      phase: 'pickup',
      outcome: 'started',
      reason: 'inject_turn',
      connectionId: 'c1',
      agent: 'OpenCode',
    })
    logRemoteControlStory({
      phase: 'poll_error',
      outcome: 'presence_gap',
      reason: 'no_poll_since_pickup',
      connectionId: 'c1',
      data: { last_poll_age_ms: 65000, busy: true },
    })

    const after = fs.readFileSync(logFile, 'utf8').slice(before)
    assert.match(after, /"phase":"pickup"/)
    assert.match(after, /"outcome":"presence_gap"/)
    assert.match(after, /no_poll_since_pickup/)
  })
})
