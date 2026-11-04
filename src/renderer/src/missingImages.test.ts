import { describe, expect, it } from 'vitest'
import { missingImageLabel } from './missingImages'

const FILE = 'devot://file/0192f0a2-7c1e-7d3a-9b2c-3d4e5f607182'

describe('the label of an image that did not load', () => {
  it('says an attachment has not synced yet, wherever it shows', () => {
    expect(missingImageLabel(FILE, 'Shot', false)).toBe('Shot: image not synced yet')
    expect(missingImageLabel(FILE, '', true)).toBe('Image not synced yet')
  })

  it('says any other image could not be loaded where every image gets a placeholder', () => {
    expect(missingImageLabel('https://example.com/a.png', 'Chart', true)).toBe(
      'Chart: image could not be loaded',
    )
    expect(missingImageLabel('https://example.com/a.png', '', true)).toBe(
      'Image could not be loaded',
    )
  })

  it('leaves any other image to its own handling elsewhere', () => {
    expect(missingImageLabel('https://example.com/a.png', 'Chart', false)).toBeNull()
  })
})
