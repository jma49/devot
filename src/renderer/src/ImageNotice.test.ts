import { describe, expect, it } from 'vitest'
import { refusedImagesText } from './ImageNotice'

describe('the notice of images that could not be added', () => {
  it('says why, with the limit or the formats, and the code', () => {
    expect(refusedImagesText(['E_FILE_SIZE_INVALID'])).toBe(
      'An image could not be added. An image can be at most 10 MB, and not empty. (E_FILE_SIZE_INVALID)',
    )
    expect(refusedImagesText(['E_FILE_TYPE_REFUSED', 'E_FILE_SIZE_INVALID'])).toBe(
      '2 images could not be added. Images can be PNG, JPEG, GIF, WebP, AVIF or HEIC. (E_FILE_TYPE_REFUSED)',
    )
    expect(refusedImagesText(['E_FILE_NAME_INVALID'])).toBe(
      'An image could not be added. Its file name cannot be used. (E_FILE_NAME_INVALID)',
    )
    expect(refusedImagesText(['E_STORAGE_FULL'])).toBe(
      'An image could not be added. It could not be stored. (E_STORAGE_FULL)',
    )
  })
})
