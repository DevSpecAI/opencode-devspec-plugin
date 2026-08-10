#!/usr/bin/env node
/**
 * Remote-control permission.ask auto-allow (item 1514baa3).
 * promptAsync turns never inherit cold-launch `opencode run --auto`.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  forgetOpenCodeBond,
  listOpenCodeBondSessions,
  rememberOpenCodeBond,
  shouldAutoAllowRemoteControlPermission,
} from '../dist/remote-control.js'

afterEach(() => {
  for (const id of listOpenCodeBondSessions()) forgetOpenCodeBond(id)
})

describe('shouldAutoAllowRemoteControlPermission', () => {
  it('is false with no remote-control bond (interactive TUI still prompts)', () => {
    assert.equal(shouldAutoAllowRemoteControlPermission(), false)
  })

  it('is true while any DevSpec remote-control bond is active', () => {
    rememberOpenCodeBond('ses_remote', '11111111-1111-1111-1111-111111111111')
    assert.equal(shouldAutoAllowRemoteControlPermission(), true)
  })

  it('returns to false after the last bond is forgotten', () => {
    rememberOpenCodeBond('ses_a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    rememberOpenCodeBond('ses_b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    forgetOpenCodeBond('ses_a')
    assert.equal(shouldAutoAllowRemoteControlPermission(), true)
    forgetOpenCodeBond('ses_b')
    assert.equal(shouldAutoAllowRemoteControlPermission(), false)
  })
})
