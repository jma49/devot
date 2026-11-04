import type { Paragraph, PhrasingContent, Root } from 'mdast'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { describe, expect, it } from 'vitest'
import { expectLinearGrowth, fourfoldGrowth } from '../support/growth'

// Finding bare links looked each paragraph up among the rest, and each text among its siblings,
// which took time growing with the square of their number (#290): about 11 times as long for four
// times the paragraphs here.
describe('linking bare URLs in parsed Markdown', () => {
  const transforms = gfmFromMarkdown().flatMap((extension) => extension.transforms ?? [])
  const link = { type: 'link', url: 'http://www.example.com' }

  it('takes time linear in the paragraphs', { timeout: 60_000 }, (context) => {
    const growth = fourfoldGrowth(
      (n) => {
        const tree: Root = {
          type: 'root',
          children: Array.from({ length: n }, () => ({
            type: 'paragraph',
            children: [{ type: 'text', value: 'see www.example.com now' }],
          })),
        }
        return () => {
          for (const transform of transforms) transform(tree)
          expect(tree.children[n - 1]).toMatchObject({
            children: [{ value: 'see ' }, link, {}],
          })
        }
      },
      10_000,
      5,
    )
    expectLinearGrowth(context, growth)
  })

  it('takes time linear in the texts between images', { timeout: 60_000 }, (context) => {
    const growth = fourfoldGrowth(
      (n) => {
        const paragraph: Paragraph = {
          type: 'paragraph',
          children: [
            ...Array.from({ length: n }).flatMap((): PhrasingContent[] => [
              { type: 'image', url: 'a.png' },
              { type: 'text', value: ' and ' },
            ]),
            { type: 'text', value: ' www.example.com ' },
          ],
        }
        const tree: Root = { type: 'root', children: [paragraph] }
        return () => {
          for (const transform of transforms) transform(tree)
          expect(paragraph.children.slice(-3)).toMatchObject([{ value: ' ' }, link, { value: ' ' }])
        }
      },
      5_000,
      5,
    )
    expectLinearGrowth(context, growth)
  })
})
