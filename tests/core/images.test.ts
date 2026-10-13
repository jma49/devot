import { describe, expect, it } from 'vitest'
import {
  IMAGE_SIZES,
  attachmentId,
  parseImageMarkdown,
  setImageMarkdownSize,
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
    // Only the exact words are sizes; anything else stays part of the URL.
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

  it('sets a size by changing only the destination', () => {
    expect(setImageMarkdownSize(`![Shot](${FILE})`, 'small')).toBe(`![Shot](${FILE}#small)`)
    expect(setImageMarkdownSize(`![Shot](${FILE}#small)`, 'full')).toBe(`![Shot](${FILE}#full)`)
    expect(setImageMarkdownSize(`![Shot](${FILE}#small)`, 'auto')).toBe(`![Shot](${FILE})`)
    expect(setImageMarkdownSize('![a [b]](<x y.png> "T")', 'half')).toBe(
      '![a [b]](<x y.png#half> "T")',
    )
    expect(setImageMarkdownSize("![a]( x.png  'T' )", 'half')).toBe("![a]( x.png#half  'T' )")
  })

  it('leaves an image whose URL has another fragment alone', () => {
    expect(parseImageMarkdown('![x](y.png#page=2)')).toMatchObject({ sizable: false })
    expect(setImageMarkdownSize('![x](y.png#page=2)', 'small')).toBeNull()
    expect(setImageMarkdownSize('![x][ref]', 'small')).toBeNull()
  })

  it('reads a size whose `#` is escaped, and removes the escape together with the size', () => {
    // CommonMark reads `\#small` as `#small`: the image shows small.
    const escaped = `![a](${FILE}\\#small)`
    expect(parseImageMarkdown(escaped)).toMatchObject({ url: FILE, size: 'small', sizable: true })
    expect(parseImageMarkdown(`![a](<${FILE}\\#half>)`)).toMatchObject({ url: FILE, size: 'half' })
    expect(setImageMarkdownSize(escaped, 'auto')).toBe(`![a](${FILE})`)
    expect(setImageMarkdownSize(escaped, 'full')).toBe(`![a](${FILE}#full)`)
    for (const size of IMAGE_SIZES) {
      expect(parseImageMarkdown(setImageMarkdownSize(escaped, size)!)).toMatchObject({
        url: FILE,
        size,
      })
    }
    // An escaped backslash (`\\`) before `#` escapes nothing: it stays in the URL.
    expect(parseImageMarkdown('![a](x\\\\#small)')).toMatchObject({ url: 'x\\\\', size: 'small' })
    expect(parseImageMarkdown('![a](x\\\\\\#small)')).toMatchObject({
      url: 'x\\\\',
      size: 'small',
    })
    // Another escaped fragment still cannot take a size.
    expect(parseImageMarkdown('![a](y.png\\#page)')).toMatchObject({ sizable: false })
  })

  it('round-trips: parsing what was written gives the size back, and writing the parsed size changes nothing', () => {
    const images = [
      `![](${FILE})`,
      `![Shot](${FILE}#small)`,
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
        })
        // Back to the original size gives the original text.
        expect(setImageMarkdownSize(written, parsed!.size)).toBe(image)
      }
    }
  })
})
