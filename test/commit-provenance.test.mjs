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
  CommitProvenance,
  CONTRACT_URI,
  decideCommit,
  isBashTool,
  isKnownEditTool,
  isSimpleGitPush,
  localReferenceOutcome,
  readProjectPin,
  referencesIn,
  simpleGitCommit,
  stampCommand,
} from '../dist/commit-provenance.js'

const ITEM = 'f240d17f-8b9a-401d-bc73-d848db8b8fe5'
const OTHER = '11111111-2222-3333-4444-555555555555'
const PIN_ID = '24c4abaa-2cb9-496a-8492-cf1f1aa1090b'

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

function pinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-pin-'))
  fs.mkdirSync(path.join(dir, '.devspec'))
  fs.writeFileSync(path.join(dir, '.devspec', 'project.json'), JSON.stringify({ project_id: PIN_ID }))
  return dir
}

describe('capability-honest surfaces', () => {
  it('treats only OpenCode edit/write as known edits and only bash as a commit surface', () => {
    assert.equal(isKnownEditTool('edit'), true)
    assert.equal(isKnownEditTool('write'), true)
    assert.equal(isKnownEditTool('bash'), false)
    assert.equal(isKnownEditTool('custom_tool'), false)
    assert.equal(isKnownEditTool('credit'), false)
    assert.equal(isBashTool('bash'), true)
    assert.equal(isBashTool('shell'), false)
    assert.equal(isBashTool('edit'), false)
  })
})

describe('readable commit shapes include isolated-worktree forms', () => {
  it('reads a bare quoted git commit -m', () => {
    const parsed = simpleGitCommit("git commit -m 'fix it'")
    assert.deepEqual(parsed, { message: 'fix it', appendable: true, insertOffset: 21 })
  })

  it('reads cd <single-path> && git commit -m', () => {
    const parsed = simpleGitCommit("cd /tmp/work && git commit -m 'from worktree'")
    assert.ok(parsed)
    assert.equal(parsed.message, 'from worktree')
    assert.equal(parsed.appendable, true)
  })

  it('reads git -C <path> commit -m', () => {
    const parsed = simpleGitCommit("git -C /tmp/work commit -m 'via -C'")
    assert.ok(parsed)
    assert.equal(parsed.message, 'via -C')
    assert.equal(parsed.appendable, true)
  })

  it('reads cd prefix combined with -C', () => {
    const parsed = simpleGitCommit("cd /tmp/other && git -C /tmp/work commit -m 'both'")
    assert.ok(parsed)
    assert.equal(parsed.message, 'both')
  })

  it('fails open on every shape it cannot read honestly', () => {
    for (const command of [
      'git commit -F msg.txt',
      'git commit --amend -m "x"',
      'alias g=git; g commit -m "x"',
      'git status && git commit -m "x"',
      'cd /tmp && cd /tmp && git commit -m "x"',
      'cd -- /tmp && git commit -m "x"',
      'git -c alias.commit=status commit -m "x"',
      'git commit -m "one" -m "two"',
      'printf x | git commit -F -',
      'git commit',
      '',
    ]) {
      assert.equal(simpleGitCommit(command), null, command)
    }
  })

  it('sees an unquoted -m value but will not stamp it', () => {
    const parsed = simpleGitCommit('git commit -m unquoted')
    assert.ok(parsed)
    assert.equal(parsed.message, 'unquoted')
    assert.equal(parsed.appendable, false)
    assert.equal(
      decideCommit({ command: 'git commit -m unquoted', claims: [ITEM], hasJurisdiction: true }).action,
      'deny',
    )
  })
})

describe('reference outcomes are local shape only', () => {
  it('accepts a full uuid or an eight-character short code', () => {
    assert.equal(localReferenceOutcome(`ok [devspec:${ITEM}]`), 'well_formed')
    assert.equal(localReferenceOutcome('ok [devspec:f240d17f]'), 'well_formed')
    assert.equal(localReferenceOutcome('plain message'), 'absent')
    assert.equal(localReferenceOutcome('bad [devspec:not-an-id]'), 'malformed')
    assert.equal(
      localReferenceOutcome(`[devspec:${ITEM}] and [devspec:${OTHER}]`),
      'ambiguous',
    )
  })

  it('does not treat a short code as a second reference when it is the prefix of the full uuid', () => {
    assert.deepEqual(referencesIn(`done [devspec:${ITEM}]`), [ITEM])
  })
})

describe('decideCommit never guesses and never requires a live claim for a valid tag', () => {
  it('allows a well-formed reference with no claim and no pin', () => {
    assert.deepEqual(
      decideCommit({
        command: `git commit -m 'done [devspec:${ITEM}]'`,
        claims: [],
        hasJurisdiction: true,
      }),
      { action: 'allow' },
    )
  })

  it('stamps exactly one claim into a quoted message', () => {
    const decision = decideCommit({
      command: "git commit -m 'done'",
      claims: [ITEM],
      hasJurisdiction: true,
    })
    assert.equal(decision.action, 'stamp')
    assert.equal(decision.itemId, ITEM)
    assert.match(decision.command, /\[devspec:f240d17f-8b9a-401d-bc73-d848db8b8fe5\]/)
    assert.equal(stampCommand("git commit -m 'done'", simpleGitCommit("git commit -m 'done'"), ITEM), decision.command)
  })

  it('does not stamp when several claims are active', () => {
    const decision = decideCommit({
      command: "git commit -m 'done'",
      claims: [ITEM, OTHER],
      hasJurisdiction: true,
    })
    assert.equal(decision.action, 'deny')
    assert.match(decision.reason, /2 claims are active/)
    assert.match(decision.reason, /Nothing else is blocked/)
  })

  it('does not replace an existing different reference', () => {
    const decision = decideCommit({
      command: `git commit -m 'done [devspec:${OTHER}]'`,
      claims: [ITEM],
      hasJurisdiction: true,
    })
    assert.equal(decision.action, 'allow')
  })

  it('fails open without local jurisdiction', () => {
    assert.deepEqual(
      decideCommit({
        command: "git commit -m 'untagged'",
        claims: [],
        hasJurisdiction: false,
      }),
      { action: 'allow' },
    )
  })

  it('fails open on opaque shell instead of parsing it', () => {
    assert.deepEqual(
      decideCommit({
        command: 'eval git commit -m untagged',
        claims: [],
        hasJurisdiction: true,
      }),
      { action: 'allow' },
    )
  })

  it('denies a readable untagged commit with recovery that does not terminate', () => {
    const decision = decideCommit({
      command: "cd /tmp/work && git commit -m 'untagged'",
      claims: [],
      hasJurisdiction: true,
    })
    assert.equal(decision.action, 'deny')
    assert.match(decision.reason, /retry/)
    assert.ok(decision.reason.includes(CONTRACT_URI))
    assert.doesNotMatch(decision.reason, /terminat|stopReason|abort the session/i)
  })
})

describe('push is recognised and never blocked', () => {
  it('recognises the same worktree forms it can read for commit', () => {
    assert.equal(isSimpleGitPush('git push'), true)
    assert.equal(isSimpleGitPush('git -C /tmp/work push origin HEAD'), true)
    assert.equal(isSimpleGitPush('cd /tmp/work && git push'), true)
    assert.equal(isSimpleGitPush('git status && git push'), false)
    assert.equal(isSimpleGitPush('git commit -m "x"'), false)
  })
})

describe('project pin is positive local jurisdiction only', () => {
  it('reads a well-formed pin and ignores a broken one', () => {
    const dir = pinDir()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-home-'))
    try {
      const pin = readProjectPin(dir, home)
      assert.equal(pin?.projectId, PIN_ID)
      fs.writeFileSync(path.join(dir, '.devspec', 'project.json'), '{')
      assert.equal(readProjectPin(dir, home), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('never treats the home directory itself as a project pin', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-home-'))
    fs.mkdirSync(path.join(home, '.devspec'))
    fs.writeFileSync(path.join(home, '.devspec', 'project.json'), JSON.stringify({ project_id: PIN_ID }))
    try {
      assert.equal(readProjectPin(home, home), null)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('CommitProvenance does not claim-gate work', () => {
  let dir
  let home
  let tracker

  beforeEach(() => {
    dir = pinDir()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-home-'))
    tracker = new CommitProvenance({ directory: dir, homeDir: home })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('allows edits, unknown tools, shell, and post-record follow-through without a claim', () => {
    for (const tool of ['edit', 'write', 'bash', 'custom_tool', 'credit', 'nutshell', 'read', 'grep']) {
      assert.doesNotThrow(() => tracker.before(tool, 'session-a', { command: 'touch changed' }), tool)
    }
    const afterOutput = { output: 'wrote file' }
    tracker.after('edit', 'session-a', { filePath: 'a.ts' }, afterOutput, 'n1')
    assert.match(afterOutput.output, /no active claim/)
    tracker.after('edit', 'session-a', { filePath: 'b.ts' }, afterOutput, 'n2')
    assert.equal(afterOutput.output.match(/no active claim/g)?.length, 1)
    tracker.after('devspec_claim_work_item', 'session-a', { action_item_id: ITEM }, claimed())
    tracker.after('devspec_record_implementation', 'session-a', { action_item_id: ITEM }, succeeded())
    assert.deepEqual(tracker.claimsForSession('session-a'), [])
    assert.doesNotThrow(() => tracker.before('write', 'session-a'))
    assert.doesNotThrow(() => tracker.before('bash', 'session-a', { command: 'npm test' }))
  })

  it('emits at most one nudge per session and project', () => {
    const first = { output: 'ok' }
    const second = { output: 'ok' }
    tracker.after('write', 's1', {}, first, 'a')
    tracker.after('edit', 's1', {}, second, 'b')
    assert.match(first.output, /claim_work_item/)
    assert.equal(second.output, 'ok')
    assert.equal(tracker.didNudge('s1'), true)
    const other = { output: 'ok' }
    tracker.after('edit', 's2', {}, other, 'c')
    assert.match(other.output, /claim_work_item/)
  })

  it('does not nudge when a claim is already held', () => {
    tracker.after('devspec_claim_work_item', 's1', { action_item_id: ITEM }, claimed())
    const output = { output: 'ok' }
    tracker.after('edit', 's1', {}, output, 'a')
    assert.equal(output.output, 'ok')
  })

  it('stamps a quoted worktree commit and reports it', () => {
    tracker.after('claim_work_item', 's1', { action_item_id: ITEM }, claimed())
    const args = { command: "cd /tmp/work && git commit -m 'ship it'" }
    tracker.before('bash', 's1', args, 'c1')
    assert.match(args.command, /\[devspec:f240d17f-8b9a-401d-bc73-d848db8b8fe5\]/)
    const output = { output: 'committed' }
    tracker.after('bash', 's1', args, output, 'c1')
    assert.match(output.output, /stamped \[devspec:f240d17f-8b9a-401d-bc73-d848db8b8fe5\]/)
  })

  it('leaves an existing reference untouched even after record_implementation', () => {
    tracker.after('devspec_claim_work_item', 's1', { action_item_id: ITEM }, claimed())
    tracker.after('devspec_record_implementation', 's1', { action_item_id: ITEM }, succeeded())
    const args = { command: `git -C /tmp/work commit -m 'follow [devspec:${ITEM}]'` }
    assert.doesNotThrow(() => tracker.before('bash', 's1', args, 'c1'))
    assert.equal(args.command, `git -C /tmp/work commit -m 'follow [devspec:${ITEM}]'`)
  })

  it('denies only a readable untagged commit and keeps the session usable', () => {
    assert.throws(
      () => tracker.before('bash', 's1', { command: "git commit -m 'untagged'" }),
      /Nothing else is blocked/,
    )
    assert.doesNotThrow(() => tracker.before('edit', 's1'))
    assert.doesNotThrow(() => tracker.before('bash', 's1', { command: 'npm test' }))
    assert.doesNotThrow(() => tracker.before('mystery_extension', 's1', { command: 'rm -rf /' }))
  })

  it('allows push even when outgoing history would be unlinked', () => {
    assert.doesNotThrow(() => tracker.before('bash', 's1', { command: 'git push' }))
    assert.doesNotThrow(() => tracker.before('bash', 's1', { command: 'cd /tmp/work && git push origin HEAD' }))
  })

  it('observes only exact DevSpec claim names', () => {
    tracker.after('fake_claim_work_item', 's1', { action_item_id: ITEM }, claimed())
    assert.deepEqual(tracker.claimsForSession('s1'), [])
    tracker.after('mcp__devspec__claim_work_item', 's1', { action_item_id: ITEM }, claimed())
    assert.deepEqual(tracker.claimsForSession('s1'), [ITEM])
  })
})

describe('plugin hooks remain independent of remote bonds and egress', () => {
  let tmpHome
  let projectDir
  let restoreHomedir
  let priorHome
  let hooks

  beforeEach(async () => {
    resetBondsForTests()
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-prov-home-'))
    projectDir = pinDir()
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

  const before = (tool, sessionID, args = {}, callID = 'call-before') =>
    hooks['tool.execute.before']({ tool, sessionID, callID }, { args })
  const after = (tool, sessionID, args, output, callID = 'call-after') =>
    hooks['tool.execute.after']({ tool, sessionID, callID, args }, output)

  it('a fresh remote registration still works and does not widen or block shell', async () => {
    const sessionID = 'fresh-remote-session'
    const connectionID = '22222222-2222-2222-2222-222222222222'
    const devspecSessionID = '33333333-3333-3333-3333-333333333333'
    const registerArgs = { agent_name: 'OpenCode', cwd: projectDir }

    await assert.doesNotReject(() => before('devspec_register_connection', sessionID, registerArgs))
    assert.equal(registerArgs.local_id, bondLocalId(sessionID))
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
      }),
    )
    assert.deepEqual(runWithBond(sessionID, () => readState()), {
      connectionId: connectionID,
      sessionId: devspecSessionID,
      codename: 'Fresh Otter',
      connectMirrorSuppressed: true,
    })
    await assert.doesNotReject(() => before('bash', sessionID, { command: 'git status' }))
    await assert.doesNotReject(() => before('edit', sessionID, { filePath: 'a.ts' }))
  })

  it('a remote-control bond does not change provenance or egress', async () => {
    rememberOpenCodeBond('bonded', '11111111-1111-1111-1111-111111111111')
    await assert.doesNotReject(() => before('bash', 'bonded', { command: 'npm test' }))

    const permission = { status: 'ask' }
    await hooks['permission.ask']({ sessionID: 'bonded', type: 'external_directory' }, permission)
    assert.equal(permission.status, 'allow')

    await after('devspec_claim_work_item', 'bonded', { action_item_id: ITEM }, claimed())
    const args = { command: "git commit -m 'ship'" }
    await before('bash', 'bonded', args, 'stamp-1')
    assert.match(args.command, /\[devspec:f240d17f-8b9a-401d-bc73-d848db8b8fe5\]/)
    await assert.rejects(
      () => before('devspec_post_session_message', 'bonded', { message: 'answer' }),
      /plugin posts your reply for you/,
    )
  })

  it('unknown tools and opaque shell fail open; readable untagged commits do not terminate the session', async () => {
    await assert.doesNotReject(() => before('custom_tool', 'plain', { command: 'rm -rf /' }))
    await assert.doesNotReject(() => before('bash', 'plain', { command: 'eval git commit -m x' }))
    await assert.rejects(() => before('bash', 'plain', { command: "git commit -m 'x'" }), /Nothing else is blocked/)
    await assert.doesNotReject(() => before('write', 'plain', { filePath: 'still-open.ts' }))
  })

  it('session.deleted and dispose clear claim state used only for stamping', async () => {
    await after('devspec_claim_work_item', 'plain', { action_item_id: ITEM }, claimed())
    const first = { command: "git commit -m 'one'" }
    await before('bash', 'plain', first, 'c1')
    assert.match(first.command, /\[devspec:/)
    await hooks.event({ event: { type: 'session.deleted', properties: { info: { id: 'plain' } } } })
    const second = { command: "git commit -m 'two'" }
    await assert.rejects(() => before('bash', 'plain', second, 'c2'), /would land unlinked/)
    await hooks.dispose()
    hooks = null
  })
})
