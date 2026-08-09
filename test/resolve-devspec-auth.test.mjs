import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveDevspecAuth } from '../dist/resolve-devspec-auth.js'

/**
 * Fixtures for resolveDevspecAuth: temp project dirs and a temp HOME so the
 * real machine's config never leaks into an assertion. The resolver reads
 * os.homedir() live (libuv checks $HOME / %USERPROFILE% per call), so
 * overriding both env vars redirects the global-config lookup.
 */

const ENV_KEYS = ['DEVSPEC_MCP_TOKEN', 'DEVSPEC_TOKEN', 'DEVSPEC_MCP_URL', 'HOME', 'USERPROFILE']

let savedEnv
let tmp

function configBlock(token, url = 'https://staging.devspec.ai/api/mcp') {
  return JSON.stringify({
    mcp: { devspec: { type: 'remote', url, headers: { Authorization: `Bearer ${token}` } } },
  })
}

function writeFile(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), content)
}

/** A project dir guaranteed to find NO config in itself or any parent. */
function bareProjectDir() {
  const dir = path.join(tmp, 'proj')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function useTempHome() {
  const home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  process.env.HOME = home
  process.env.USERPROFILE = home
  return home
}

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsauth-'))
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('resolveDevspecAuth — config filenames (item 8e0bb031)', () => {
  it('finds the token in a project opencode.jsonc', () => {
    writeFile(tmp, 'opencode.jsonc', configBlock('tok-project-jsonc'))
    const auth = resolveDevspecAuth(tmp)
    assert.equal(auth.ok, true)
    assert.equal(auth.token, 'tok-project-jsonc')
    assert.match(auth.source, /opencode\.jsonc$/)
  })

  it('still reads a plain opencode.json (regression)', () => {
    writeFile(tmp, 'opencode.json', configBlock('tok-plain-json'))
    const auth = resolveDevspecAuth(tmp)
    assert.equal(auth.ok, true)
    assert.equal(auth.token, 'tok-plain-json')
  })

  it('opencode.jsonc wins over opencode.json (matches OpenCode merge order)', () => {
    // OpenCode loads config.json → opencode.json → opencode.jsonc, later files
    // deep-merging over earlier — so when both define mcp.devspec, .jsonc is
    // what OpenCode's own MCP client would use, and the poller must run under
    // the same token (token symmetry, item 74b29c76).
    writeFile(tmp, 'opencode.json', configBlock('tok-json'))
    writeFile(tmp, 'opencode.jsonc', configBlock('tok-jsonc'))
    const auth = resolveDevspecAuth(tmp)
    assert.equal(auth.token, 'tok-jsonc')
  })

  it('walks up from nested project directories to a parent opencode.jsonc', () => {
    writeFile(tmp, 'opencode.jsonc', configBlock('tok-parent'))
    const nested = path.join(tmp, 'a', 'b')
    fs.mkdirSync(nested, { recursive: true })
    const auth = resolveDevspecAuth(nested)
    assert.equal(auth.ok, true)
    assert.equal(auth.token, 'tok-parent')
  })

  it('finds the token in the global ~/.config/opencode/opencode.jsonc with no project config', () => {
    const home = useTempHome()
    writeFile(path.join(home, '.config', 'opencode'), 'opencode.jsonc', configBlock('tok-global-jsonc'))
    const auth = resolveDevspecAuth(bareProjectDir())
    assert.equal(auth.ok, true)
    assert.equal(auth.token, 'tok-global-jsonc')
  })
})

describe('resolveDevspecAuth — JSONC syntax tolerance', () => {
  it('parses line comments, block comments and trailing commas', () => {
    writeFile(
      tmp,
      'opencode.jsonc',
      `{
        // line comment before the block
        "mcp": {
          "devspec": {
            "url": "https://staging.devspec.ai/api/mcp", /* inline block comment */
            "headers": { "Authorization": "Bearer tok-jsonc-syntax", },
          },
        },
      }`,
    )
    const auth = resolveDevspecAuth(tmp)
    assert.equal(auth.ok, true)
    assert.equal(auth.token, 'tok-jsonc-syntax')
    // The naive-regex trap: stripping `//` without string awareness would eat
    // the URL scheme's slashes. The URL must survive intact.
    assert.equal(auth.mcp_url, 'https://staging.devspec.ai/api/mcp')
  })
})

describe('resolveDevspecAuth — env fallback and failure', () => {
  it('falls back to DEVSPEC_MCP_TOKEN when no config file provides a token', () => {
    useTempHome()
    process.env.DEVSPEC_MCP_TOKEN = 'tok-env'
    const auth = resolveDevspecAuth(bareProjectDir())
    assert.equal(auth.ok, true)
    assert.equal(auth.token, 'tok-env')
    assert.equal(auth.source, 'env')
  })

  it('reports ok:false with an error naming both config filenames when nothing is configured', () => {
    useTempHome()
    const auth = resolveDevspecAuth(bareProjectDir())
    assert.equal(auth.ok, false)
    assert.match(auth.error, /opencode\.json/)
    assert.match(auth.error, /opencode\.jsonc/)
  })
})
