#!/usr/bin/env node
/**
 * Remote-control story emitter (item 1c480040).
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  logRemoteControlStory,
  REMOTE_CONTROL_STORY_PHASES,
} from '../dist/remote-control-story.js'

const tmpRoot = path.join(os.tmpdir(), `opencode-story-${process.pid}-${Date.now()}`)
const pollDir = path.join(tmpRoot, '.devspec', 'opencode-remote-control')
const pollFile = path.join(pollDir, 'poll.log')

describe('REMOTE_CONTROL_STORY_PHASES', () => {
  it('includes shared OpenCode/Cursor/server vocabulary', () => {
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('seed_filter'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('inject'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('mirror_decision'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('poll_error'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('stall'))
    assert.ok(REMOTE_CONTROL_STORY_PHASES.includes('wake'))
  })
})

describe('logRemoteControlStory', () => {
  let restoreHomedir

  beforeEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    fs.mkdirSync(pollDir, { recursive: true })
    restoreHomedir = mock.method(os, 'homedir', () => tmpRoot)
  })

  afterEach(() => {
    restoreHomedir?.mock?.restore?.()
    mock.restoreAll()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('appends a story JSON line to poll.log', () => {
    logRemoteControlStory({
      phase: 'seed_filter',
      outcome: 'dropped',
      connectionId: 'conn-1',
      sessionId: 'sess-1',
      agent: 'OpenCode',
      reason: 'already_answered',
      data: { dropped: 1 },
    })
    const body = fs.readFileSync(pollFile, 'utf8')
    assert.match(body, /story \{/)
    const line = body.trim().split('\n').pop()
    const json = JSON.parse(line.replace(/^\S+\s+story\s+/, ''))
    assert.equal(json.type, 'remote_control_story')
    assert.equal(json.phase, 'seed_filter')
    assert.equal(json.outcome, 'dropped')
    assert.equal(json.connectionId, 'conn-1')
    assert.equal(json.sessionId, 'sess-1')
    assert.equal(json.agent, 'OpenCode')
    assert.equal(json.reason, 'already_answered')
    assert.equal(json.dropped, 1)
  })
})
