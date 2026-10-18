import type { ElementContent } from 'hast'
import { toHtml } from 'hast-util-to-html'
import { describe, expect, it } from 'vitest'
import { joinOperatorRuns, joinOperatorRunsInHast, type StyledSpan } from './operatorRuns'

const span = (from: number, to: number, style: string): StyledSpan<string> => ({ from, to, style })
const join = (text: string, spans: StyledSpan<string>[], offset = 0) =>
  joinOperatorRuns(text, offset, spans, (s) => s)

describe('joinOperatorRuns', () => {
  it('gives an operator split between plain text and a style the style', () => {
    // A shell grammar: `!` plain, `=` an operator.
    expect(join('a != b', [span(3, 4, 'op')])).toEqual([span(2, 4, 'op')])
  })

  it('joins two spans of one style into one', () => {
    expect(join('a == b', [span(2, 3, 'op'), span(3, 4, 'op')])).toEqual([span(2, 4, 'op')])
  })

  it('takes the style that covers most of the run', () => {
    expect(join('x === y', [span(2, 3, 'a'), span(3, 5, 'b')])).toEqual([span(2, 5, 'b')])
    // A tie between styles goes to the first.
    expect(join('x => y', [span(2, 3, 'a'), span(3, 4, 'b')])).toEqual([span(2, 4, 'a')])
  })

  it('leaves a run plain when plain text covers most of it', () => {
    expect(join('x !== y', [span(4, 5, 'op')])).toEqual([])
  })

  it('keeps the parts of spans outside the run', () => {
    expect(join('a->b', [span(0, 2, 'v'), span(2, 4, 'w')])).toEqual([
      span(0, 1, 'v'),
      span(1, 3, 'v'),
      span(3, 4, 'w'),
    ])
  })

  it('leaves whole runs, single characters and plain runs alone', () => {
    const spans = [span(0, 1, 'v'), span(2, 4, 'op'), span(5, 6, 'v'), span(7, 8, 'op')]
    expect(join('a != b = c -> d', spans)).toEqual(spans)
  })

  it('reads the text at its offset and keeps spans outside it', () => {
    const spans = [span(0, 2, 'x'), span(12, 13, 'op'), span(13, 14, 'op'), span(20, 22, 'y')]
    expect(join('a == b', spans, 10)).toEqual([
      span(0, 2, 'x'),
      span(12, 14, 'op'),
      span(20, 22, 'y'),
    ])
  })

  it('handles each run of a line', () => {
    const spans = [span(2, 3, 'op'), span(3, 4, 'op'), span(8, 9, 'op')]
    expect(join('a == b && c', spans)).toEqual([span(2, 4, 'op'), span(7, 9, 'op')])
  })
})

const el = (cls: string, ...children: ElementContent[]): ElementContent => ({
  type: 'element',
  tagName: 'span',
  properties: { className: [cls] },
  children,
})
const t = (value: string): ElementContent => ({ type: 'text', value })
const html = (nodes: ElementContent[]) => toHtml({ type: 'root', children: nodes })

describe('joinOperatorRunsInHast', () => {
  it('puts an operator split over two elements in one', () => {
    const nodes = [t('a '), el('hljs-operator', t('=')), el('hljs-operator', t('=')), t(' b')]
    expect(html(joinOperatorRunsInHast(nodes))).toBe('a <span class="hljs-operator">==</span> b')
  })

  it('moves plain operator characters into the element beside them', () => {
    const nodes = [t('if a '), t('!'), el('hljs-operator', t('=')), t(' b')]
    expect(html(joinOperatorRunsInHast(nodes))).toBe('if a <span class="hljs-operator">!=</span> b')
  })

  it('keeps nesting and the rest of the code as it was', () => {
    const nodes = [
      el('hljs-function', el('hljs-title', t('f')), t('(x) ')),
      el('hljs-operator', t('=')),
      t('> x'),
    ]
    expect(html(joinOperatorRunsInHast(nodes))).toBe(
      '<span class="hljs-function"><span class="hljs-title">f</span>(x) </span>' +
        '<span class="hljs-operator">=></span> x',
    )
  })

  it('returns code with no runs to join unchanged', () => {
    const nodes = [el('hljs-keyword', t('let')), t(' a = '), el('hljs-number', t('1'))]
    expect(joinOperatorRunsInHast(nodes)).toEqual(nodes)
  })
})
