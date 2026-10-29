import { describe, expect, it } from 'vitest'
import { sizes } from '../theme/tokens'
import { exportFont } from './mermaid'

describe('the font of an exported diagram', () => {
  it("is the one the exported page sets, not the hidden window's default", () => {
    expect(exportFont()).toEqual({
      fontFamily: sizes['font.family.ui'],
      fontSize: sizes['font.size.preview'],
    })
    expect(exportFont().fontFamily).not.toBe('')
  })
})
