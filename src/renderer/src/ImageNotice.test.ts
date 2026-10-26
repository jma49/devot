import { describe, expect, it } from 'vitest'
import { refusedImagesText } from './ImageNotice'

describe('the notice of images that could not be added', () => {
  it('says why, with the limit or the formats, and the code', () => {
    expect(refusedImagesText(['E_FILE_SIZE_INVALID'])).toBe(
      'An image could not be added. An image can be at most 10 MB, and not empty. (E_FILE_SIZE_INVALID)',
    )
    expect(refusedImagesText(['E_FILE_TYPE_REFUSED', 'E_FILE_TYPE_REFUSED'])).toBe(
      '2 images could not be added. Images can be PNG, JPEG, GIF, WebP, AVIF or HEIC. (E_FILE_TYPE_REFUSED)',
    )
    expect(refusedImagesText(['E_FILE_NAME_INVALID'])).toBe(
      'An image could not be added. An image’s file name cannot be used. (E_FILE_NAME_INVALID)',
    )
    expect(refusedImagesText(['E_STORAGE_FULL'])).toBe(
      'An image could not be added. Storing failed. (E_STORAGE_FULL)',
    )
  })

  it('gives every reason of a mixed batch once, in the order the images came', () => {
    expect(
      refusedImagesText(['E_FILE_SIZE_INVALID', 'E_FILE_TYPE_REFUSED', 'E_FILE_SIZE_INVALID']),
    ).toBe(
      '3 images could not be added. An image can be at most 10 MB, and not empty. (E_FILE_SIZE_INVALID) Images can be PNG, JPEG, GIF, WebP, AVIF or HEIC. (E_FILE_TYPE_REFUSED)',
    )
  })

  it('gives codes that share a reason after it, together', () => {
    expect(refusedImagesText(['E_STORAGE_FULL', 'E_IO'])).toBe(
      '2 images could not be added. Storing failed. (E_STORAGE_FULL, E_IO)',
    )
  })
})
