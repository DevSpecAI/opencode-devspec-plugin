import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, mock } from 'node:test'
import { mcpToolsCall } from '../dist/devspec-client.js'
import { DevSpecPlugin } from '../dist/plugin.js'
import { resetBondsForTests } from '../dist/remote-control.js'
import { LOADED_PLUGIN_VERSION, connectionVersionArguments } from '../dist/plugin-version.js'

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
    const link = path.join(fixture, 'installed-link')
    fs.symlinkSync(artifact, link, 'junction')
    const loaded = await import(pathToFileURL(path.join(link, 'dist/plugin-version.js')).href)
    assert.equal(loaded.LOADED_PLUGIN_VERSION, '1.2.3')
    fs.writeFileSync(path.join(artifact, 'package.json'), JSON.stringify({ ...manifest, version: '9.9.9' }))
    assert.equal(loaded.connectionVersionArguments({}).plugin_version, '1.2.3')
    assert.equal(connectionVersionArguments({}).plugin_version, version)
  } finally { fs.rmSync(fixture, { recursive: true, force: true }) }
})
