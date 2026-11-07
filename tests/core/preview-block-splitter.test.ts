import { describe, expect, it } from 'vitest'
import { createBlockSplitter, splitBlocks } from '../../src/core/preview/blocks'
import { randomChange, randomLines, seeded } from '../support/random-notes'

const HTML = ['<div>', '</div>', '<!-- open', 'close -->', '<details>', '</details>', '  - nested']

describe('splitting a note again after an edit', () => {
  it('cuts the note as splitting it whole does, over random edits', () => {
    for (const minLength of [1, 40]) {
      for (let seed = 1; seed <= 150; seed += 1) {
        const next = seeded(seed)
        const split = createBlockSplitter(minLength)
        let doc = `${randomLines(next, 40)}\n${HTML.join('\n\n')}\n${randomLines(next, 40)}`
        for (let edit = 0; edit < 25; edit += 1) {
          const { from, to, insert } = randomChange(next, doc)
          const added = next() < 0.2 ? HTML[Math.floor(next() * HTML.length)]! : insert
          doc = doc.slice(0, from) + added + doc.slice(to)
          const { blocks, was } = split(doc)
          expect(blocks, `seed ${seed}, edit ${edit}`).toEqual(splitBlocks(doc, minLength))
          expect(blocks.map((block) => block.offset + block.text.length).at(-1)).toBe(doc.length)
          expect(was).toHaveLength(blocks.length)
        }
      }
    }
  })

  it('names the blocks it kept from the split before', () => {
    const split = createBlockSplitter(1)
    const before = split('# One\n\nTwo\n\nThree\n\nFour\n').blocks
    const { blocks, was } = split('# One\n\nTwo typed\n\nThree\n\nFour\n')
    expect(blocks.map((block) => block.text)).toEqual([
      '# One\n\n',
      'Two typed\n\n',
      'Three\n\n',
      'Four\n',
    ])
    expect(was).toEqual([0, -1, 2, 3])
    expect(before[2]!.text).toBe(blocks[2]!.text)
    expect(split('# One\n\nTwo typed\n\nThree\n\nFour\n').was).toEqual([0, 1, 2, 3])
  })
})
