import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { checkBundle } from '../launcher/check-bundle.mjs'
test('OpenCode packages the shared launcher and its separate credential-bearing adapter', () => {
  const payload = checkBundle()
  assert.ok(payload.files.has('plugin-setup.mjs'))
  assert.ok(!payload.files.has('launch-opencode-session.mjs'))
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('launcher'))
  assert.ok(pkg.files.includes('launcher-adapter'))
  assert.ok(existsSync(new URL('../launcher-adapter/launch-opencode-session.mjs', import.meta.url)))
  const factory = readFileSync(new URL('../src/plugin.ts', import.meta.url), 'utf8')
  assert.match(factory, /void setupSharedLauncher\(directory\)/)
})
