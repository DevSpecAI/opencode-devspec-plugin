import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mcpToolsCall } from '../dist/devspec-client.js'
import {
  captureConnectionCapability,
  clearConnectionCapability,
  createManagePlanTool,
  hasConnectionCapability,
  negotiateConnectionCapability,
} from '../dist/manage-plan-tool.js'

const sessionID = 'manage-plan-session'
const capability = 'dvsc_hidden-capability-value'
let originalFetch
let originalToken
let originalUrl
let calls
let asks
let responseMeta

function context() {
  return {
    sessionID,
    messageID: 'message',
    agent: 'build',
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata() {},
    ask: async (input) => { asks.push(input) },
  }
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  originalToken = process.env.DEVSPEC_MCP_TOKEN
  originalUrl = process.env.DEVSPEC_MCP_URL
  process.env.DEVSPEC_MCP_TOKEN = 'test-token'
  process.env.DEVSPEC_MCP_URL = 'https://example.test/mcp'
  calls = []
  asks = []
  responseMeta = undefined
  clearConnectionCapability()
  globalThis.fetch = async (_url, init) => {
    calls.push({ headers: new Headers(init.headers), body: JSON.parse(init.body) })
    return new Response(JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ plan: { id: 'plan', revision: 2 } }) }],
        ...(responseMeta === undefined ? {} : { _meta: responseMeta }),
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalToken === undefined) delete process.env.DEVSPEC_MCP_TOKEN
  else process.env.DEVSPEC_MCP_TOKEN = originalToken
  if (originalUrl === undefined) delete process.env.DEVSPEC_MCP_URL
  else process.env.DEVSPEC_MCP_URL = originalUrl
  clearConnectionCapability()
})

describe('capability-backed manage_plan host tool', () => {
  it('negotiates registration mechanically and captures only hidden MCP metadata', () => {
    const args = { agent_name: 'OpenCode' }
    negotiateConnectionCapability(args)
    assert.equal(args.connection_capability_version, 1)

    assert.equal(captureConnectionCapability(sessionID, {
      content: [{ type: 'text', text: JSON.stringify({ connection_capability: capability }) }],
    }), false, 'model-visible content must not be scanned for identity')
    assert.equal(hasConnectionCapability(sessionID), false)

    assert.equal(captureConnectionCapability(sessionID, {
      _meta: { devspec: { connection_capability: { version: 1, value: capability } } },
    }), true)
    assert.equal(hasConnectionCapability(sessionID), true)
  })

  it('observes trusted raw result metadata without returning it to the model path', async () => {
    responseMeta = { devspec: { connection_capability: { version: 1, value: capability } } }
    let observed = null
    const result = await mcpToolsCall({
      mcpUrl: process.env.DEVSPEC_MCP_URL,
      token: process.env.DEVSPEC_MCP_TOKEN,
      name: 'register_connection',
      onResultMeta: (meta) => { observed = meta },
    })
    assert.deepEqual(observed, responseMeta)
    assert.doesNotMatch(JSON.stringify(result), /dvsc_hidden-capability-value/)
  })

  it('exposes the complete action/argument schema and requires a capability', async () => {
    const definition = createManagePlanTool(process.cwd())
    const parsed = definition.args.action.safeParse('adopt')
    assert.equal(parsed.success, true)
    for (const field of [
      'plan_id', 'expected_revision', 'title', 'steps', 'step_id',
      'current_step_id', 'next_step_id', 'reason', 'retryable',
    ]) assert.ok(definition.args[field], `missing ${field}`)

    await assert.rejects(
      definition.execute({ action: 'list' }, context()),
      /registers its connection capability/,
    )
    assert.equal(calls.length, 0)
  })

  it('sends identity only in the capability header and asks permission only for mutations', async () => {
    captureConnectionCapability(sessionID, {
      metadata: { devspec: { connection_capability: { version: 1, value: capability } } },
    })
    const definition = createManagePlanTool(process.cwd())

    const readOutput = await definition.execute({ action: 'list' }, context())
    assert.match(readOutput, /"revision": 2/)
    assert.equal(asks.length, 0)

    await definition.execute({
      action: 'advance',
      plan_id: '11111111-1111-4111-8111-111111111111',
      expected_revision: 4,
      current_step_id: '22222222-2222-4222-8222-222222222222',
      next_step_id: '33333333-3333-4333-8333-333333333333',
    }, context())
    assert.equal(asks.length, 1)
    assert.equal(asks[0].permission, 'devspec_manage_plan')
    assert.deepEqual(asks[0].patterns, ['advance'])

    for (const call of calls) {
      assert.equal(call.headers.get('x-devspec-connection-capability'), capability)
      assert.equal(call.body.params.name, 'manage_plan')
      assert.equal('connection_id' in call.body.params.arguments, false)
      assert.doesNotMatch(JSON.stringify(call.body), /dvsc_hidden-capability-value/)
    }
  })
})
