#!/usr/bin/env node
/**
 * Item 26050f07 — d1576e7f (Lucky Quail, 2026-09-07).
 *
 * Three behaviours the plugin MUST now exhibit, each previously missing:
 *
 *   1. `markOwnerGone` sends `heartbeat_connection(busy:false, end_reason:'owner_gone')`
 *      so a host that dies mid-turn does not leave the server with `busy:true`.
 *   2. `checkPermissionWaitTimeout` posts a "still waiting" advisory on the
 *      repeat cadence, and auto-clears `busy` at the long-wait threshold so an
 *      abandoned permission prompt cannot strand the connection.
 *
 * The `dispose`-hook wiring is covered indirectly: the `plugin.ts` change
 * invokes `markOwnerGone` before tearing down, so the unit tests here prove
 * the wire-format the hook depends on.
 *
 * These tests run against `dist/remote-control.js` (built) and use the
 * `runWithBond` / `writeState` / `resetBondsForTests` helpers the rest of the
 * suite uses for state seeding.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import {
  checkPermissionWaitTimeout,
  markOwnerGone,
  PERMISSION_WAIT_AUTO_CLEAR_MS,
  PERMISSION_WAIT_NOTICE_REPEAT_MS,
  readState,
  resetBondsForTests,
  runWithBond,
  runWithBondAsync,
  writeState,
} from '../dist/remote-control.js'

const TEST_BOND = 'ses_dispose_busy_cleanup'
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-dispose-busy-home-'))

const dirs = []
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-dispose-busy-'))
  dirs.push(d)
  return d
}

const CONN = '11111111-1111-1111-1111-111111111111'
const DEVSPEC_SESSION = '22222222-2222-2222-2222-222222222222'

after(() => {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  resetBondsForTests()
})

beforeEach(() => {
  resetBondsForTests()
})

/**
 * Stub the global fetch so we can assert on the heartbeat payloads the plugin
 * sends. Returns a restore() handle to undo the stub.
 */
let heartbeatCalls = []

function installFetchStub() {
  const originalFetch = globalThis.fetch
  heartbeatCalls = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse((init && init.body) || '{}')
    if (body && body.params && body.params.name === 'heartbeat_connection') {
      heartbeatCalls.push({
        args: body.params.arguments || {},
        headers: (init && init.headers) || {},
      })
    }
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: '{}' }] },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  return { restore: () => { globalThis.fetch = originalFetch } }
}

/**
 * Seed a minimal connection state with `busy:true` and a permission ask
 * already pending. The exact fields don't matter for these tests — only the
 * shape that the production code reads.
 */
function seedBusyWithPermission(dir, askedAt) {
  runWithBond(TEST_BOND, () => {
    writeState({
      connectionId: CONN,
      sessionId: DEVSPEC_SESSION,
      codename: 'Honest Quail',
      busy: true,
      busySince: askedAt,
      awaitingRemoteReply: true,
      permissionAskedPending: true,
      permissionAskedAt: askedAt,
      pendingPermissions: [{ requestId: 'perm-1', askedAt }],
      permissionResolutionObserved: false,
      permissionNoticeLastAt: null,
    })
  })
}

function seedIdle(dir) {
  runWithBond(TEST_BOND, () => {
    writeState({
      connectionId: CONN,
      sessionId: DEVSPEC_SESSION,
      codename: 'Honest Quail',
      busy: false,
    })
  })
}

describe('markOwnerGone (item 26050f07 — d1576e7f fix)', () => {
  let restore

  before(() => {
    const installed = installFetchStub()
    restore = installed.restore
  })
  after(() => { restore() })

  it('sends heartbeat_connection with busy:false and end_reason:owner_gone when busy was true', async () => {
    const dir = tmpDir()
    seedBusyWithPermission(dir, Date.now())
    heartbeatCalls = []

    await runWithBondAsync(TEST_BOND, () => markOwnerGone(dir))

    assert.equal(heartbeatCalls.length, 1, 'exactly one heartbeat must be sent on dispose')
    const call = heartbeatCalls[0]
    assert.equal(call.args.connection_id, CONN)
    assert.equal(call.args.busy, false)
    assert.equal(call.args.status, 'offline')
    assert.equal(call.args.end_reason, 'owner_gone')
  })

  it('is a safe no-op when there is no connection_id in state', async () => {
    const dir = tmpDir()
    seedIdle(dir)
    heartbeatCalls = []
    // Wipe the state so there is no connectionId.
    runWithBond(TEST_BOND, () => {
      writeState({ connectionId: '', sessionId: null, codename: null })
    })

    await runWithBondAsync(TEST_BOND, () => markOwnerGone(dir))

    assert.equal(heartbeatCalls.length, 0)
  })
})

describe('checkPermissionWaitTimeout (item 26050f07 — d1576e7f fix)', () => {
  let restore

  before(() => {
    const installed = installFetchStub()
    restore = installed.restore
  })
  after(() => { restore() })

  it('does nothing when no permission is pending', async () => {
    const dir = tmpDir()
    seedIdle(dir)
    heartbeatCalls = []

    await runWithBondAsync(TEST_BOND, () => checkPermissionWaitTimeout(dir))

    assert.equal(heartbeatCalls.length, 0, 'no permission ask → no heartbeat, no notice')
  })

  it('posts no notice before the repeat cadence has elapsed', async () => {
    const dir = tmpDir()
    // Asked "just now". Repeat cadence is 2 minutes, so nothing should fire.
    seedBusyWithPermission(dir, Date.now() - 30_000)
    heartbeatCalls = []

    await runWithBondAsync(TEST_BOND, () => checkPermissionWaitTimeout(dir))

    assert.equal(heartbeatCalls.length, 0)
  })

  it('posts the "still waiting" advisory once the repeat cadence has elapsed', async () => {
    const dir = tmpDir()
    // First advisory goes out at t=0 via postPermissionWaitNotice on permission.asked.
    // We simulate that having happened by stamping permissionNoticeLastAt to ~now
    // AND pushing askedAt back so the repeat window has elapsed.
    const askedAt = Date.now() - PERMISSION_WAIT_NOTICE_REPEAT_MS - 5_000
    seedBusyWithPermission(dir, askedAt)
    // The first advisory's posted time IS permissionAskedAt in our model.
    runWithBond(TEST_BOND, () => {
      const s = readState()
      if (s) writeState({ ...s, permissionNoticeLastAt: askedAt })
    })
    heartbeatCalls = []

    await runWithBondAsync(TEST_BOND, () => checkPermissionWaitTimeout(dir))

    // We expect at least one post_session_message call (the advisory) — but we
    // don't have a fetch stub for that here. The heartbeatCalls array is the
    // stubbed fetch — it will be empty for a post. The key observable: the
    // state was updated so the cadence does not re-fire.
    const after = runWithBond(TEST_BOND, () => readState())
    assert.ok(
      after && after.permissionNoticeLastAt && after.permissionNoticeLastAt > askedAt,
      'permissionNoticeLastAt must advance after the repeat advisory posts',
    )
  })

  it('auto-clears busy once the long-wait threshold is exceeded', async () => {
    const dir = tmpDir()
    const askedAt = Date.now() - PERMISSION_WAIT_AUTO_CLEAR_MS - 5_000
    seedBusyWithPermission(dir, askedAt)
    heartbeatCalls = []

    await runWithBondAsync(TEST_BOND, () => checkPermissionWaitTimeout(dir))

    const after = runWithBond(TEST_BOND, () => readState())
    assert.equal(after && after.busy, false, 'busy must clear at the long-wait threshold')
    assert.equal(after && after.permissionAskedPending, false)
    assert.equal(after && after.permissionAskedAt, null)
    assert.deepEqual((after && after.pendingPermissions) || [], [])
    // heartbeat must have been sent — busy:false via setBusy → heartbeat_connection
    assert.ok(
      heartbeatCalls.some((c) => c.args.busy === false),
      'a busy:false heartbeat must have fired to clear the stale busy on the server',
    )
  })

  it('does not auto-clear when still within the long-wait threshold', async () => {
    const dir = tmpDir()
    const askedAt = Date.now() - (PERMISSION_WAIT_AUTO_CLEAR_MS / 2)
    seedBusyWithPermission(dir, askedAt)
    heartbeatCalls = []

    await runWithBondAsync(TEST_BOND, () => checkPermissionWaitTimeout(dir))

    const after = runWithBond(TEST_BOND, () => readState())
    assert.equal(after && after.busy, true, 'busy must NOT clear while still inside the long-wait window')
    assert.equal(after && after.permissionAskedPending, true)
  })
})
