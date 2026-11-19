import { expect, it } from 'vitest'
import { storeImageLinks } from '../../clipper/images'

it('caps unique image uploads, visits them sequentially, and leaves failed images and code alone', async () => {
  const seen: string[] = []
  let active = false
  const markdown =
    Array.from({ length: 51 }, (_, i) => `![Photo](https://example.org/${i}.png)`).join('\n\n') +
    '\n\n![Again](https://example.org/0.png)\n\n`![Code](https://example.org/code.png)`\n'
  const result = await storeImageLinks(markdown, async (url) => {
    expect(active).toBe(false)
    active = true
    seen.push(url)
    await Promise.resolve()
    active = false
    if (url.endsWith('/1.png')) throw new Error('E_DOWNLOAD')
    return `devot://file/${seen.length}`
  })
  expect(seen).toHaveLength(50)
  expect(result).toContain('![Photo](devot://file/1)')
  expect(result).toContain('![Again](devot://file/1)')
  expect(result).toContain('![Photo](https://example.org/1.png)')
  expect(result).toContain('![Photo](https://example.org/50.png)')
  expect(result).toContain('`![Code](https://example.org/code.png)`')
})

it('does not upload anything for an empty image list', async () => {
  expect(
    await storeImageLinks('Plain text', async () => {
      throw new Error('Unexpected upload')
    }),
  ).toBe('Plain text')
})

it.each([
  '| Photo |\n| --- |\n| ![East\\|West](https://example.org/photo.png "A title") |',
  "![Nested [label] and \\] escaped](<https://example.org/photo.png> 'A title')",
  '![Photo](\n  https://example.org/photo.png\n  "A \\"quoted\\" title"\n)',
])('replaces only the image destination bytes in %s', async (markdown) => {
  expect(await storeImageLinks(markdown, async () => 'devot://file/local')).toBe(
    markdown.replace('https://example.org/photo.png', 'devot://file/local'),
  )
})
