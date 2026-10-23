import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, mock } from 'node:test'
import { mcpToolsCall } from '../dist/devspec-client.js'
import { DevSpecPlugin } from '../dist/plugin.js'
import { resetBondsForTests } from '../dist/remote-control.js'
import { LOADED_PLUGIN_VERSION, PLUGIN_HEADER, connectionVersionArguments, identifyDevspecMcpServers, pluginHeaderValue, pluginHeaders } from '../dist/plugin-version.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version

test('internal registration and attachment report this loaded package without a guessed host', async () => {
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    seen.push(JSON.parse(options.body).params)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    assert.equal(LOADED_PLUGIN_VERSION, version)
    for (const name of ['register_connection', 'attach_connection']) {
      await mcpToolsCall({ mcpUrl: 'https://fixture.example.test/api/mcp', token: 'fixture', name, arguments: { connection_id: 'c', plugin_version: 'guess', host_version: 'guess' } })
    }
    for (const call of seen) {
      assert.equal(call.arguments.plugin_version, version)
      assert.equal(call.arguments.host_version, undefined)
      assert.equal(call.arguments.connection_id, 'c')
    }
  } finally { globalThis.fetch = original }
})

test('the native before-tool hook also enriches raw model MCP register and attach calls', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-version-home-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-version-project-'))
  const homeMock = mock.method(os, 'homedir', () => home)
  const originalFetch = globalThis.fetch
  let healthRequested = false
  globalThis.fetch = async input => {
    assert.equal(new URL(typeof input === 'string' ? input : input.url).pathname, '/global/health')
    healthRequested = true
    return new Response(JSON.stringify({ healthy: true, version: '1.18.15' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  let hooks
  try {
    resetBondsForTests()
    hooks = await DevSpecPlugin({ client: {}, directory: project, serverUrl: new URL('http://127.0.0.1:12345') })
    for (let i = 0; i < 50 && !connectionVersionArguments({}).host_version; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(healthRequested, true)
    assert.equal(connectionVersionArguments({}).host_version, '1.18.15')
    for (const tool of ['devspec_register_connection', 'devspec_attach_connection']) {
      const output = { args: { connection_id: 'c', session_id: 'room', plugin_version: 'guess', host_version: 'guess' } }
      const originalArgs = output.args
      await hooks['tool.execute.before']({ tool, sessionID: 'ses_fixture', callID: `call_${tool}` }, output)
      assert.equal(output.args, originalArgs, 'other hooks and the host retain this argument object')
      assert.equal(output.args.plugin_version, version)
      assert.equal(output.args.host_version, '1.18.15')
      assert.equal(output.args.connection_id, 'c')
    }
  } finally {
    await hooks?.dispose?.(); resetBondsForTests(); homeMock.mock.restore(); globalThis.fetch = originalFetch
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true })
  }
})

test('only valid observed host versions are reported; conflicting host evidence stays unknown', async () => {
  const reporter = await import('../dist/plugin-version.js?host-evidence')
  assert.equal(reporter.connectionVersionArguments({ host_version: 'guess' }).host_version, undefined)
  reporter.observeHostVersion(undefined)
  reporter.observeHostVersion('not a version')
  assert.equal(reporter.connectionVersionArguments({}).host_version, undefined)
  reporter.observeHostVersion('1.18.15')
  assert.equal(reporter.connectionVersionArguments({}).host_version, '1.18.15')
  reporter.observeHostVersion('2.0.0')
  assert.equal(reporter.connectionVersionArguments({}).host_version, undefined)
})

test('compiled file/symlink installs resolve their own manifest and retain the loaded version', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-version-artifact-'))
  try {
    const artifact = path.join(fixture, 'artifact')
    fs.mkdirSync(path.join(artifact, 'dist'), { recursive: true })
    const manifest = { name: 'opencode-devspec-plugin', version: '1.2.3', type: 'module' }
    fs.writeFileSync(path.join(artifact, 'package.json'), JSON.stringify(manifest))
    fs.writeFileSync(path.join(artifact, 'dist/plugin-version.js'), fs.readFileSync(path.join(root, 'dist/plugin-version.js')))
    // Its one import: the plugin id for the x-devspec-plugin header.
    fs.writeFileSync(path.join(artifact, 'dist/agent-identity.js'), fs.readFileSync(path.join(root, 'dist/agent-identity.js')))
    const link = path.join(fixture, 'installed-link')
    fs.symlinkSync(artifact, link, 'junction')
    const loaded = await import(pathToFileURL(path.join(link, 'dist/plugin-version.js')).href)
    assert.equal(loaded.LOADED_PLUGIN_VERSION, '1.2.3')
    fs.writeFileSync(path.join(artifact, 'package.json'), JSON.stringify({ ...manifest, version: '9.9.9' }))
    assert.equal(loaded.connectionVersionArguments({}).plugin_version, '1.2.3')
    assert.deepEqual(loaded.pluginHeaders(), { 'x-devspec-plugin': 'opencode/1.2.3' })
    assert.equal(connectionVersionArguments({}).plugin_version, version)
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})

// x-devspec-plugin (item ae865d3e): `opencode/<this package's version>` on every DevSpec
// MCP request, from both OpenCode's own client and the plugin's in-process calls.
test('the header is opencode/<the loaded package version>, or absent', () => {
  assert.equal(PLUGIN_HEADER, 'x-devspec-plugin')
  assert.equal(pluginHeaderValue(), `opencode/${version}`)
  assert.deepEqual(pluginHeaders(), { 'x-devspec-plugin': `opencode/${version}` })
  assert.equal(pluginHeaderValue('1.2.3-rc.1'), 'opencode/1.2.3-rc.1')
  // <id>/<version> must stay one split: an unreadable or slash-bearing version sends nothing.
  for (const bad of [null, '', 'has space', 'a/b', '../1']) assert.deepEqual(pluginHeaders(bad), {}, String(bad))
})

test("OpenCode's own DevSpec entry gets the header in memory; other servers and headers are left alone", () => {
  const cfg = {
    mcp: {
      devspec: { type: 'remote', url: 'https://api.devspecstaging.com/api/mcp', headers: { Authorization: 'Bearer dvs_kept', 'X-DevSpec-Plugin': 'opencode/0.0.1', 'x-other': 'kept' } },
      DevSpec: { type: 'remote', url: 'https://api.devspec.ai/api/mcp' },
      other: { type: 'remote', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer other' } },
      local: { type: 'local', command: ['devspec'] },
    },
  }
  assert.deepEqual(identifyDevspecMcpServers(cfg), ['devspec', 'DevSpec'])
  assert.deepEqual(cfg.mcp.devspec.headers, { Authorization: 'Bearer dvs_kept', 'x-other': 'kept', 'x-devspec-plugin': `opencode/${version}` })
  assert.deepEqual(cfg.mcp.DevSpec.headers, { 'x-devspec-plugin': `opencode/${version}` })
  assert.deepEqual(cfg.mcp.other.headers, { Authorization: 'Bearer other' })
  assert.equal(cfg.mcp.local.headers, undefined, 'a local (stdio) server has no HTTP headers')
  assert.deepEqual(identifyDevspecMcpServers({}), [])
  const unversioned = { mcp: { devspec: { type: 'remote', url: 'u', headers: { Authorization: 'Bearer t' } } } }
  assert.deepEqual(identifyDevspecMcpServers(unversioned, null), [])
  assert.deepEqual(unversioned.mcp.devspec.headers, { Authorization: 'Bearer t' })
})

test("the plugin's config hook stamps the entry OpenCode connects with", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-header-home-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-header-project-'))
  const homeMock = mock.method(os, 'homedir', () => home)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ healthy: true, version: '1.18.23' }), { status: 200, headers: { 'content-type': 'application/json' } })
  let hooks
  try {
    resetBondsForTests()
    hooks = await DevSpecPlugin({ client: {}, directory: project, serverUrl: new URL('http://127.0.0.1:12345') })
    const cfg = { mcp: { devspec: { type: 'remote', url: 'https://api.devspecstaging.com/api/mcp', headers: { Authorization: 'Bearer dvs_fixture' } } } }
    await hooks.config(cfg)
    assert.equal(cfg.mcp.devspec.headers['x-devspec-plugin'], `opencode/${version}`)
    assert.equal(cfg.mcp.devspec.headers.Authorization, 'Bearer dvs_fixture')
    assert.ok(cfg.command?.['devspec.remote'], 'the hook still registers the bundled commands')
  } finally {
    await hooks?.dispose?.(); resetBondsForTests(); homeMock.mock.restore(); globalThis.fetch = originalFetch
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true })
  }
})

test('in-process DevSpec calls carry the header on a real socket, beside the capability header', async () => {
  const seen = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    seen.push({ tool: JSON.parse(body).params.name, plugin: req.headers['x-devspec-plugin'], capability: req.headers['x-devspec-connection-capability'] ?? null })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"ok":true}' }] } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const mcpUrl = `http://127.0.0.1:${server.address().port}/api/mcp`
  try {
    await mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'get_task', arguments: {} })
    await mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'register_connection', arguments: { connection_id: 'c' } })
    await mcpToolsCall({ mcpUrl, token: 'dvs_fixture', name: 'poll_connection', arguments: { connection_id: 'c' }, connectionCapability: 'dvsc_fixture', timeoutMs: 5_000 })
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  assert.deepEqual(seen, [
    { tool: 'get_task', plugin: `opencode/${version}`, capability: null },
    { tool: 'register_connection', plugin: `opencode/${version}`, capability: null },
    { tool: 'poll_connection', plugin: `opencode/${version}`, capability: 'dvsc_fixture' },
  ])
})
