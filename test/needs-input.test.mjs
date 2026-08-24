import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatQuestionPrompt, parseNeedsInputReply } from '../dist/remote-control.js'

describe('formatQuestionPrompt', () => {
  it('formats a single question with options', () => {
    const text = formatQuestionPrompt({
      questions: [
        {
          header: 'Deploy',
          question: 'Ship to staging now?',
          options: [
            { label: 'Yes', description: 'Deploy immediately' },
            { label: 'No' },
          ],
        },
      ],
    })
    assert.match(text, /Deploy: Ship to staging now\?/)
    assert.match(text, /- Yes — Deploy immediately/)
    assert.match(text, /- No/)
  })

  it('numbers multiple questions', () => {
    const text = formatQuestionPrompt({
      questions: [{ question: 'A?' }, { question: 'B?' }],
    })
    assert.match(text, /1\. A\?/)
    assert.match(text, /2\. B\?/)
  })
})

describe('parseNeedsInputReply', () => {
  it('returns the exact request and per-question answer arrays', () => {
    const payload = encodeURIComponent(JSON.stringify({
      requestId: 'que_123',
      answers: [['A'], ['B', 'Custom']],
    }))
    assert.deepEqual(
      parseNeedsInputReply(`A\n2: B, Custom\n\n<!--devspec-needs-input-reply:${payload}-->`),
      { requestId: 'que_123', answers: [['A'], ['B', 'Custom']] },
    )
  })

  it('rejects missing, malformed, and empty markers', () => {
    assert.equal(parseNeedsInputReply('ordinary owner command'), null)
    assert.equal(parseNeedsInputReply('\n\n<!--devspec-needs-input-reply:%7Bbad-->'), null)
    const empty = encodeURIComponent(JSON.stringify({ requestId: 'que_123', answers: [[]] }))
    assert.equal(parseNeedsInputReply(`x\n\n<!--devspec-needs-input-reply:${empty}-->`), null)
  })
})
