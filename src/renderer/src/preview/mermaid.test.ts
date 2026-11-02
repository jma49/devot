import { describe, expect, it } from 'vitest'
import { sizes } from '../theme/tokens'
import { diagramFont } from './mermaid'

describe('the font of a diagram', () => {
  it("is the UI font at the diagram's size, not the hidden window's default", () => {
    expect(diagramFont()).toEqual({
      fontFamily: sizes['font.family.ui'],
      fontSize: sizes['font.size.footnote'],
    })
    expect(diagramFont().fontFamily).not.toBe('')
  })
})
