import { fromHtml } from 'hast-util-from-html'
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown } from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { expectLinearGrowth, fourfoldGrowth } from '../support/growth'

describe('HTML to Markdown for import', () => {
  // Parsing a 10 MiB page alone takes seconds on a CI runner; the limits are on what follows it,
  // which was minutes before.
  describe('on a 10 MiB page', { timeout: 60_000 }, () => {
    const MIB = 1024 * 1024
    // Parsing is the floor: a page of half a million elements takes about a
    // second to parse alone, so what is timed is the work past it.
    const timed = (page: string) => {
      let start = performance.now()
      fromHtml(page)
      const parse = performance.now() - start
      start = performance.now()
      const out = htmlToMarkdown(page)
      return { out, ms: performance.now() - start - parse }
    }

    it('picks its marker in linear time, however much of it the page spells', (context) => {
      const { out, ms } = timed(`<p>devotimport${'x'.repeat(10 * MIB)}</p>`)
      expect(out.markdown.length).toBeGreaterThan(10 * MIB)
      expectWithinBudget(context, ms, 2000)
    })

    it('leaves out images it cannot keep, listing the first 100 and a count of the rest', (context) => {
      const parts: string[] = []
      let size = 0
      for (let n = 0; size < 10 * MIB; n++) {
        const tag = `<img src="x:${n}">`
        parts.push(tag)
        size += tag.length
      }
      const { out, ms } = timed(parts.join(''))
      expect(out.markdown).toBe('')
      expect(out.dropped).toHaveLength(101)
      expect(out.dropped.slice(0, 2)).toEqual(['x:0', 'x:1'])
      expect(out.dropped.at(-1)).toBe(`+${parts.length - 100}`)
      expectWithinBudget(context, ms, 2000)
    })
  })

  // Steps that looked each element up among its siblings, took whitespace out from between them one
  // at a time, or read the rest of the page for each line's end, took time growing with the square
  // of a parent's children or of a page's lines (#290). Rules and text are cheap, so that square
  // would show at these sizes (9 to 12 times as long for four times as many).
  describe('in time linear in the children of a parent', { timeout: 180_000 }, () => {
    it.for([
      ['side by side', (n: number) => '<hr>'.repeat(n)],
      ['on lines of their own', (n: number) => '<hr>\n'.repeat(n)],
    ] as const)('%s', ([, page], context) => {
      const growth = fourfoldGrowth(
        (n) => {
          const html = page(n)
          return () => htmlToMarkdown(html)
        },
        25_000,
        5,
      )
      expectLinearGrowth(context, growth)
    })

    it('reads a page in time linear in its lines', (context) => {
      const growth = fourfoldGrowth(
        (n) => {
          const html = `<p>${'x'.repeat(20)}</p>\n`.repeat(n)
          return () => fromHtml(html)
        },
        20_000,
        9,
      )
      expectLinearGrowth(context, growth)
    })
  })
})
