#!/usr/bin/env node
/**
 * Single-writer egress (item 4c639620): while a bond is active the plugin owns
 * the answer, so a model call to `post_session_message` is refused before it
 * reaches the server rather than deduplicated after it lands.
 *
 * Prose did not hold. The skill has said "never call this" since 42391f84, and
 * on 2026-08-17 at 16:14:56 the model called it anyway; the mirror then
 * suppressed ITSELF using a remembered content hash (a70cdf78) — two writers
 * racing, with the winner chosen after the fact. Two OpenCode sessions posted
 * contradictory answers under one connection that way.
 *
 * The boundary is answer egress, not the DevSpec MCP server: every other verb
 * stays available, and an unbonded session is left alone entirely because the
 * plugin is not posting for it either.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import { DevSpecPlugin } from '../dist/plugin.js'
import {
  forgetOpenCodeBond,
  rememberOpenCodeBond,
  resetBondsForTests,
} from '../dist/remote-control.js'

const BONDED = 'ses_bonded_chat'
const UNBONDED = 'ses_plain_chat'
const ITEM = 'cdd7a494-ed6a-414b-9f8f-bd0741b9de55'

describe('model-owned post_session_message is refused while bonded (4c639620)', () => {
  let tmpHome
  let projectDir
  let restoreHomedir
  let priorHome
  let hooks

  const claimSession = (sessionID) =>
    hooks['tool.execute.after'](
      {
        tool: 'devspec_claim_work_item',
        sessionID,
        callID: `claim-${sessionID}`,
        args: { action_item_id: ITEM },
      },
      {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              claim_success: true,
              action_item_id: ITEM,
              action_item: { id: ITEM, status: 'claimed' },
            }),
          },
        ],
      },
    )

  beforeEach(async () => {
    resetBondsForTests()
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-writer-home-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-writer-proj-'))
    restoreHomedir = mock.method(os, 'homedir', () => tmpHome)
    priorHome = process.env.HOME
    process.env.HOME = tmpHome
    hooks = await DevSpecPlugin({ client: {}, directory: projectDir })
    rememberOpenCodeBond(BONDED, '8fd18ec0-2a4f-4242-8172-1c76e06a3b8e')
    await claimSession(BONDED)
    await claimSession(UNBONDED)
  })

  afterEach(async () => {
    await hooks?.dispose?.()
    restoreHomedir?.mock?.restore?.()
    mock.restoreAll()
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    forgetOpenCodeBond(BONDED)
    resetBondsForTests()
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  const before = (tool, sessionID, args = {}) =>
    hooks['tool.execute.before']({ tool, sessionID, callID: 'call-1' }, { args })

  it('refuses the call from a bonded session, prefixed or bare', async () => {
    await assert.rejects(
      () => before('devspec_post_session_message', BONDED, { message: 'my answer' }),
      /plugin posts your reply for you/,
      'the refusal must be a real failure, not a log line',
    )
    await assert.rejects(() => before('post_session_message', BONDED, { message: 'x' }))
  })

  it('the error tells the model what to do instead', async () => {
    const err = await before('devspec_post_session_message', BONDED, { message: 'x' }).then(
      () => null,
      (e) => e,
    )
    assert.ok(err, 'must throw')
    assert.match(err.message, /answer normally in the terminal/)
    assert.match(err.message, /verbatim/)
  })

  it('leaves an unbonded session alone — the plugin is not posting for it either', async () => {
    await assert.doesNotReject(() =>
      before('devspec_post_session_message', UNBONDED, { message: 'x' }),
    )
  })

  it('blocks no other DevSpec verb — the egress boundary remains independent', async () => {
    for (const tool of [
      'devspec_report_progress',
      'devspec_create_action_item',
      'devspec_record_memory',
      'devspec_get_action_items',
      'devspec_claim_work_item',
    ]) {
      await assert.doesNotReject(() => before(tool, BONDED, {}), `${tool} must not be blocked`)
    }
  })

  it('still enforces single-writer egress independently of commit provenance', async () => {
    await assert.doesNotReject(() => before('bash', BONDED, { command: 'echo hi' }))
    await assert.doesNotReject(() => before('edit', BONDED, {}))
    await assert.rejects(() => before('devspec_post_session_message', BONDED, { message: 'x' }))
  })

  it('a stale skill cannot produce an alternate answer, whatever it passes', async () => {
    // The failure this closes: a skill that still instructs the model to post.
    // No argument shape gets through, because the refusal is on the verb.
    for (const args of [
      { message: 'done' },
      { message: 'done', connection_id: 'c1' },
      { message: 'done', session_id: 's1', phase: 'answer' },
      {},
    ]) {
      await assert.rejects(() => before('devspec_post_session_message', BONDED, args))
    }
  })
})
