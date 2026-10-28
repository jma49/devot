import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { expectWithinBudget } from '../../../../tests/support/budget'
import { codeBlocks } from './codeBlocks'
import { markdownLineStyles } from './lineStyles'
import { noteMarkdown } from './markdown'

describe('the gutter line classes', () => {
  it('keep up with one edit on each of thousands of lines (a list made of a long note)', (context) => {
    const lines = 5_000
    const doc = Array.from({ length: lines }, (_, i) => `Line ${i} plain`).join('\n')
    const s = EditorState.create({
      doc,
      extensions: [noteMarkdown, codeBlocks(), markdownLineStyles],
    })
    ensureSyntaxTree(s, s.doc.length, 20_000)
    const ready = s.update({}).state
    const changes = Array.from({ length: lines }, (_, i) => ({
      from: ready.doc.line(i + 1).from,
      insert: '- ',
    }))
    const started = performance.now()
    const listed = ready.update({ changes }).state
    expectWithinBudget(context, performance.now() - started, 400)
    expect(listed.doc.line(lines).text).toBe(`- Line ${lines - 1} plain`)
  })
})
