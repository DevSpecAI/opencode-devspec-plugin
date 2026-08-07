#!/usr/bin/env node
/**
 * Pump-path short MCP calls must abort when fetch never resolves — otherwise a
 * hung keepalive/heartbeat serializes ahead of poll_connection and the server
 * ends the bond with idle_timeout (item 2c4bd068).
 */
import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { McpTimeoutError, mcpToolsCall } from '../dist/devspec-client.js'
import {
  MCP_SHORT_CALL_TIMEOUT_MS,
  MCP_HEARTBEAT_TIMEOUT_MS,
} from '../dist/remote-control.js'

describe('mcpToolsCall short timeout (pump path)', () => {
  it('exports Claude-aligned short ceilings', () => {
    assert.equal(MCP_SHORT_CALL_TIMEOUT_MS, 10_000)
    assert.equal(MCP_HEARTBEAT_TIMEOUT_MS, 5_000)
  })

  it('rejects with McpTimeoutError when fetch hangs past timeoutMs', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        const fail = () => {
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        }
        if (signal?.aborted) {
          fail()
          return
        }
        signal?.addEventListener('abort', fail, { once: true })
      })
    })
    try {
      const started = Date.now()
      await assert.rejects(
        () =>
          mcpToolsCall({
            mcpUrl: 'https://example.test/mcp',
            token: 't',
            name: 'report_keepalive',
            timeoutMs: 40,
          }),
        (err) => {
          assert.ok(err instanceof McpTimeoutError)
          assert.equal(err.timeoutMs, 40)
          return true
        },
      )
      const elapsed = Date.now() - started
      assert.ok(elapsed < 2_000, `timeout took too long: ${elapsed}ms`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
