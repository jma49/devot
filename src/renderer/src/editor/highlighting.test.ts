import { markdown } from '@codemirror/lang-markdown'
import {
  ensureSyntaxTree,
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { TreeCursor } from '@lezer/common'
import { highlightTree, tags, tagHighlighter } from '@lezer/highlight'
import { describe, expect, it, vi } from 'vitest'
import { joinOperatorRuns, type StyledSpan } from '../../../core/operatorRuns'
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

function parsed(doc: string, codeLanguages: LanguageDescription[] = []) {
  const state = EditorState.create({
    doc,
    extensions: markdown({
      codeLanguages: [
        LanguageDescription.of({ name: 'ops', support: new LanguageSupport(ops) }),
        ...codeLanguages,
      ],
    }),
  })
  return { state, tree: ensureSyntaxTree(state, state.doc.length, 5000)! }
}

function spans(doc: string, codeLanguages: LanguageDescription[] = [], using = highlighter) {
  const { state, tree } = parsed(doc, codeLanguages)
  return highlightSpans(state, using, 0, state.doc.length, tree).map(
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

  const blocks = (count: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `## Part ${i}\n\nSome **strong** prose ${i}.\n\n> a quote\n\n- an item\n\n\`\`\`ops\nx != ${i}\n\`\`\`\n\n`,
    ).join('')

  it('reads a range at the end of a long note in as few steps as one at its top', () => {
    const { state, tree } = parsed(blocks(2000))
    const length = state.doc.length
    const walked = (from: number, to: number) => {
      const steps = vi.spyOn(TreeCursor.prototype, 'nextSibling')
      highlightSpans(state, highlighter, from, to, tree)
      const count = steps.mock.calls.length
      steps.mockRestore()
      return count
    }
    const top = walked(0, 2000)
    // A range at the end must not step past the 10,000 blocks before it.
    expect(top).toBeGreaterThan(0)
    expect(walked(length - 2000, length)).toBeLessThan(top * 2)
  })

  it('gives the spans a walk from the root of the tree gives, for any range', () => {
    const doc = `---\ntitle: x\n---\n\n${blocks(40)}<div class="x">an <b>HTML</b> block</div>\n\n| a | b |\n| - | - |\n| **c** <i>d</i> | e |\n`
    const { state, tree } = parsed(doc)
    const length = state.doc.length
    const fromRoot = (from: number, to: number) => {
      let list: StyledSpan<string>[] = []
      highlightTree(
        tree,
        highlighter,
        (f, t, style) => list.push({ from: f, to: t, style }),
        from,
        to,
      )
      tree.iterate({
        from,
        to,
        enter: (node) => {
          if (!['FencedCode', 'CodeBlock', 'InlineCode'].includes(node.name)) return true
          const start = Math.max(node.from, from)
          const end = Math.min(node.to, to)
          list = joinOperatorRuns(state.sliceDoc(start, end), start, list, (s) => s)
          return false
        },
      })
      return list
    }
    for (const [from, to] of [
      [0, length],
      [0, 7],
      [3, 400],
      [doc.indexOf('Part 17') - 4, doc.indexOf('Part 23') + 2],
      [doc.indexOf('**strong** prose 30') + 3, doc.indexOf('x != 30') + 2],
      [doc.indexOf('<div') + 3, doc.indexOf('| a')],
      [doc.indexOf('| **c**') + 4, length],
      [length - 1, length],
    ] as const) {
      expect(highlightSpans(state, highlighter, from, to, tree), `${from}-${to}`).toEqual(
        fromRoot(from, to),
      )
    }
  })
})
