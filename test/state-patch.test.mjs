#!/usr/bin/env node
/**
 * Regression: poll cursor writes must not roll back concurrent mirror claims
 * (item 67794386 — live double-post of msg_fc80605c in session f3af591e).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, after } from 'node:test'
import { patchState, readState, writeState, recordRemoteControlSkillCommand } from '../dist/remote-control.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-devspec-state-'))
}

/** Minimal connection state shaped like a live remote-control file. */
function baseState(overrides = {}) {
  return {
    connectionId: 'd24c4f1f-72b4-4e1d-bcd0-000b1b32133c',
    sessionId: 'f3af591e-d316-40f6-a2cf-b67dd493cc97',
    codename: 'Velvet Kingfisher',
    lastMirroredMessageId: 'msg_stale_prior',
    lastDeliveredMessageId: null,
    deliveredMessageIds: [],
    mirroredMessageIds: ['msg_stale_prior'],
    recentPostedContentHashes: [],
    busy: false,
    awaitingRemoteReply: true,
    ...overrides,
  }
}

describe('patchState vs stale writeState (mirror claim race)', () => {
  const dirs = []
  after(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })

  it('documents the old bug: full writeState of a stale snapshot wipes mirror claims', () => {
    const dir = tmpDir()
    dirs.push(dir)
    writeState(dir, baseState())

    // Mirror claims the new OpenCode message id + content hash (optimistic claim).
    patchState(dir, {
      lastMirroredMessageId: 'msg_fc80605c10015uNEOeBLOykA5O',
      mirroredMessageIds: ['msg_stale_prior', 'msg_fc80605c10015uNEOeBLOykA5O'],
      recentPostedContentHashes: ['38c381787282b997d9be61de6435f5fe'],
      awaitingRemoteReply: false,
    })

    // Poll held a pre-await in-memory snapshot and used to writeState the whole thing.
    const staleInMemory = baseState({ lastDeliveredMessageId: null })
    writeState(dir, { ...staleInMemory, lastDeliveredMessageId: '44e341ee-3e4a-447d-bf39-2a97d22e91ba' })

    const wiped = readState(dir)
    assert.equal(wiped?.lastMirroredMessageId, 'msg_stale_prior')
    assert.deepEqual(wiped?.recentPostedContentHashes, [])
    assert.equal(wiped?.lastDeliveredMessageId, '44e341ee-3e4a-447d-bf39-2a97d22e91ba')
  })

  it('patchState cursor advance preserves concurrent mirror claims', () => {
    const dir = tmpDir()
    dirs.push(dir)
    writeState(dir, baseState())

    patchState(dir, {
      lastMirroredMessageId: 'msg_fc80605c10015uNEOeBLOykA5O',
      mirroredMessageIds: ['msg_stale_prior', 'msg_fc80605c10015uNEOeBLOykA5O'],
      recentPostedContentHashes: ['38c381787282b997d9be61de6435f5fe'],
      awaitingRemoteReply: false,
    })

    // Fixed poll path: only touch the keys this writer owns.
    const next = patchState(dir, {
      lastDeliveredMessageId: '44e341ee-3e4a-447d-bf39-2a97d22e91ba',
    })

    assert.ok(next)
    assert.equal(next.lastMirroredMessageId, 'msg_fc80605c10015uNEOeBLOykA5O')
    assert.deepEqual(next.recentPostedContentHashes, ['38c381787282b997d9be61de6435f5fe'])
    assert.ok(next.mirroredMessageIds?.includes('msg_fc80605c10015uNEOeBLOykA5O'))
    assert.equal(next.lastDeliveredMessageId, '44e341ee-3e4a-447d-bf39-2a97d22e91ba')

    // A subsequent mirror dedup check would skip via id + hash.
    const fresh = readState(dir)
    assert.equal(fresh?.lastMirroredMessageId, 'msg_fc80605c10015uNEOeBLOykA5O')
    assert.ok(fresh?.recentPostedContentHashes?.includes('38c381787282b997d9be61de6435f5fe'))
  })

  it('patchState delivered-ids / inject-baseline patches preserve mirror fields', () => {
    const dir = tmpDir()
    dirs.push(dir)
    writeState(
      dir,
      baseState({
        lastMirroredMessageId: 'msg_fc80605c10015uNEOeBLOykA5O',
        mirroredMessageIds: ['msg_fc80605c10015uNEOeBLOykA5O'],
        recentPostedContentHashes: ['38c381787282b997d9be61de6435f5fe'],
      }),
    )

    patchState(dir, {
      deliveredMessageIds: ['055522d7-2fe2-4c35-8dcd-f000b55dbf2f'],
    })
    patchState(dir, {
      replyAfterOpenCodeMessageId: 'msg_baseline',
      replyBaselineCaptured: true,
      awaitingRemoteReply: true,
    })

    const fresh = readState(dir)
    assert.equal(fresh?.lastMirroredMessageId, 'msg_fc80605c10015uNEOeBLOykA5O')
    assert.deepEqual(fresh?.recentPostedContentHashes, ['38c381787282b997d9be61de6435f5fe'])
    assert.deepEqual(fresh?.deliveredMessageIds, ['055522d7-2fe2-4c35-8dcd-f000b55dbf2f'])
    assert.equal(fresh?.replyAfterOpenCodeMessageId, 'msg_baseline')
    assert.equal(fresh?.awaitingRemoteReply, true)
  })
})

describe('recordRemoteControlSkillCommand — late connect tag (8a97effc)', () => {
  const dirs = []
  after(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  })

  it('records the connect message id when not awaiting an inject reply', () => {
    const dir = tmpDir()
    dirs.push(dir)
    writeState(dir, baseState({ awaitingRemoteReply: false, nonMirrorMessageIds: [] }))

    recordRemoteControlSkillCommand(dir, {
      name: 'devspec.remote',
      messageID: 'msg_connect_turn',
    })

    const fresh = readState(dir)
    assert.deepEqual(fresh?.nonMirrorMessageIds, ['msg_connect_turn'])
  })

  it('ignores command.executed while awaitingRemoteReply so the answer id is not poisoned', () => {
    const dir = tmpDir()
    dirs.push(dir)
    writeState(
      dir,
      baseState({
        awaitingRemoteReply: true,
        nonMirrorMessageIds: ['msg_prior_connect'],
      }),
    )

    recordRemoteControlSkillCommand(dir, {
      name: 'devspec.remote',
      messageID: 'msg_fd7a125e2001jMlrosBkXrxYbv',
    })

    const fresh = readState(dir)
    assert.deepEqual(fresh?.nonMirrorMessageIds, ['msg_prior_connect'])
  })
})
