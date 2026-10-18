import { markdown } from '@codemirror/lang-markdown'
import {
  ensureSyntaxTree,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { tags, tagHighlighter } from '@lezer/highlight'
import { describe, expect, it } from 'vitest'
import { highlightSpans } from './highlighting'

// A grammar that styles `=` as an operator and leaves `!` plain, one
// character a token, as some highlighters do.
const ops = StreamLanguage.define({
  token(stream) {
    const ch = stream.next()
    return ch === '=' ? 'operator' : null
  },
})
const highlighter = tagHighlighter([
  { tag: tags.operator, class: 'op' },
  { tag: tags.processingInstruction, class: 'mark' },
  { tag: tags.strong, class: 'strong' },
])

function spans(doc: string) {
  const state = EditorState.create({
    doc,
    extensions: markdown({
      codeLanguages: [LanguageDescription.of({ name: 'ops', support: new LanguageSupport(ops) })],
    }),
  })
  ensureSyntaxTree(state, state.doc.length, 5000)
  return highlightSpans(state, highlighter, 0, state.doc.length).map(
    (s) => `${doc.slice(s.from, s.to)}:${s.style}`,
  )
}

describe('highlightSpans', () => {
  it('keeps each operator in a code block in one span', () => {
    // Without the join: `=:op` alone, then `=:op` twice.
    expect(spans('```ops\na != b == c\n```')).toEqual(['```:mark', '!=:op', '==:op', '```:mark'])
  })

  it('leaves text outside code as the highlighter styles it', () => {
    // `**!` is a run of symbols, but not code: the `!` stays plain.
    expect(spans('**a**! b')).toEqual(['**:strong mark', 'a:strong', '**:strong mark'])
  })
})
