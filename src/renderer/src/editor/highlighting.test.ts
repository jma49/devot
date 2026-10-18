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
const defs = LanguageDescription.of({
  name: 'defs',
  support: new LanguageSupport(
    StreamLanguage.define({
      token(stream) {
        if (stream.match(/^(export|const)\b/)) return 'keyword'
        if (stream.eat('!')) return 'logicOperator'
        if (stream.eat('=')) return 'definitionOperator'
        stream.next()
        return null
      },
      tokenTable: {
        logicOperator: tags.logicOperator,
        definitionOperator: tags.definitionOperator,
      },
    }),
  ),
})
const tsLike = tagHighlighter([
  { tag: tags.processingInstruction, class: 'mark' },
  { tag: tags.keyword, class: 'keyword' },
  { tag: tags.logicOperator, class: 'logic' },
  { tag: tags.definitionOperator, class: 'definition' },
])
const highlighter = tagHighlighter([
  { tag: tags.operator, class: 'op' },
  { tag: tags.processingInstruction, class: 'mark' },
  { tag: tags.strong, class: 'strong' },
])

function spans(doc: string, codeLanguages: LanguageDescription[] = [], using = highlighter) {
  const state = EditorState.create({
    doc,
    extensions: markdown({
      codeLanguages: [
        LanguageDescription.of({ name: 'ops', support: new LanguageSupport(ops) }),
        ...codeLanguages,
      ],
    }),
  })
  ensureSyntaxTree(state, state.doc.length, 5000)
  return highlightSpans(state, using, 0, state.doc.length).map(
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

  it('keeps a `!` the grammar reads apart in one span with its `=`', () => {
    // Not valid TypeScript: its grammar reads `objectPlugin!` (a definite
    // assignment, a logic operator) and then `=` (a definition operator),
    // styled apart. This grammar tags them the same way.
    expect(spans('```defs\nexport const objectPlugin != {\n}\n```', [defs], tsLike)).toEqual([
      '```:mark',
      'export:keyword',
      'const:keyword',
      '!=:logic',
      '```:mark',
    ])
  })
})
