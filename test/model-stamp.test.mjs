#!/usr/bin/env node
/**
 * Model stamp extraction + loud model_missing path (item f9e747bd).
 * Obsidian Gecko RCA: silent drop of reply model left DevSpec with no record
 * of which model answered.
 */
import assert from 'node:assert/strict'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  extractOpenCodeReplyModel,
  summarizeModelShapeSnippet,
  modelStoryData,
} from '../dist/remote-control.js'
import { logRemoteControlStory } from '../dist/remote-control-story.js'

const tmpRoot = path.join(os.tmpdir(), `opencode-model-${process.pid}-${Date.now()}`)
const pollDir = path.join(tmpRoot, '.devspec', 'opencode-remote-control')
const pollFile = path.join(pollDir, 'poll.log')

describe('extractOpenCodeReplyModel', () => {
  it('accepts canonical providerID/modelID', () => {
    const r = extractOpenCodeReplyModel({ providerID: 'anthropic', modelID: 'claude-opus-4' })
    assert.deepEqual(r.model, { providerID: 'anthropic', modelID: 'claude-opus-4' })
    assert.equal(r.missingReason, undefined)
  })

  it('accepts provider/model and camelCase aliases', () => {
    assert.deepEqual(extractOpenCodeReplyModel({ provider: 'openai', model: 'gpt-5' }).model, {
      providerID: 'openai',
      modelID: 'gpt-5',
    })
    assert.deepEqual(
      extractOpenCodeReplyModel({ providerId: 'google', modelId: 'gemini-3' }).model,
      { providerID: 'google', modelID: 'gemini-3' },
    )
  })

  it('accepts provider/model slash string', () => {
    assert.deepEqual(extractOpenCodeReplyModel('anthropic/claude-sonnet-4').model, {
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
    })
  })

  it('reports absent / non_object / missing_fields with raw snippet', () => {
    assert.equal(extractOpenCodeReplyModel(undefined).missingReason, 'absent')
    assert.equal(extractOpenCodeReplyModel(null).missingReason, 'absent')

    const bad = extractOpenCodeReplyModel(42)
    assert.equal(bad.missingReason, 'non_object')
    assert.equal(bad.rawSnippet, '42')

    const partial = extractOpenCodeReplyModel({ providerID: 'anthropic', foo: 1 })
    assert.equal(partial.missingReason, 'empty_fields')
    assert.match(partial.rawSnippet ?? '', /providerID/)

    const weird = extractOpenCodeReplyModel({ vendor: 'x', id: 'y' })
    assert.equal(weird.missingReason, 'missing_fields')
    assert.match(weird.rawSnippet ?? '', /vendor/)
  })
})

describe('summarizeModelShapeSnippet / modelStoryData', () => {
  it('truncates long JSON and formats known model for stories', () => {
    const long = { a: 'x'.repeat(400) }
    const snip = summarizeModelShapeSnippet(long)
    assert.ok(snip.length <= 241)
    assert.ok(snip.endsWith('…'))

    assert.deepEqual(modelStoryData({ providerID: 'p', modelID: 'm' }), {
      model: 'p/m',
      providerID: 'p',
      modelID: 'm',
    })
    assert.deepEqual(modelStoryData(undefined), {})
  })
})

describe('loud model_missing story (mirror_post)', () => {
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

  it('emits mirror_post/model_missing with connectionId, sessionId, and raw shape', () => {
    const extracted = extractOpenCodeReplyModel({ provider: 'anthropic' })
    assert.equal(extracted.model, undefined)

    logRemoteControlStory({
      phase: 'mirror_post',
      outcome: 'model_missing',
      connectionId: 'conn-gecko',
      sessionId: 'sess-a2a262cd',
      agent: 'OpenCode',
      codename: 'Restless Ocelot',
      tool: 'post_session_message',
      reason: extracted.missingReason ?? 'absent',
      data: {
        message_id: 'msg-1',
        model_shape: extracted.rawSnippet ?? summarizeModelShapeSnippet({ provider: 'anthropic' }),
        source: 'info.model',
      },
    })

    const body = fs.readFileSync(pollFile, 'utf8')
    const line = body.trim().split('\n').pop()
    const json = JSON.parse(line.replace(/^\S+\s+story\s+/, ''))
    assert.equal(json.type, 'remote_control_story')
    assert.equal(json.phase, 'mirror_post')
    assert.equal(json.outcome, 'model_missing')
    assert.equal(json.connectionId, 'conn-gecko')
    assert.equal(json.sessionId, 'sess-a2a262cd')
    assert.equal(json.agent, 'OpenCode')
    assert.equal(json.message_id, 'msg-1')
    assert.match(String(json.model_shape), /provider/)
    assert.ok(json.reason)
  })
})
