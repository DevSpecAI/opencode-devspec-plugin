#!/usr/bin/env node
/**
 * Unit tests for OpenCode mirror ↔ manual post_session_message dedup (a70cdf78).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  hashPostedContent,
  messageHasPostSessionMessageTool,
  normalizePostedContent,
} from '../dist/remote-control.js'

describe('normalizePostedContent / hashPostedContent', () => {
  it('trims and normalizes CRLF so whitespace-only drift shares a hash', () => {
    const a = hashPostedContent('Hello\r\nworld\n')
    const b = hashPostedContent('Hello\nworld')
    assert.equal(a, b)
    assert.equal(normalizePostedContent('  x  '), 'x')
  })

  it('distinguishes different bodies', () => {
    assert.notEqual(hashPostedContent('one'), hashPostedContent('two'))
  })
})

describe('messageHasPostSessionMessageTool', () => {
  it('detects common OpenCode / MCP tool name shapes', () => {
    assert.equal(
      messageHasPostSessionMessageTool({
        parts: [{ type: 'tool', tool: 'post_session_message' }],
      }),
      true,
    )
    assert.equal(
      messageHasPostSessionMessageTool({
        parts: [{ type: 'tool', name: 'devspec_post_session_message' }],
      }),
      true,
    )
    assert.equal(
      messageHasPostSessionMessageTool({
        parts: [{ type: 'tool', tool: { name: 'mcp_devspec_post_session_message' } }],
      }),
      true,
    )
  })

  it('is false for text-only or unrelated tools', () => {
    assert.equal(
      messageHasPostSessionMessageTool({
        parts: [{ type: 'text', text: 'hi' }],
      }),
      false,
    )
    assert.equal(
      messageHasPostSessionMessageTool({
        parts: [{ type: 'tool', tool: 'bash' }],
      }),
      false,
    )
    assert.equal(messageHasPostSessionMessageTool(null), false)
  })
})
