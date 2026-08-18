#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { DevSpecPlugin } from '../dist/plugin.js'
import {
  bondLocalId,
  readState,
  rememberOpenCodeBond,
  resetBondsForTests,
  runWithBond,
} from '../dist/remote-control.js'
import {
  classifyPreclaimTool,
  isMutationTool,
  TrackBeforeMutation,
} from '../dist/track-before-mutation.js'

const ITEM = 'cdd7a494-ed6a-414b-9f8f-bd0741b9de55'
const OTHER_ITEM = '11111111-2222-3333-4444-555555555555'
const claimed = (id = ITEM, status = 'claimed') => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        claim_success: true,
        action_item_id: id,
        action_item: { id, status },
      }),
    },
  ],
})
const succeeded = () => ({ output: JSON.stringify({ success: true }) })

describe('fail-closed preclaim tool classification', () => {
  it('allows only exact recognized discovery and DevSpec tracking tools', () => {
    for (const tool of ['read', 'grep', 'glob', 'find', 'ls', 'list', 'tree', 'webfetch']) {
      assert.equal(classifyPreclaimTool(tool), 'read_only', tool)
    }
    for (const tool of [
      'claim_work_item',
      'devspec_claim_work_item',
      'devspec.claim_work_item',
      'devspec/claim_work_item',
      'devspec__claim_work_item',
      'mcp__devspec__claim_work_item',
      'mcp.devspec.claim_work_item',
      'mcp/devspec/claim_work_item',
      'devspec_create_action_item',
      'devspec.search_index',
      'mcp__devspec__get_action_items',
      'register_connection',
      'devspec_register_connection',
      'attach_connection',
      'devspec.attach_connection',
      'get_session_transcript',
      'mcp__devspec__get_session_transcript',
    ]) {
      assert.equal(classifyPreclaimTool(tool), 'devspec_tracking', tool)
    }
    for (const tool of [
      'fake_register_connection',
      'mcp__evil__attach_connection',
      'get_session_transcript_suffix',
    ]) {
      assert.equal(classifyPreclaimTool(tool), 'unknown', `${tool} is not an exact DevSpec verb`)
    }
  })

  it('classifies exact mutation aliases without lexical false positives', () => {
    for (const tool of [
      'edit',
      'functions.write_file',
      'MultiEdit',
      'str_replace_editor',
      'apply-patch',
      'functions__apply_patch',
      'delete_file',
      'move',
      'save_file',
      'bash',
      'tools.shell_execute',
      'PowerShell',
      'terminal_execute',
    ]) {
      assert.equal(isMutationTool(tool), true, tool)
    }
    for (const tool of ['credit', 'nutshell', 'shellfish', 'writer', 'readme']) {
      assert.equal(isMutationTool(tool), false, `${tool} is not a mutation alias`)
      assert.equal(classifyPreclaimTool(tool), 'unknown', `${tool} remains fail-closed`)
    }
  })

  it('blocks known mutation and unknown/custom tools before claim', () => {
    const tracker = new TrackBeforeMutation()
    for (const tool of ['edit', 'bash', 'delete_file', 'credit', 'nutshell', 'custom_tool']) {
      assert.throws(() => tracker.before(tool, 'session-a'), /blocked until/, tool)
    }
    assert.throws(() => tracker.before('write', undefined), /local mutation/)
    for (const tool of ['read', 'grep', 'devspec_create_action_item', 'devspec_search_index', 'devspec_claim_work_item']) {
      assert.doesNotThrow(() => tracker.before(tool, 'session-a'), tool)
    }
  })
})

describe('strict session-scoped claim attestation', () => {
  it('arms only the session whose exact DevSpec claim returned explicit success', () => {
    const tracker = new TrackBeforeMutation()
    tracker.after('devspec_claim_work_item', 'session-a', { action_item_id: ITEM }, claimed())
    assert.equal(tracker.claimedItemForSession('session-a'), ITEM)
    for (const tool of ['edit', 'bash', 'custom_tool', 'credit']) {
      assert.doesNotThrow(() => tracker.before(tool, 'session-a'), tool)
    }
    assert.throws(() => tracker.before('write', 'session-b'), /blocked until/)
  })

  it('recognizes only bare or explicitly DevSpec-qualified claim names', () => {
    const valid = [
      'claim_work_item',
      'devspec_claim_work_item',
      'devspec.claim_work_item',
      'devspec/claim_work_item',
      'devspec__claim_work_item',
      'mcp__devspec__claim_work_item',
      'mcp.devspec.claim_work_item',
      'mcp/devspec/claim_work_item',
    ]
    for (const tool of valid) {
      const tracker = new TrackBeforeMutation()
      tracker.after(tool, tool, { action_item_id: ITEM }, claimed())
      assert.doesNotThrow(() => tracker.before('write', tool), tool)
    }

    for (const fake of [
      'fake_claim_work_item',
      'notdevspec/claim_work_item',
      'mcp__evil__claim_work_item',
      'claim_work_item_suffix',
      'prefixdevspec_claim_work_item',
    ]) {
      const tracker = new TrackBeforeMutation()
      tracker.after(fake, 'fake', { action_item_id: ITEM }, claimed())
      assert.throws(() => tracker.before('write', 'fake'), undefined, fake)
    }
  })

  it('requires claim_success true, a known claimed status, and matching full UUIDs', () => {
    const invalid = [
      { output: { output: `Claimed ${ITEM} successfully` }, args: { action_item_id: ITEM } },
      { output: { output: '{not-json' }, args: { action_item_id: ITEM } },
      { output: { isError: true, ...claimed() }, args: { action_item_id: ITEM } },
      {
        output: { output: JSON.stringify({ action_item_id: ITEM, action_item: { id: ITEM, status: 'claimed' } }) },
        args: { action_item_id: ITEM },
      },
      {
        output: { output: JSON.stringify({ claim_success: false, action_item_id: ITEM, status: 'claimed' }) },
        args: { action_item_id: ITEM },
      },
      { output: claimed(ITEM, 'mystery'), args: { action_item_id: ITEM } },
      { output: claimed(OTHER_ITEM), args: { action_item_id: ITEM } },
      { output: claimed(ITEM), args: { action_item_id: ITEM.slice(0, 8) } },
      { output: claimed(ITEM.slice(0, 8)), args: { action_item_id: ITEM.slice(0, 8) } },
      {
        output: {
          output: JSON.stringify({
            claim_success: true,
            action_item_id: ITEM,
            action_item: { id: OTHER_ITEM, status: 'claimed' },
          }),
        },
        args: { action_item_id: ITEM },
      },
      {
        output: {
          output: JSON.stringify({
            claim_success: true,
            action_item_id: ITEM,
            status: 'claimed',
            action_item: { id: ITEM, status: 'mystery' },
          }),
        },
        args: { action_item_id: ITEM },
      },
    ]
    for (const { output, args } of invalid) {
      const tracker = new TrackBeforeMutation()
      tracker.after('devspec_claim_work_item', 'session-a', args, output)
      assert.throws(() => tracker.before('edit', 'session-a'), undefined, JSON.stringify(output))
    }
  })

  it('does not arm from create output even when it resembles a successful claim', () => {
    const tracker = new TrackBeforeMutation()
    tracker.after('devspec_create_action_item', 'session-a', { action_item_id: ITEM }, claimed())
    assert.throws(() => tracker.before('edit', 'session-a'))
  })

  it('clears only after successful matching implementation/release/fail results', () => {
    for (const tool of ['record_implementation', 'release_work_item', 'fail_work_item']) {
      const tracker = new TrackBeforeMutation()
      tracker.after('devspec_claim_work_item', 'session-a', { action_item_id: ITEM }, claimed())

      tracker.after(`devspec_${tool}`, 'session-a', { action_item_id: OTHER_ITEM }, succeeded())
      assert.doesNotThrow(() => tracker.before('edit', 'session-a'), `${tool} mismatch`)

      tracker.after(`devspec_${tool}`, 'session-a', { action_item_id: ITEM }, { output: JSON.stringify({ success: false }) })
      assert.doesNotThrow(() => tracker.before('edit', 'session-a'), `${tool} failure`)

      tracker.after(`mcp__devspec__${tool}`, 'session-a', { action_item_id: ITEM }, succeeded())
      assert.throws(() => tracker.before('edit', 'session-a'), undefined, `${tool} success`)
    }
  })

  it('clears one session or all sessions on lifecycle cleanup', () => {
    const tracker = new TrackBeforeMutation()
    tracker.after('devspec_claim_work_item', 'session-a', { action_item_id: ITEM }, claimed())
    tracker.after('devspec_claim_work_item', 'session-b', { action_item_id: OTHER_ITEM }, claimed(OTHER_ITEM))
    tracker.clearSession('session-a')
    assert.throws(() => tracker.before('write', 'session-a'))
    assert.doesNotThrow(() => tracker.before('write', 'session-b'))
    tracker.clearAll()
    assert.throws(() => tracker.before('write', 'session-b'))
  })

  it('a fresh tracker has no persisted attestation', () => {
    const priorProcess = new TrackBeforeMutation()
    priorProcess.after('devspec_claim_work_item', 'session-a', { action_item_id: ITEM }, claimed())
    assert.doesNotThrow(() => priorProcess.before('write', 'session-a'))
    assert.throws(() => new TrackBeforeMutation().before('write', 'session-a'))
  })
})

describe('plugin lifecycle remains independent of remote bonds and egress', () => {
  let tmpHome
  let projectDir
  let restoreHomedir
  let priorHome
  let hooks

  beforeEach(async () => {
    resetBondsForTests()
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-track-home-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-track-proj-'))
    restoreHomedir = mock.method(os, 'homedir', () => tmpHome)
    priorHome = process.env.HOME
    process.env.HOME = tmpHome
    hooks = await DevSpecPlugin({ client: {}, directory: projectDir })
  })

  afterEach(async () => {
    await hooks?.dispose?.()
    restoreHomedir?.mock?.restore?.()
    mock.restoreAll()
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    resetBondsForTests()
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  const before = (tool, sessionID, args = {}) =>
    hooks['tool.execute.before']({ tool, sessionID, callID: 'call-before' }, { args })
  const after = (tool, sessionID, args, output) =>
    hooks['tool.execute.after']({ tool, sessionID, callID: 'call-after', args }, output)

  it('a fresh remote registration and attachment pass the pre-hook without widening shell access', async () => {
    const sessionID = 'fresh-remote-session'
    const connectionID = '22222222-2222-2222-2222-222222222222'
    const devspecSessionID = '33333333-3333-3333-3333-333333333333'
    const registerArgs = { agent_name: 'OpenCode', cwd: projectDir }

    await assert.doesNotReject(() => before('devspec_register_connection', sessionID, registerArgs))
    assert.equal(registerArgs.local_id, bondLocalId(sessionID), 'pre-hook supplies the session bond id')
    await after(
      'devspec_register_connection',
      sessionID,
      registerArgs,
      { content: [{ type: 'text', text: JSON.stringify({ connection_id: connectionID, codename: 'Fresh Otter' }) }] },
    )

    const attachArgs = { connection_id: connectionID, session_id: devspecSessionID.slice(0, 8) }
    await assert.doesNotReject(() => before('devspec_attach_connection', sessionID, attachArgs))
    await after(
      'devspec_attach_connection',
      sessionID,
      attachArgs,
      { content: [{ type: 'text', text: JSON.stringify({ connection_id: connectionID, session_id: devspecSessionID }) }] },
    )

    await assert.doesNotReject(() =>
      before('devspec_get_session_transcript', sessionID, {
        connection_id: connectionID,
        session_id: devspecSessionID,
        since_created_at: '2026-08-18T00:00:00.000Z',
      }),
    )
    assert.deepEqual(runWithBond(sessionID, () => readState()), {
      connectionId: connectionID,
      sessionId: devspecSessionID,
      codename: 'Fresh Otter',
      connectMirrorSuppressed: true,
    })
    await assert.rejects(() => before('bash', sessionID), /local mutation is blocked/)
  })

  it('a remote-control bond does not bypass the gate or alter other guards', async () => {
    rememberOpenCodeBond('bonded', '11111111-1111-1111-1111-111111111111')
    await assert.rejects(() => before('bash', 'bonded'), /local mutation is blocked/)

    const permission = { status: 'ask' }
    await hooks['permission.ask']({ sessionID: 'bonded', type: 'external_directory' }, permission)
    assert.equal(permission.status, 'allow')

    await after('devspec_claim_work_item', 'bonded', { action_item_id: ITEM }, claimed())
    await assert.doesNotReject(() => before('bash', 'bonded'))
    await assert.rejects(
      () => before('devspec_post_session_message', 'bonded', { message: 'answer' }),
      /plugin posts your reply for you/,
    )
  })

  it('session.deleted clears attestation using the SDK properties.info.id shape', async () => {
    await after('devspec_claim_work_item', 'plain', { action_item_id: ITEM }, claimed())
    await assert.doesNotReject(() => before('write', 'plain'))
    await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'plain' } } } })
    await assert.rejects(() => before('write', 'plain'), /blocked until/)
  })

  it('plugin dispose clears all attestations', async () => {
    await after('devspec_claim_work_item', 'plain', { action_item_id: ITEM }, claimed())
    await assert.doesNotReject(() => before('write', 'plain'))
    await hooks.dispose()
    await assert.rejects(() => before('write', 'plain'), /blocked until/)
    hooks = null
  })
})
