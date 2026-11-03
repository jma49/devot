import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { expectWithinBudget, skipIfOverloaded } from '../../../../tests/support/budget'
import { formatState, isInlineActive, toggleInline, type InlineFormat } from './formats'
import { noteMarkdown } from './markdown'

function apply(s: EditorState, spec: TransactionSpec | null): EditorState {
  expect(spec).not.toBeNull()
  return s.update(spec ?? {}).state
}

describe('large notes', () => {
  // A whole long note selected: every lookup must reuse one syntax tree.
  const block =
    'Some **bold** and *italic* text with `code` and a [link](https://x.y) here.\n\n' +
    '- item one\n- [ ] task two\n\n```js\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n'
  const big = () => {
    let doc = ''
    while (doc.length < 200_000) doc += block
    return EditorState.create({
      doc,
      selection: EditorSelection.single(0, doc.length),
      extensions: [noteMarkdown],
    })
  }

  it('formats a 200 KB selection quickly', { timeout: 30_000 }, (context) => {
    const s = big()
    const start = performance.now()
    const spec = toggleInline(s, 'bold')
    const ms = performance.now() - start
    // A command gives up (null) when its parse budget runs out.
    if (spec === null) skipIfOverloaded(context, 'parse budget ran out')
    expect(spec).not.toBeNull()
    expectWithinBudget(context, ms, 3000)
  })

  it('reads the toolbar state of a 200 KB selection quickly', { timeout: 30_000 }, (context) => {
    const s = big()
    // Parsed already (as the editor does in the background), so the state is read in full.
    ensureSyntaxTree(s, s.doc.length, 30_000)
    const start = performance.now()
    formatState(s)
    expectWithinBudget(context, performance.now() - start, 16)
  })
})

describe('inline formats on a long line with many spans', () => {
  const line = (count: number) =>
    Array.from({ length: count }, (_, i) => `**b${i}** x *i* \`c\``).join(' ')
  const whole = (count: number) => {
    const text = line(count)
    const s = EditorState.create({
      doc: text,
      selection: EditorSelection.single(0, text.length),
      extensions: [noteMarkdown],
    })
    ensureSyntaxTree(s, s.doc.length, 30_000)
    return s
  }

  it.for<InlineFormat>(['bold', 'italic', 'code'])(
    'toggles %s on 3000 spans in the time of a few keystrokes',
    (format, context) => {
      const s = whole(3000)
      const start = performance.now()
      const spec = toggleInline(s, format)
      const ms = performance.now() - start
      if (spec === null) skipIfOverloaded(context, 'parse budget ran out')
      expect(spec).not.toBeNull()
      expectWithinBudget(context, ms, 150)
    },
  )

  const units = (count: number, unit: (i: number) => string) =>
    Array.from({ length: count }, (_, i) => unit(i)).join(' ')
  const results: Record<InlineFormat, (count: number) => string> = {
    bold: (n) => `**${units(n, (i) => `b${i} x *i* \`c\``)}**`,
    italic: (n) => `*${units(n, (i) => `**b${i}** x i \`c\``)}*`,
    code: (n) => `\`${units(n, (i) => `**b${i}** x *i* c`)}\``,
    strikethrough: (n) => `~~${line(n)}~~`,
    highlight: (n) => `<mark>${line(n)}</mark>`,
  }

  it.for<[InlineFormat, number]>(
    (['bold', 'italic', 'code', 'strikethrough', 'highlight'] as const).flatMap((f) => [
      [f, 3] as [InlineFormat, number],
      [f, 600] as [InlineFormat, number],
    ]),
  )('makes the same text of %s on %i spans', ([format, count]) => {
    const s = whole(count)
    expect(apply(s, toggleInline(s, format)).doc.toString()).toBe(results[format](count))
  })

  it('takes a format off again', () => {
    const s = whole(40)
    const bolded = apply(s, toggleInline(s, 'bold'))
    expect(isInlineActive(bolded, 'bold')).toBe(true)
    const plain = apply(bolded, toggleInline(bolded, 'bold'))
    expect(isInlineActive(plain, 'bold')).toBe(false)
    expect(plain.doc.toString()).toBe(
      line(40)
        .replace(/\*\*(b\d+)\*\*/g, '$1')
        .replace(/^/, ''),
    )
  })
})
