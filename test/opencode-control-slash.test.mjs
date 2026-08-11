import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  parseOpencodeControlSlash,
  resolveOwnerControlSlash,
  controlSlashSuccessMessage,
} from '../dist/opencode-control-slash.js'

describe('parseOpencodeControlSlash', () => {
  it('accepts exact native control tokens and aliases', () => {
    assert.deepEqual(parseOpencodeControlSlash('/compact'), { kind: 'compact' })
    assert.deepEqual(parseOpencodeControlSlash('/summarize'), { kind: 'compact' })
    assert.deepEqual(parseOpencodeControlSlash('/abort'), { kind: 'abort' })
    assert.deepEqual(parseOpencodeControlSlash('/new'), { kind: 'new' })
    assert.deepEqual(parseOpencodeControlSlash('/clear'), { kind: 'new' })
    assert.deepEqual(parseOpencodeControlSlash('/undo'), { kind: 'undo' })
    assert.deepEqual(parseOpencodeControlSlash('/redo'), { kind: 'redo' })
  })

  it('rejects prose, args, and unknown slashes', () => {
    assert.equal(parseOpencodeControlSlash('/compact please'), null)
    assert.equal(parseOpencodeControlSlash('compact'), null)
    assert.equal(parseOpencodeControlSlash('/catchup'), null)
    assert.equal(parseOpencodeControlSlash('/invented'), null)
    assert.equal(parseOpencodeControlSlash(''), null)
  })
})

describe('resolveOwnerControlSlash', () => {
  it('requires exactly one command with exact slash text', () => {
    assert.deepEqual(resolveOwnerControlSlash([{ content: '/abort' }]), { kind: 'abort' })
    assert.equal(resolveOwnerControlSlash([{ content: '/abort' }, { content: '/compact' }]), null)
    assert.equal(resolveOwnerControlSlash([{ content: 'hello' }]), null)
    assert.equal(resolveOwnerControlSlash([]), null)
  })
})

describe('controlSlashSuccessMessage', () => {
  it('returns a short confirmation for each kind', () => {
    assert.match(controlSlashSuccessMessage({ kind: 'abort' }), /Abort/i)
    assert.match(controlSlashSuccessMessage({ kind: 'new' }), /new/i)
  })
})
