import { describe, expect, it } from 'vitest'
import { refusedImagesText } from './ImageNotice'

describe('the notice of images that could not be added', () => {
  it('says why, with the limit or the formats, never the code', () => {
    expect(refusedImagesText(['E_FILE_SIZE_INVALID'])).toBe(
      'An image could not be added. An image can be at most 10 MB, and not empty.',
    )
    expect(refusedImagesText(['E_FILE_TYPE_REFUSED', 'E_FILE_TYPE_REFUSED'])).toBe(
      '2 images could not be added. Images can be PNG, JPEG, GIF, WebP, AVIF or HEIC.',
    )
    expect(refusedImagesText(['E_FILE_NAME_INVALID'])).toBe(
      'An image could not be added. An image’s file name cannot be used.',
    )
    expect(refusedImagesText(['E_STORAGE_FULL'])).toBe(
      'An image could not be added. Storing failed.',
    )
  })

  it('gives every reason of a mixed batch once, in the order the images came', () => {
    expect(
      refusedImagesText(['E_FILE_SIZE_INVALID', 'E_FILE_TYPE_REFUSED', 'E_FILE_SIZE_INVALID']),
    ).toBe(
      '3 images could not be added. An image can be at most 10 MB, and not empty. Images can be PNG, JPEG, GIF, WebP, AVIF or HEIC.',
    )
  })

  it('says a reason that several codes share once', () => {
    expect(refusedImagesText(['E_STORAGE_FULL', 'E_IO'])).toBe(
      '2 images could not be added. Storing failed.',
    )
  })
})
