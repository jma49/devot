import { fromHtml } from 'hast-util-from-html'
import { describe, expect, it } from 'vitest'
import { textOf } from './hastText'

describe('textOf', () => {
  it('joins the text of nested elements in order and leaves out comments', () => {
    const tree = fromHtml('<p>a <b>b<i>c</i></b><!-- no --> d</p>', { fragment: true })
    expect(textOf(tree)).toBe('a bc d')
  })

  it('reads a lone text node as its value and an empty element as nothing', () => {
    expect(textOf({ type: 'text', value: 'x' })).toBe('x')
    expect(textOf({ type: 'element', tagName: 'br', properties: {}, children: [] })).toBe('')
  })
})
