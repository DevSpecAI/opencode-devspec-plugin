import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatQuestionPrompt } from '../dist/remote-control.js'

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
