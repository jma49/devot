import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { noteMarkdown } from './markdown'
import {
  findImages,
  imageAt,
  imageAtCaret,
  imageLines,
  imageSizeChange,
  inlineImageField,
} from './images'

const ID = '0192a6f0-0000-7000-8000-00000000f001'
const FILE = `devot://file/${ID}`
const OTHER = `devot://file/0192a6f0-0000-7000-8000-00000000f002`

const state = (doc: string, cursor = 0) =>
  EditorState.create({
    doc,
    selection: EditorSelection.cursor(cursor),
    extensions: [noteMarkdown, history(), inlineImageField],
  })

describe('finding images in the editor', () => {
  it('finds inline images with their range, URL, attachment and size', () => {
    const doc = `Text ![a](${FILE}#half) and ![b](https://a.test/b.png)\n`
    const images = findImages(state(doc))
    expect(images).toEqual([
      {
        from: 5,
        to: 5 + `![a](${FILE}#half)`.length,
        text: `![a](${FILE}#half)`,
        alt: 'a',
        url: FILE,
        fileId: ID,
        size: 'half',
        dimensions: null,
        sizable: true,
      },
      expect.objectContaining({ url: 'https://a.test/b.png', fileId: null, size: 'auto' }),
    ])
  })

  it('skips code, inline code and reference images', () => {
    const doc = [
      '```',
      `![a](${FILE})`,
      '```',
      '',
      `\`![b](${FILE})\``,
      '',
      '    ![c](indented-code.png)',
      '',
      '![d][ref]',
      '',
      `[ref]: ${FILE}`,
    ].join('\n')
    expect(findImages(state(doc))).toEqual([])
  })

  it('finds the image at the cursor, or the first on its line', () => {
    const doc = `x ![a](${FILE}) ![b](${OTHER})\nnext line`
    const s = state(doc)
    const second = doc.indexOf('![b]')
    expect(imageAt(s, second + 3)?.alt).toBe('b')
    expect(imageAt(s, 0)?.alt).toBe('a')
    expect(imageAt(s, doc.indexOf('next'))).toBeNull()
  })
})

describe('inline image previews', () => {
  it('puts one block under each line that shows attachments or https images', () => {
    const doc = [
      `![a](${FILE}) ![b](${OTHER}#small)`,
      'plain',
      '![remote](https://a.test/x.png) ![plain](http://a.test/y.png) ![web](HTTPS://a.test/w.png)',
      '![relative](pic.png) ![no scheme](//a.test/z.png)',
      `> quoted ![c](${FILE})`,
    ].join('\n')
    const lines = imageLines(state(doc))
    expect(lines.map((l) => [l.at, l.images.map((i) => i.alt)])).toEqual([
      [doc.indexOf('\nplain'), ['a', 'b']],
      [doc.indexOf('\n![relative]'), ['remote', 'web']],
      [doc.length, ['c']],
    ])
  })

  it('keeps blocks in order when an image spans lines around another', () => {
    // The outer image starts first but ends on a later line than the inner one.
    const doc = `![x\n![b](${OTHER})\ny](${FILE})\nend`
    const s = state(doc)
    const lines = imageLines(s)
    expect(lines.map((l) => l.at)).toEqual([...lines.map((l) => l.at)].sort((a, b) => a - b))
    expect(s.field(inlineImageField).size).toBe(lines.length)
  })

  it('follows edits', () => {
    let s = state('one\n')
    expect(imageLines(s)).toEqual([])
    s = s.update({ changes: { from: 4, insert: `![a](${FILE})` } }).state
    expect(imageLines(s).map((l) => l.at)).toEqual([s.doc.length])
    s = s.update({ changes: { from: 0, to: 4 } }).state
    expect(imageLines(s).map((l) => l.at)).toEqual([s.doc.length])
    s = s.update({ changes: { from: 0, to: s.doc.length } }).state
    expect(imageLines(s)).toEqual([])
  })
})

describe('setting an image size', () => {
  it('writes the size into the alt text, as one undo step', () => {
    const doc = `Look: ![a](${FILE} "T") here`
    let s = state(doc)
    const image = findImages(s)[0]!
    const change = imageSizeChange(s, image, 'small')
    expect(change).not.toBeNull()
    s = s.update(change!).state
    expect(s.doc.toString()).toBe(`Look: ![a w:240](${FILE} "T") here`)
    s = s.update(imageSizeChange(s, findImages(s)[0]!, 'auto')!).state
    expect(s.doc.toString()).toBe(doc)
    s = s.update(imageSizeChange(s, findImages(s)[0]!, 'full')!).state
    let back = s
    undo({ state: back, dispatch: (tr) => (back = tr.state) })
    expect(back.doc.toString()).toBe(doc)
  })

  it('sets auto on an image whose size fragment is escaped, keeping it an image', () => {
    let s = state(`![a](${FILE}\\#small)`)
    const image = findImages(s)[0]!
    expect(image).toMatchObject({ size: 'small', fileId: FILE.slice('devot://file/'.length) })
    s = s.update(imageSizeChange(s, image, 'auto')!).state
    expect(s.doc.toString()).toBe(`![a](${FILE})`)
    expect(findImages(s)).toHaveLength(1)
  })

  it('rewrites an old size fragment to the alt form', () => {
    let s = state(`![a](${FILE}#half)`)
    s = s.update(imageSizeChange(s, findImages(s)[0]!, 'full')!).state
    expect(s.doc.toString()).toBe(`![a w:100%](${FILE})`)
    // An image whose URL has another fragment takes a size too.
    let t = state('![x](y.png#page)')
    t = t.update(imageSizeChange(t, findImages(t)[0]!, 'small')!).state
    expect(t.doc.toString()).toBe('![x w:240](y.png#page)')
  })

  it('does nothing when the image has changed since it was found', () => {
    const s = state(`![a](${FILE})`)
    const image = findImages(s)[0]!
    const edited = s.update({ changes: { from: 2, insert: 'x' } }).state
    expect(imageSizeChange(edited, image, 'small')).toBeNull()
  })
})

describe('the image at the caret', () => {
  it('is the image whose Markdown holds an empty selection', () => {
    const doc = `x ![a](${FILE}) y`
    const at = doc.indexOf('![a]')
    expect(imageAtCaret(state(doc, at))?.alt).toBe('a')
    expect(imageAtCaret(state(doc, at + 5))?.alt).toBe('a')
    expect(imageAtCaret(state(doc, doc.length - 1))).toBeNull()
    const selected = state(doc).update({ selection: EditorSelection.range(at, at + 4) }).state
    expect(imageAtCaret(selected)).toBeNull()
  })
})
