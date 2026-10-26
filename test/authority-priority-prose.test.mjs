#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')

describe('priority-host authority terminology', () => {
  it('keeps the old assignment-shaped state name only as a compatibility read', () => {
    const source = read('src/remote-control.ts')
    assert.match(source, /deliveredAutomationDispatchIds/)
    assert.doesNotMatch(source, /\bdeliveredDispatchIds\b/)
    assert.equal([...source.matchAll(/\bdeliveredAssignmentIds\b/g)].length, 1)
    assert.match(source, /One-way local-state compatibility/)
  })

  it('describes sessionless automations without assignment or progress delivery prose', () => {
    const command = read('commands/devspec.remote.md')

    assert.doesNotMatch(command, /\*\*Sessionless:\*\*.*`report_progress`/)
    assert.match(command, /Separately accepted owner-scoped automation runs/)
    assert.match(command, /server's canonical authority stamp/)
  })
})
