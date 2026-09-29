import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  basicAuthHeaderValue,
  buildOpencodeRunArgs,
  buildOpencodeServeArgs,
  buildWindowsVisibleOpenCodeStartArgs,
  directoryKey,
  extractSessionIdFromPrompt,
  fleetInstanceIdFromPromptFile,
  redactArgsForLog,
  resolveServeAuth,
  withServeAuthEnv,
} from '../launcher-adapter/launch-opencode-session.mjs'

describe('buildWindowsVisibleOpenCodeStartArgs', () => {
  it('opens a titled cmd /k window (not a hidden OpenCode process)', () => {
    const args = buildWindowsVisibleOpenCodeStartArgs('C:\\tools\\opencode.exe', [
      'run',
      '--auto',
      '--attach',
      'http://127.0.0.1:4096',
      'hello',
    ])
    assert.deepEqual(args.slice(0, 5), [
      '/c',
      'start',
      'DevSpec OpenCode',
      'cmd.exe',
      '/k',
    ])
    assert.match(args[5], /opencode\.exe/)
    assert.match(args[5], /--attach/)
    assert.match(args[5], /127\.0\.0\.1:4096/)
  })
})

describe('directoryKey / fleet instance', () => {
  it('distinguishes two sessionless fleet launches in the same folder', () => {
    const folder = 'C:\\Users\\Brandon Young\\Repositories\\Combined\\DevSpecV2'
    const a = directoryKey(folder, null, '1790109140882-dma4fd')
    const b = directoryKey(folder, null, '1790109144550-xsror7')
    const bare = directoryKey(folder, null)
    assert.notEqual(a, b)
    assert.notEqual(a, bare)
    assert.notEqual(b, bare)
  })

  it('fleetInstanceIdFromPromptFile only applies under DEVSPEC_FLEET_SETTLE', () => {
    const prev = process.env.DEVSPEC_FLEET_SETTLE
    try {
      delete process.env.DEVSPEC_FLEET_SETTLE
      assert.equal(
        fleetInstanceIdFromPromptFile('C:\\tmp\\1790109140882-dma4fd.prompt.txt'),
        null,
      )
      process.env.DEVSPEC_FLEET_SETTLE = '1'
      assert.equal(
        fleetInstanceIdFromPromptFile('C:\\tmp\\1790109140882-dma4fd.prompt.txt'),
        '1790109140882-dma4fd',
      )
    } finally {
      if (prev === undefined) delete process.env.DEVSPEC_FLEET_SETTLE
      else process.env.DEVSPEC_FLEET_SETTLE = prev
    }
  })
})

describe('buildOpencodeServeArgs', () => {
  it('passes --port only — serve rejects --auto (OpenCode 1.18+)', () => {
    assert.deepEqual(buildOpencodeServeArgs(4096), ['serve', '--port', '4096'])
  })
})

describe('buildOpencodeRunArgs', () => {
  it('routes a leading slash-command through --command, not the plain message', () => {
    const args = buildOpencodeRunArgs('/devspec.remote --session abc-123')
    assert.deepEqual(args, [
      'run',
      '--auto',
      '--command',
      'devspec.remote',
      '--',
      '--session abc-123',
    ])
  })

  it('omits the -- separator when the command has no arguments', () => {
    const args = buildOpencodeRunArgs('/devspec.remote-stop')
    assert.deepEqual(args, ['run', '--auto', '--command', 'devspec.remote-stop'])
  })

  it('passes a plain (non-command) prompt through as the positional message', () => {
    const args = buildOpencodeRunArgs('Say hello and tell me which model you are.')
    assert.deepEqual(args, ['run', '--auto', 'Say hello and tell me which model you are.'])
  })

  it('includes --model before the command/message when set', () => {
    const args = buildOpencodeRunArgs('/devspec.remote --session abc-123', 'minimax/MiniMax-M3')
    assert.deepEqual(args, [
      'run',
      '--auto',
      '--model',
      'minimax/MiniMax-M3',
      '--command',
      'devspec.remote',
      '--',
      '--session abc-123',
    ])
  })
})

describe('extractSessionIdFromPrompt', () => {
  it('reads --session <uuid>', () => {
    const id = extractSessionIdFromPrompt(
      '/devspec.remote --session 7e3afc79-abf4-48e4-ae33-aed27b00944d',
    )
    assert.equal(id, '7e3afc79-abf4-48e4-ae33-aed27b00944d')
  })

  it('returns null when no uuid is present', () => {
    assert.equal(extractSessionIdFromPrompt('/devspec.remote'), null)
  })
})

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
    assert.equal(auth.username, 'opencode')
    assert.ok(auth.password.length >= 32)
  })

  it('mints when env password is whitespace-only', () => {
    const auth = resolveServeAuth({ OPENCODE_SERVER_PASSWORD: '   ' })
    assert.equal(auth.source, 'minted')
  })
})

describe('withServeAuthEnv + basicAuthHeaderValue + redactArgsForLog', () => {
  it('copies auth into child env without mutating the parent', () => {
    const parent = { PATH: '/bin', OPENCODE_PERMISSION: '{}' }
    const next = withServeAuthEnv(parent, { username: 'opencode', password: 'secret' })
    assert.equal(next.OPENCODE_SERVER_PASSWORD, 'secret')
    assert.equal(next.OPENCODE_SERVER_USERNAME, 'opencode')
    assert.equal(parent.OPENCODE_SERVER_PASSWORD, undefined)
  })

  it('builds a Basic auth header', () => {
    assert.equal(
      basicAuthHeaderValue('opencode', 'secret'),
      `Basic ${Buffer.from('opencode:secret', 'utf8').toString('base64')}`,
    )
  })

  it('redacts --password values in argv logs', () => {
    assert.deepEqual(redactArgsForLog(['run', '--password', 's3cret', '--attach', 'http://x']), [
      'run',
      '--password',
      '<redacted>',
      '--attach',
      'http://x',
    ])
  })
})
