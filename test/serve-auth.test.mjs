import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OPENCODE_SERVER_USERNAME_DEFAULT,
  applyServeAuthToPluginClient,
  ensureServeAuthEnv,
  resolveServeAuth,
} from '../dist/serve-auth.js'

describe('resolveServeAuth', () => {
  it('reuses a non-empty OPENCODE_SERVER_PASSWORD from env', () => {
    const auth = resolveServeAuth({
      OPENCODE_SERVER_PASSWORD: ' already-set ',
      OPENCODE_SERVER_USERNAME: 'custom',
    })
    assert.equal(auth.source, 'env')
    assert.equal(auth.password, 'already-set')
    assert.equal(auth.username, 'custom')
  })

  it('mints a strong password when env password is missing', () => {
    const auth = resolveServeAuth({})
    assert.equal(auth.source, 'minted')
    assert.equal(auth.username, OPENCODE_SERVER_USERNAME_DEFAULT)
    assert.ok(auth.password.length >= 32)
  })

  it('mints when env password is whitespace-only', () => {
    const auth = resolveServeAuth({ OPENCODE_SERVER_PASSWORD: '   ' })
    assert.equal(auth.source, 'minted')
  })
})

describe('ensureServeAuthEnv', () => {
  it('writes username and password onto the env bag', () => {
    const env = {}
    const auth = ensureServeAuthEnv(env)
    assert.equal(env.OPENCODE_SERVER_PASSWORD, auth.password)
    assert.equal(env.OPENCODE_SERVER_USERNAME, auth.username)
  })

  it('is idempotent — second call reuses the minted value', () => {
    const env = {}
    const first = ensureServeAuthEnv(env)
    const second = ensureServeAuthEnv(env)
    assert.equal(second.source, 'env')
    assert.equal(second.password, first.password)
  })
})

describe('applyServeAuthToPluginClient', () => {
  it('returns false for a null client', () => {
    assert.equal(applyServeAuthToPluginClient(null, { username: 'opencode', password: 'x' }), false)
  })

  it('registers a request interceptor when the SDK shape is present', () => {
    const seen = []
    const client = {
      _client: {
        interceptors: {
          request: {
            use(fn) {
              seen.push(fn)
            },
          },
        },
      },
    }
    assert.equal(
      applyServeAuthToPluginClient(client, { username: 'opencode', password: 'secret' }),
      true,
    )
    assert.equal(seen.length, 1)
    const req = { headers: {} }
    seen[0](req)
    assert.match(req.headers.Authorization, /^Basic /)
  })

  it('stamps Authorization on a Fetch Request without assigning to req.headers', () => {
    // Live OpenCode SDK passes Request-like objects whose `.headers` is a
    // Headers instance. Assigning `req.headers = …` throws
    // "Attempted to assign to readonly property" (Purple Kingfisher, 2026-08-08).
    const seen = []
    const client = {
      _client: {
        interceptors: {
          request: {
            use(fn) {
              seen.push(fn)
            },
          },
        },
      },
    }
    assert.equal(
      applyServeAuthToPluginClient(client, { username: 'opencode', password: 'secret' }),
      true,
    )
    const req = new Request('http://127.0.0.1/session/test/message')
    assert.doesNotThrow(() => seen[0](req))
    assert.match(req.headers.get('Authorization') ?? '', /^Basic /)
  })
})
