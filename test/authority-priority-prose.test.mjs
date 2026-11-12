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

  // DevSpec item a868f41f: ruling a check job is never talked about in the room, and
  // a write that changed someone else's record is. The text points at the served
  // rules rather than restating them.
  it('points at check_job.room, tells the person about tell_person writes, and never asks for a post about ruling checks', () => {
    for (const file of ['commands/devspec.remote.md', 'instructions/devspec.md']) {
      const content = read(file)
      assert.match(content, /check_job\.room/, file)
      assert.match(content, /semantics\.notice_audience/, file)
      assert.match(content, /semantics\.notice_reply/, file)
      assert.match(content, /unresolved choice, hold, rejection, or block/, file)
      assert.match(content, /tell_person/, file)
      assert.doesNotMatch(content, /post what happened/i, file)
      const aboutChecks = content.split(/(?<=[.!?])\s+/).filter((text) => /check job|check_job/i.test(text) && !/\bnever\b/i.test(text))
      for (const sentence of aboutChecks) {
        assert.doesNotMatch(sentence, /\b(?:post|tell|report)\b[^.]{0,60}\b(?:rul(?:ed|ing)|verdicts?)\b/i,
          `${file} asks for a post about ruling a check job: ${sentence.slice(0, 160)}`)
      }
    }
  })
})
