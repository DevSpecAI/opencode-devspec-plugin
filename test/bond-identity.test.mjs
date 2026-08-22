#!/usr/bin/env node
/**
 * The bond is the OpenCode session (item a72a4e22).
 *
 * Live failure this replaces, 2026-08-17: a brand-new OpenCode window running a
 * bare `/devspec.remote` in a folder that had held a connection came back as
 * "Drifting Mongoose", already attached to DevSpec session 8fd18ec0, and posted
 * into it. Two mechanisms produced that, and fixing either alone leaves it:
 *
 *   1. the local state file was keyed on the folder (plus the DevSpec session
 *      once one was known, which a bare connect never has), and
 *   2. `local_id` — the server's own bond key, which bond succession 78a117ab
 *      revives connections by — was a hash of the working directory.
 *
 * So these cases check the key from both ends: what the state file is named,
 * and what identity the server is asked to revive.
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import {
  attachSession,
  bondLocalId,
  ensureConnection,
  isBondedOpenCodeSession,
  listOpenCodeBondSessions,
  readState,
  recordConnectionEventFromTool,
  rememberOpenCodeBond,
  resetBondsForTests,
  runWithBond,
  runWithBondAsync,
  writeState,
} from '../dist/remote-control.js'
import {
  clearConnectionCapability,
  hasConnectionCapability,
} from '../dist/manage-plan-tool.js'

const SESSION_A = 'ses_conversation_a'
const SESSION_B = 'ses_conversation_b'

/** MCP stub that revives by local_id and rotates a hidden capability per register. */
async function startStubMcp() {
  const toolCalls = []
  let minted = 0
  let rotations = 0
  let issueCapabilities = true
  const connections = new Map()
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      let parsed = null
      try {
        parsed = JSON.parse(body)
      } catch {
        /* recorded below */
      }
      const name = parsed?.params?.name ?? '(unparsed)'
      const args = parsed?.params?.arguments ?? {}
      toolCalls.push({ name, arguments: args, capability: req.headers['x-devspec-connection-capability'] ?? null })
      let payload = { ok: true }
      if (name === 'register_connection') {
        let payloadForLocalId = connections.get(args.local_id)
        if (!payloadForLocalId) {
          minted += 1
          payloadForLocalId = { connection_id: `conn-${minted}`, codename: `Codename ${minted}` }
          connections.set(args.local_id, payloadForLocalId)
        }
        rotations += 1
        payload = payloadForLocalId
      } else if (name === 'attach_connection') {
        payload = { session_id: args.session_id }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed?.id ?? 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            ...(issueCapabilities && name === 'register_connection' && args.connection_capability_version === 1
              ? { _meta: { devspec: { connection_capability: { version: 1, value: `dvsc_capability-${rotations}` } } } }
              : {}),
          },
        }),
      )
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${server.address().port}/api/mcp`,
    toolCalls,
    registers: () => toolCalls.filter((c) => c.name === 'register_connection'),
    omitCapabilities: () => { issueCapabilities = false },
    close: () => new Promise((r) => server.close(r)),
  }
}

describe('bond identity is the OpenCode session id (a72a4e22)', () => {
  let tmpHome
  let dirOne
  let dirTwo
  let restoreHomedir
  let priorHome
  let priorToken
  let priorUrl
  let mcp

  beforeEach(async () => {
    resetBondsForTests()
    clearConnectionCapability()
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-bond-home-'))
    dirOne = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-bond-projA-'))
    dirTwo = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-bond-projB-'))
    restoreHomedir = mock.method(os, 'homedir', () => tmpHome)
    priorHome = process.env.HOME
    priorToken = process.env.DEVSPEC_MCP_TOKEN
    priorUrl = process.env.DEVSPEC_MCP_URL
    process.env.HOME = tmpHome
    mcp = await startStubMcp()
    process.env.DEVSPEC_MCP_TOKEN = 'dvs_test_token_not_a_real_credential'
    process.env.DEVSPEC_MCP_URL = mcp.url
  })

  afterEach(async () => {
    await mcp?.close()
    restoreHomedir?.mock?.restore?.()
    mock.restoreAll()
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    if (priorToken === undefined) delete process.env.DEVSPEC_MCP_TOKEN
    else process.env.DEVSPEC_MCP_TOKEN = priorToken
    if (priorUrl === undefined) delete process.env.DEVSPEC_MCP_URL
    else process.env.DEVSPEC_MCP_URL = priorUrl
    resetBondsForTests()
    clearConnectionCapability()
    for (const d of [tmpHome, dirOne, dirTwo]) fs.rmSync(d, { recursive: true, force: true })
  })

  it('the working directory is not part of the key — same session, different cwd, same bond', () => {
    runWithBond(SESSION_A, () => {
      writeState({ connectionId: 'conn-a', sessionId: null, codename: 'Same Bond' })
    })
    // Nothing about `dirOne` / `dirTwo` reaches the state layer any more; the
    // only input is the session id, so a cwd change cannot split or merge bonds.
    const readBack = runWithBond(SESSION_A, () => readState())
    assert.equal(readBack?.connectionId, 'conn-a')
    assert.equal(readBack?.codename, 'Same Bond')
  })

  it('two conversations never see each other, even in one folder', () => {
    runWithBond(SESSION_A, () => {
      writeState({ connectionId: 'conn-a', sessionId: null, codename: 'Agent A' })
    })
    runWithBond(SESSION_B, () => {
      writeState({ connectionId: 'conn-b', sessionId: null, codename: 'Agent B' })
    })
    assert.equal(runWithBond(SESSION_A, () => readState())?.codename, 'Agent A')
    assert.equal(runWithBond(SESSION_B, () => readState())?.codename, 'Agent B')
  })

  it('reading with no bond in scope returns null instead of guessing', () => {
    runWithBond(SESSION_A, () => {
      writeState({ connectionId: 'conn-a', sessionId: null, codename: 'Agent A' })
    })
    assert.equal(readState(), null, 'no bond in scope must never resolve to somebody else’s file')
  })

  it('local_id is derived from the session, stable per session and distinct across sessions', () => {
    assert.equal(bondLocalId(SESSION_A), bondLocalId(SESSION_A), 'stable — reconnect must resume')
    assert.notEqual(bondLocalId(SESSION_A), bondLocalId(SESSION_B), 'distinct — no succession')
  })

  it('a second conversation registers a NEW connection instead of inheriting the first', async () => {
    const first = await ensureConnection(dirOne, SESSION_A)
    assert.equal(first.state?.connectionId, 'conn-1')
    assert.equal(first.state?.codename, 'Codename 1')

    // Same folder, brand-new conversation: this is the exact reported case.
    const second = await ensureConnection(dirOne, SESSION_B)
    assert.equal(second.state?.connectionId, 'conn-2', 'must not be handed conn-1')
    assert.equal(second.state?.codename, 'Codename 2', 'must not inherit the codename')
    assert.equal(second.state?.sessionId, null, 'a bare connect joins no room')

    const registers = mcp.registers()
    assert.equal(registers.length, 2, 'the second conversation must actually register')
    assert.equal(registers[0].arguments.local_id, bondLocalId(SESSION_A))
    assert.equal(registers[1].arguments.local_id, bondLocalId(SESSION_B))
    assert.notEqual(
      registers[0].arguments.local_id,
      registers[1].arguments.local_id,
      'a folder-derived local_id made these identical, and bond succession then revived the same connection',
    )
  })

  it('fails closed when registration omits trusted capability metadata', async () => {
    mcp.omitCapabilities()
    const result = await ensureConnection(dirOne, SESSION_A)
    assert.equal(result.state, null)
    assert.match(result.error, /did not return the negotiated connection capability/)
    assert.equal(mcp.registers()[0].arguments.connection_capability_version, 1)
    assert.equal(hasConnectionCapability(SESSION_A), false)
  })

  it('the same conversation resumes its own connection without re-registering', async () => {
    const first = await ensureConnection(dirOne, SESSION_A)
    const again = await ensureConnection(dirOne, SESSION_A)
    assert.equal(again.state?.connectionId, first.state?.connectionId)
    assert.equal(mcp.registers().length, 1, 'a resume must not mint a second connection')
  })

  it('resume survives a process restart: the durable session id re-finds its own bond', async () => {
    await ensureConnection(dirOne, SESSION_A)
    await ensureConnection(dirOne, SESSION_B)

    // A restart loses process-local bonds AND raw capabilities, but not state.
    resetBondsForTests()
    clearConnectionCapability()
    assert.deepEqual(listOpenCodeBondSessions(), [])

    const resumed = await ensureConnection(dirOne, SESSION_A)
    assert.equal(resumed.state?.connectionId, 'conn-1', 'A must get A back')
    assert.equal(resumed.state?.codename, 'Codename 1')
    assert.equal(mcp.registers().length, 3, 'resume must re-register to rotate its process-local capability')
    assert.equal(mcp.registers()[2].arguments.connection_capability_version, 1)
    assert.equal(hasConnectionCapability(SESSION_A), true)

    const otherStill = runWithBond(SESSION_B, () => readState())
    assert.equal(otherStill?.connectionId, 'conn-2', "and B's bond is untouched by A resuming")
  })

  it('a legacy folder-keyed state file is never read', async () => {
    // Exactly what the old code wrote: sha256 of the resolved project path.
    const legacyKey = crypto
      .createHash('sha256')
      .update(path.resolve(dirOne))
      .digest('base64url')
      .slice(0, 32)
    const stateDir = path.join(tmpHome, '.devspec', 'opencode-remote-control')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(
      path.join(stateDir, `${legacyKey}.json`),
      JSON.stringify({
        connectionId: '7695c4dc-872e-48b2-92ea-6ca86e7c72bd',
        sessionId: '8fd18ec0-2a4f-4242-8172-1c76e06a3b8e',
        codename: 'Drifting Mongoose',
      }),
    )

    const fresh = await ensureConnection(dirOne, SESSION_A)
    assert.notEqual(fresh.state?.connectionId, '7695c4dc-872e-48b2-92ea-6ca86e7c72bd')
    assert.notEqual(fresh.state?.codename, 'Drifting Mongoose')
    assert.equal(fresh.state?.sessionId, null, 'and it must not inherit the old room either')
  })

  it('attach records the room without moving the key, so an awaiting inject survives (d5efd533)', async () => {
    await ensureConnection(dirOne, SESSION_A)
    runWithBond(SESSION_A, () => {
      const s = readState()
      writeState({
        ...s,
        awaitingRemoteReply: true,
        replyAfterOpenCodeMessageId: 'msg_inject_baseline',
        replyBaselineCaptured: true,
      })
    })

    await attachSession(dirOne, SESSION_A, 'f9c54dad-68e0-4ff8-859f-7e3219b9b210')

    const after = runWithBond(SESSION_A, () => readState())
    assert.equal(after?.sessionId, 'f9c54dad-68e0-4ff8-859f-7e3219b9b210', 'room recorded')
    assert.equal(after?.awaitingRemoteReply, true, 'the in-flight inject must survive attach')
    assert.equal(
      after?.replyAfterOpenCodeMessageId,
      'msg_inject_baseline',
      'and keep its baseline — the failure d5efd533 fixed, now impossible rather than migrated',
    )
    assert.equal(isBondedOpenCodeSession(SESSION_A), true)
    const register = mcp.registers()[0]
    const attach = mcp.toolCalls.find((call) => call.name === 'attach_connection')
    assert.equal(register.arguments.connection_capability_version, 1)
    assert.equal(attach.capability, 'dvsc_capability-1', 'attach must use trusted transport identity')
  })

  it('the model-driven handshake persists state for the session that performed it', () => {
    // This is the path production actually uses: the model calls the MCP tools
    // itself and `tool.execute.after` observes the result. It runs OUTSIDE any
    // bond scope, so it has to open one — a version of this that relied on
    // ambient scope wrote nowhere and left connect silently broken while every
    // ensureConnection-based test stayed green.
    recordConnectionEventFromTool(
      'devspec_register_connection',
      { local_id: bondLocalId(SESSION_A) },
      { content: [{ type: 'text', text: JSON.stringify({ connection_id: 'conn-live', codename: 'Live Otter' }) }] },
      SESSION_A,
    )

    const stored = runWithBond(SESSION_A, () => readState())
    assert.equal(stored?.connectionId, 'conn-live')
    assert.equal(stored?.codename, 'Live Otter')
    assert.equal(runWithBond(SESSION_B, () => readState()), null, 'and only for that session')
  })

  it('a handshake with no OpenCode session id is ignored rather than written somewhere', () => {
    recordConnectionEventFromTool(
      'devspec_register_connection',
      {},
      { content: [{ type: 'text', text: JSON.stringify({ connection_id: 'conn-orphan', codename: 'Orphan' }) }] },
      null,
    )
    assert.equal(runWithBond(SESSION_A, () => readState()), null)
    assert.equal(runWithBond(SESSION_B, () => readState()), null)
  })

  it('a second conversation attaching to another room cannot steal the first (be952be5)', async () => {
    await ensureConnection(dirOne, SESSION_A)
    await attachSession(dirOne, SESSION_A, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    await ensureConnection(dirOne, SESSION_B)
    await attachSession(dirOne, SESSION_B, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')

    const a = runWithBond(SESSION_A, () => readState())
    const b = runWithBond(SESSION_B, () => readState())
    assert.equal(a?.sessionId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'A keeps its room')
    assert.equal(b?.sessionId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    assert.notEqual(a?.connectionId, b?.connectionId, 'and they are different connections')
    assert.deepEqual(listOpenCodeBondSessions().sort(), [SESSION_A, SESSION_B].sort())
  })
})
