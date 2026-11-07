import { describe, expect, it } from 'vitest'
import { createBlockSplitter, shareSplitter, splitBlocks } from '../../src/core/preview/blocks'
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

describe('one splitter shared by several readers', () => {
  it('cuts each text once and gives each reader the blocks it kept from its own split before', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const next = seeded(seed)
      let cuts = 0
      const inner = createBlockSplitter(40)
      const shared = shareSplitter((markdown) => {
        cuts += 1
        return inner(markdown)
      })
      const readers = [shared(), shared()]
      const alone = [createBlockSplitter(40), createBlockSplitter(40)]
      let doc = randomLines(next, 60)
      let texts = 0
      const readBefore = [false, false]
      for (let edit = 0; edit < 25; edit += 1) {
        const { from, to, insert } = randomChange(next, doc)
        const edited = doc.slice(0, from) + insert + doc.slice(to)
        if (edited !== doc || edit === 0) texts += 1
        doc = edited
        // A reader that missed a text may know nothing of the blocks it kept.
        const skipped = next() < 0.2 ? Math.floor(next() * 2) : -1
        for (const r of [0, 1]) {
          if (r === skipped) {
            readBefore[r] = false
            continue
          }
          const { blocks, was } = readers[r]!(doc)
          const own = alone[r]!(doc)
          expect(blocks, `seed ${seed}, edit ${edit}, reader ${r}`).toEqual(own.blocks)
          const kept = readBefore[r] || edit === 0 || was.some((j) => j >= 0)
          expect(was, `seed ${seed}, edit ${edit}, reader ${r}`).toEqual(
            kept ? own.was : own.was.map(() => -1),
          )
          readBefore[r] = true
        }
      }
      expect(cuts).toBe(texts)
    }
  })

  it('tells a reader that missed a text that it kept nothing', () => {
    const shared = shareSplitter(createBlockSplitter(1))
    const [behind, ahead] = [shared(), shared()]
    behind('# One\n\nTwo\n')
    ahead('# One\n\nTwo\n')
    ahead('# One\n\nTwo typed\n')
    expect(ahead('# One\n\nTwo typed again\n').was).toEqual([0, -1])
    expect(behind('# One\n\nTwo typed again\n').was).toEqual([-1, -1])
    expect(behind('# One\n\nTwo typed again\n').was).toEqual([0, 1])
  })
})
