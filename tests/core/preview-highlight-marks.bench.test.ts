import type { Root } from 'mdast'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, it } from 'vitest'
import { remarkHighlightMarks } from '../../src/core/preview/highlightMarks'
import { expectLinearGrowth, fourfoldGrowth } from '../support/growth'

const parser = unified().use(remarkParse)

/** Parsed once per size; each round marks a copy, as the pass changes the tree. */
function marking(unit: string): (n: number) => () => void {
  const parsed = new Map<number, { note: string; tree: Root }>()
  return (n) => {
    let known = parsed.get(n)
    if (!known) {
      const note = unit.repeat(n)
      known = { note, tree: parser.parse(note) as Root }
      parsed.set(n, known)
    }
    const { note } = known
    const tree = structuredClone(known.tree)
    const transform = remarkHighlightMarks()
    return () => transform(tree, { value: note })
  }
}

describe('highlight marks in a long paragraph', () => {
  it('takes time linear in the number of marks', (context) => {
    const growth = fourfoldGrowth(marking('==mark== word '), 4_000, 5)
    expectLinearGrowth(context, growth)
  })

  it('takes time linear in marks that sit between other inline nodes', (context) => {
    const growth = fourfoldGrowth(marking('==a *b*== c '), 4_000, 5)
    expectLinearGrowth(context, growth)
  })
})
