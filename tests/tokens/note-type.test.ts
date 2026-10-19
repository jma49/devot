import { describe, expect, it } from 'vitest'
import { sizes } from '../../src/renderer/src/theme/tokens'

// Note text is set from one system (design/tokens, `note.*`): headings on one
// modular scale, vertical space in quarter steps of one body line, and font
// lists that reach a CJK face before their generic family.

const num = (path: keyof typeof sizes) => Number(sizes[path])
const families = (path: keyof typeof sizes) =>
  sizes[path].split(',').map((family) => family.trim().replace(/^'|'$/g, ''))

describe('note type', () => {
  it('sizes the headings on the major third, h4 at the body size', () => {
    const exponents = { h1: 3, h2: 2, h3: 1, h4: 0, h5: -0.5, h6: -1 } as const
    for (const [level, n] of Object.entries(exponents)) {
      expect(num(`note.heading.${level}` as keyof typeof sizes)).toBeCloseTo(1.25 ** n, 3)
    }
  })

  it('sets headings tighter than the body', () => {
    expect(num('note.line-height.heading')).toBeLessThan(num('note.line-height.body'))
  })

  it('spaces in quarter steps of one body line, rhythm.N being N quarters', () => {
    const steps = Object.keys(sizes).filter((path) => path.startsWith('note.rhythm.'))
    expect(steps.length).toBeGreaterThan(4)
    for (const path of steps) {
      const n = Number(path.split('.').at(-1))
      expect(num(path as keyof typeof sizes)).toBe(n / 4)
    }
  })

  it('keeps the measure between 35 and 40 CJK characters', () => {
    expect(num('note.measure')).toBeGreaterThanOrEqual(35)
    expect(num('note.measure')).toBeLessThanOrEqual(40)
  })

  it('falls back to the CJK faces before the generic family, in every font list', () => {
    const cjk = families('font.family.cjk')
    for (const [path, generic] of [
      ['font.family.ui', 'sans-serif'],
      ['font.family.mono', 'monospace'],
    ] as const) {
      const list = families(path)
      expect(list.at(-1)).toBe(generic)
      expect(list.slice(-1 - cjk.length, -1)).toEqual(cjk)
    }
  })
})
