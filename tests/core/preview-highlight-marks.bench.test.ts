import type { Root } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, it } from 'vitest'
import { remarkHighlightMarks } from '../../src/core/preview/highlightMarks'
import { expectLinearGrowth, fourfoldGrowth } from '../support/growth'

const parser = unified().use(remarkParse)

function marking(note: string): () => void {
  const tree = parser.parse(note) as Root
  const transform = remarkHighlightMarks()
  return () => transform(tree, { value: note })
}

describe('highlight marks in a long paragraph', () => {
  it('takes time linear in the number of marks', (context) => {
    const growth = fourfoldGrowth((n) => marking('==mark== word '.repeat(n)), 4_000, 5)
    expectLinearGrowth(context, growth)
  })

  it('takes time linear in marks that sit between other inline nodes', (context) => {
    const growth = fourfoldGrowth((n) => marking('==a *b*== c '.repeat(n)), 4_000, 5)
    expectLinearGrowth(context, growth)
  })
})
