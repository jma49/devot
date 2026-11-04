import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { expectWithinBudget, skipIfOverloaded } from '../../../../tests/support/budget'
import { toggleAlert, toggleCodeBlock, toggleList, toggleQuote } from './blocks'
import { noteMarkdown } from './markdown'

describe('large notes', () => {
  const block =
    'Some text with `code` here.\n\n- item one\n  - [ ] task two\n\n```js\nconst a = 1\n```\n\n> a quote\n\n1. first\n2. second\n\n'
  const big = () => {
    let doc = ''
    while (doc.length < 200_000) doc += block
    return EditorState.create({
      doc,
      selection: EditorSelection.single(0, doc.length),
      extensions: [noteMarkdown],
    })
  }

  const commands: [string, (s: EditorState) => TransactionSpec | null][] = [
    ['numbered list', (s) => toggleList(s, 'numbered')],
    ['bulleted list', (s) => toggleList(s, 'bullet')],
    ['quote', toggleQuote],
    ['alert', (s) => toggleAlert(s, 'note')],
    ['code block', toggleCodeBlock],
  ]

  it('formats a 200 KB selection it has to parse first', { timeout: 30_000 }, (context) => {
    // No time limit here, but the parse itself has a budget.
    for (const [name, command] of commands) {
      const spec = command(big())
      if (spec === null) skipIfOverloaded(context, `${name}: parse budget ran out`)
      expect(spec).not.toBeNull()
    }
  })

  it.for(commands)('formats a parsed 200 KB selection quickly: %s', ([, command], context) => {
    const s = big()
    expect(ensureSyntaxTree(s, s.doc.length, 1e9)).not.toBeNull()
    const start = performance.now()
    const spec = command(s)
    const ms = performance.now() - start
    if (spec === null) skipIfOverloaded(context, 'parse budget ran out')
    expect(spec).not.toBeNull()
    expectWithinBudget(context, ms, 3000)
  })
})
