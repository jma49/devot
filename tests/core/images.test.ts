import { describe, expect, it } from 'vitest'
import {
  IMAGE_SIZES,
  attachmentId,
  parseImageMarkdown,
  setImageMarkdownSize,
  sizeAttribute,
  splitAltSize,
  splitImageSize,
  withImageSize,
  type ImageSize,
} from '../../src/core/images'

const FILE = 'devot://file/0192a6f0-0000-7000-8000-00000000f001'

describe('image size presets in URLs', () => {
  it('reads a size from the fragment and leaves other URLs at auto', () => {
    expect(splitImageSize(`${FILE}#small`)).toEqual({ url: FILE, size: 'small' })
    expect(splitImageSize(`${FILE}#half`)).toEqual({ url: FILE, size: 'half' })
    expect(splitImageSize(`${FILE}#full`)).toEqual({ url: FILE, size: 'full' })
    expect(splitImageSize(FILE)).toEqual({ url: FILE, size: 'auto' })
    expect(splitImageSize(`${FILE}#Small`)).toEqual({ url: `${FILE}#Small`, size: 'auto' })
    expect(splitImageSize('https://a.test/x.png#auto')).toEqual({
      url: 'https://a.test/x.png#auto',
      size: 'auto',
    })
    expect(splitImageSize('https://a.test/x.png#smaller')).toEqual({
      url: 'https://a.test/x.png#smaller',
      size: 'auto',
    })
  })

  it('writes a size as a fragment; auto writes none', () => {
    expect(withImageSize(FILE, 'small')).toBe(`${FILE}#small`)
    expect(withImageSize(FILE, 'auto')).toBe(FILE)
    expect(withImageSize('https://a.test/x.png?w=1', 'full')).toBe('https://a.test/x.png?w=1#full')
  })

  it('round-trips every size', () => {
    for (const size of IMAGE_SIZES) {
      expect(splitImageSize(withImageSize(FILE, size))).toEqual({ url: FILE, size })
    }
  })

  it('names the attachment an image shows, with or without a size', () => {
    const id = FILE.slice('devot://file/'.length)
    expect(attachmentId(FILE)).toBe(id)
    expect(attachmentId(`${FILE}#half`)).toBe(id)
    expect(attachmentId('devot://file/../x')).toBeNull()
    expect(attachmentId('https://a.test/x.png')).toBeNull()
    expect(attachmentId(`${FILE}x`)).toBeNull()
  })
})

describe('image Markdown', () => {
  it('parses an inline image: its alt text, URL, size and title', () => {
    expect(parseImageMarkdown(`![Shot](${FILE})`)).toMatchObject({
      alt: 'Shot',
      url: FILE,
      size: 'auto',
    })
    expect(parseImageMarkdown(`![a [b] c](${FILE}#half "Title (x)")`)).toMatchObject({
      alt: 'a [b] c',
      url: FILE,
      size: 'half',
    })
    expect(parseImageMarkdown('![x](<my image.png#full>)')).toMatchObject({
      url: 'my image.png',
      size: 'full',
    })
    expect(parseImageMarkdown('![x](a(b).png)')).toMatchObject({ url: 'a(b).png' })
    expect(parseImageMarkdown('![x\\]](y.png)')).toMatchObject({ alt: 'x\\]', url: 'y.png' })
  })

  it('refuses what is not exactly one inline image', () => {
    for (const text of [
      '![x][ref]',
      '[x](y.png)',
      '![x](y.png) and more',
      '![x]()',
      '![x](y.png',
      '![x](y.png "t" z)',
      'text',
    ]) {
      expect(parseImageMarkdown(text)).toBeNull()
    }
  })

  it('writes a size into the alt text and removes an old size fragment', () => {
    expect(setImageMarkdownSize(`![Shot](${FILE})`, 'small')).toBe(`![Shot w:240](${FILE})`)
    expect(setImageMarkdownSize(`![Shot](${FILE})`, 'half')).toBe(`![Shot w:50%](${FILE})`)
    expect(setImageMarkdownSize(`![Shot w:240](${FILE})`, 'full')).toBe(`![Shot w:100%](${FILE})`)
    expect(setImageMarkdownSize(`![Shot w:240](${FILE})`, 'auto')).toBe(`![Shot](${FILE})`)
    expect(setImageMarkdownSize(`![Shot](${FILE}#small)`, 'full')).toBe(`![Shot w:100%](${FILE})`)
    expect(setImageMarkdownSize(`![Shot](${FILE}#small)`, 'auto')).toBe(`![Shot](${FILE})`)
    expect(setImageMarkdownSize(`![](${FILE})`, 'half')).toBe(`![w:50%](${FILE})`)
    expect(setImageMarkdownSize('![a [b]](<x y.png#half> "T")', 'small')).toBe(
      '![a [b] w:240](<x y.png> "T")',
    )
    expect(setImageMarkdownSize('![a w:320 h:240](x.png)', 'half')).toBe('![a w:50%](x.png)')
    expect(setImageMarkdownSize('![a width:200px](x.png)', 'auto')).toBe('![a](x.png)')
    expect(setImageMarkdownSize(`![Shot](${FILE}#small)`, 'small')).toBe(`![Shot](${FILE}#small)`)
    expect(setImageMarkdownSize('![x][ref]', 'small')).toBeNull()
  })

  it('sizes an image whose URL has another fragment, keeping the fragment', () => {
    expect(parseImageMarkdown('![x](y.png#page=2)')).toMatchObject({
      url: 'y.png#page=2',
      size: 'auto',
      sizable: true,
    })
    expect(setImageMarkdownSize('![x](y.png#page=2)', 'small')).toBe('![x w:240](y.png#page=2)')
  })

  it('reads a size whose `#` is escaped, and removes the escape together with the size', () => {
    // CommonMark reads `\#small` as `#small`: the image shows small.
    const escaped = `![a](${FILE}\\#small)`
    expect(parseImageMarkdown(escaped)).toMatchObject({ url: FILE, size: 'small' })
    expect(parseImageMarkdown(`![a](<${FILE}\\#half>)`)).toMatchObject({ url: FILE, size: 'half' })
    expect(setImageMarkdownSize(escaped, 'auto')).toBe(`![a](${FILE})`)
    expect(setImageMarkdownSize(escaped, 'full')).toBe(`![a w:100%](${FILE})`)
    // An escaped backslash (`\\`) before `#` escapes nothing: it stays in the URL.
    expect(parseImageMarkdown('![a](x\\\\#small)')).toMatchObject({ url: 'x\\\\', size: 'small' })
  })

  it('round-trips: parsing what was written gives the size and name back', () => {
    const images = [
      `![](${FILE})`,
      `![Shot](${FILE}#small)`,
      `![Shot w:50%](${FILE})`,
      '![a [b] c](https://a.test/x.png?q=1 "T")',
      '![x](<my image.png#full>)',
      "![x](a(b).png 'T')",
      '![x\\]](y.png#half)',
    ]
    for (const image of images) {
      const parsed = parseImageMarkdown(image)
      expect(parsed).not.toBeNull()
      expect(setImageMarkdownSize(image, parsed!.size)).toBe(image)
      for (const size of IMAGE_SIZES as readonly ImageSize[]) {
        const written = setImageMarkdownSize(image, size)!
        expect(parseImageMarkdown(written)).toMatchObject({
          alt: parsed!.alt,
          url: parsed!.url,
          size,
          dimensions: null,
        })
        expect(setImageMarkdownSize(written, size)).toBe(written)
      }
    }
  })
})

describe('sizes in the alt text', () => {
  it('reads the presets', () => {
    expect(parseImageMarkdown(`![clip w:240](${FILE})`)).toMatchObject({
      alt: 'clip',
      url: FILE,
      size: 'small',
      dimensions: null,
    })
    expect(parseImageMarkdown(`![clip w:50%](${FILE})`)).toMatchObject({ size: 'half' })
    expect(parseImageMarkdown(`![clip w:100%](${FILE})`)).toMatchObject({ size: 'full' })
    expect(parseImageMarkdown(`![clip width:100%](${FILE})`)).toMatchObject({ size: 'full' })
    expect(parseImageMarkdown(`![clip w:240](${FILE}#full)`)).toMatchObject({ size: 'small' })
  })

  it('reads Small as 240 px wide, whichever way it is written', () => {
    expect(parseImageMarkdown(`![clip w:240px](${FILE})`)).toMatchObject({ size: 'small' })
    expect(parseImageMarkdown(`![clip width:240](${FILE})`)).toMatchObject({ size: 'small' })
    expect(parseImageMarkdown(`![clip w:30%](${FILE})`)).toMatchObject({
      size: 'auto',
      dimensions: { width: '30%' },
    })
  })

  it('reads width and height in every form', () => {
    expect(splitAltSize('a width:200px')).toEqual({ name: 'a', dimensions: { width: '200px' } })
    expect(splitAltSize('a height:120px')).toEqual({ name: 'a', dimensions: { height: '120px' } })
    expect(splitAltSize('a w:320 h:240')).toEqual({
      name: 'a',
      dimensions: { width: '320px', height: '240px' },
    })
    expect(splitAltSize('w:12.5%')).toEqual({ name: '', dimensions: { width: '12.5%' } })
    for (const unit of ['%', 'px', 'pt', 'pc', 'in', 'cm', 'mm', 'em', 'ex', 'ch']) {
      expect(splitAltSize(`x w:3${unit}`)).toEqual({ name: 'x', dimensions: { width: `3${unit}` } })
    }
    expect(splitAltSize('x W:10PX w:20px')).toEqual({ name: 'x', dimensions: { width: '20px' } })
    expect(parseImageMarkdown(`![a w:320 h:240](${FILE})`)).toMatchObject({
      alt: 'a',
      size: 'auto',
      dimensions: { width: '320px', height: '240px' },
    })
  })

  it('leaves words that are no size in the name', () => {
    expect(splitAltSize('photo 2024')).toEqual({ name: 'photo 2024', dimensions: null })
    expect(splitAltSize('w:30% of the page')).toEqual({
      name: 'w:30% of the page',
      dimensions: null,
    })
    expect(splitAltSize('a w:30kg')).toEqual({ name: 'a w:30kg', dimensions: null })
    expect(splitAltSize('a w:')).toEqual({ name: 'a w:', dimensions: null })
  })

  it('turns a size into an HTML size attribute', () => {
    expect(sizeAttribute('30%')).toBe('30%')
    expect(sizeAttribute('200px')).toBe('200')
    expect(sizeAttribute('1in')).toBe('96')
    expect(sizeAttribute('12pt')).toBe('16')
    expect(sizeAttribute('2em')).toBe('32')
  })
})
