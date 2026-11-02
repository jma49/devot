import { describe, expect, it } from 'vitest'
import { DEFAULT_EDITOR_SETTINGS } from '../../src/core/editorSettings'
import { sizes } from '../../src/renderer/src/theme/tokens'

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

  it('holds the Glass scale at the default font size settings', () => {
    expect(num('note.heading.glass.preview-reference')).toBe(
      DEFAULT_EDITOR_SETTINGS.previewFontSize,
    )
    expect(num('note.heading.glass.editor-reference')).toBe(DEFAULT_EDITOR_SETTINGS.fontSize)
  })

  it('states the Glass type scale', () => {
    const scale = {
      'title-size': 28,
      'title-line': 34,
      'title-tracking': -0.4,
      'h1-size': 22,
      'h1-line': 28,
      'h2-size': 19,
      'h2-line': 24,
      'h3-size': 16,
      'h3-line': 22,
      'body-size': 14,
      'body-line': 1.6,
    }
    for (const [name, value] of Object.entries(scale)) {
      expect(num(`note.heading.glass.${name}` as keyof typeof sizes)).toBe(value)
    }
    const space = {
      paragraph: 12,
      'h2-above': 26,
      'h2-below': 8,
      'h3-above': 20,
      'h3-below': 6,
      'title-below': 10,
      'pills-below': 22,
    }
    for (const [name, value] of Object.entries(space)) {
      expect(num(`note.space.${name}` as keyof typeof sizes)).toBe(value)
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
