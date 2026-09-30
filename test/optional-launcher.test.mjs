import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
test('OpenCode publishes only its own plugin, with no launcher setup in initialization', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)))
  assert.ok(!pkg.files.includes('launcher'))
  assert.ok(!pkg.files.includes('launcher-adapter'))
  for (const relative of ['../launcher', '../launcher-adapter', '../src/launcher.ts']) assert.equal(fs.existsSync(new URL(relative, import.meta.url)), false)
  const factory = fs.readFileSync(new URL('../src/plugin.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(factory, /setupSharedLauncher|from ['"]\.\/launcher/)
  assert.match(factory, /CommitProvenance/)
  assert.match(factory, /applyServeAuthToPluginClient/)
  const compiled = fs.readFileSync(new URL('../dist/plugin.js', import.meta.url), 'utf8')
  assert.doesNotMatch(compiled, /setupSharedLauncher|from ['"]\.\/launcher/)
  assert.equal(fs.existsSync(new URL('../dist/launcher.js', import.meta.url)), false)
})
