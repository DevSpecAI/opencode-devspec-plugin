import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'

const root = process.cwd()
const temps = []

function copy(relative, target) {
  fs.cpSync(path.join(root, relative), path.join(target, relative), { recursive: true })
}

afterEach(() => {
  for (const temp of temps.splice(0)) fs.rmSync(temp, { recursive: true, force: true })
})

describe('clean release package', () => {
  it('runs prepack from no dist directory and includes the manage-plan module', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-devspec-clean-pack-'))
    temps.push(temp)
    for (const entry of [
      'src', 'commands', 'instructions', 'package.json', 'package-lock.json',
      'tsconfig.json', 'README.md', 'CHANGELOG.md', 'LICENSE',
    ]) copy(entry, temp)
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'dir')
    assert.equal(fs.existsSync(path.join(temp, 'dist')), false, 'fixture must start like a clean checkout')

    const stdout = execFileSync('npm', ['pack', '--json'], {
      cwd: temp,
      encoding: 'utf8',
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
    })
    const packed = JSON.parse(stdout)
    assert.equal(packed.length, 1)
    const tarball = path.join(temp, packed[0].filename)
    const entries = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).trim().split('\n')
    for (const required of [
      'package/dist/plugin.js',
      'package/dist/manage-plan-tool.js',
      'package/dist/manage-plan-tool.d.ts',
      'package/dist/devspec-client.js',
    ]) assert.ok(entries.includes(required), `clean package omitted ${required}`)
  })
})
