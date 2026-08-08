#!/usr/bin/env node
/**
 * Transient MCP 502 room warnings (item 5c5e86fa).
 * A single Coolify-swap 502 must not post into the room; sustained failures may.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatPollErrorRoomMessage,
  isTransientMcpGatewayError,
  POLL_ERROR_REPORT_AFTER_TRANSIENT,
  shouldReportPollErrorToRoom,
} from '../dist/remote-control.js'

describe('isTransientMcpGatewayError', () => {
  it('matches MCP HTTP 502/503/504 and Bad Gateway', () => {
    assert.equal(isTransientMcpGatewayError(new Error('MCP HTTP 502: Bad Gateway')), true)
    assert.equal(isTransientMcpGatewayError(new Error('MCP HTTP 503: Unavailable')), true)
    assert.equal(isTransientMcpGatewayError(new Error('MCP HTTP 504: Gateway Timeout')), true)
    assert.equal(isTransientMcpGatewayError('upstream Bad Gateway'), true)
  })

  it('does not match auth or other hard failures', () => {
    assert.equal(isTransientMcpGatewayError(new Error('MCP HTTP 401: Unauthorized')), false)
    assert.equal(isTransientMcpGatewayError(new Error('MCP HTTP 500: Internal')), false)
    assert.equal(isTransientMcpGatewayError(new Error('rate limit exceeded')), false)
  })
})

describe('shouldReportPollErrorToRoom', () => {
  const gateway = new Error('MCP HTTP 502: Bad Gateway')

  it('suppresses the first transient gateway blips', () => {
    assert.equal(shouldReportPollErrorToRoom(1, gateway), false)
    assert.equal(shouldReportPollErrorToRoom(2, gateway), false)
  })

  it('reports after POLL_ERROR_REPORT_AFTER_TRANSIENT consecutive gateway failures', () => {
    assert.equal(POLL_ERROR_REPORT_AFTER_TRANSIENT, 3)
    assert.equal(shouldReportPollErrorToRoom(3, gateway), true)
    assert.equal(shouldReportPollErrorToRoom(4, gateway), true)
  })

  it('reports non-transient errors on the first failure', () => {
    assert.equal(shouldReportPollErrorToRoom(1, new Error('MCP HTTP 401: Unauthorized')), true)
  })
})

describe('formatPollErrorRoomMessage', () => {
  it('uses soft redeploy copy for gateway errors', () => {
    const text = formatPollErrorRoomMessage('poll_connection', new Error('MCP HTTP 502: Bad Gateway'))
    assert.match(text, /briefly unreachable/)
    assert.match(text, /redeploy/)
    assert.doesNotMatch(text, /⚠️/)
  })

  it('keeps the warning glyph for hard failures', () => {
    const text = formatPollErrorRoomMessage('poll_connection', new Error('MCP HTTP 401: Unauthorized'))
    assert.match(text, /^⚠️/)
  })
})
