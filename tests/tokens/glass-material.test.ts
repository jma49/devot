import { describe, expect, it } from 'vitest'
import { dark, ivoryDark, ivoryLight, light, sizes } from '../../src/renderer/src/theme/tokens'

// One glass material for everything that floats over the sheet (design/README.md, Glass interface).

const themes = {
  'system light': light as Record<string, string>,
  'system dark': dark as Record<string, string>,
  'ivory light': ivoryLight as Record<string, string>,
  'ivory dark': ivoryDark as Record<string, string>,
}

describe('the glass material', () => {
  it.each([
    ['system light', 'rgb(255 255 255 / 0.8)', 'rgb(255 255 255 / 0.16)'],
    ['system dark', 'rgb(30 30 33 / 0.8)', 'rgb(255 255 255 / 0.03)'],
    ['ivory light', 'rgb(255 254 251 / 0.8)', 'rgb(255 255 255 / 0.16)'],
    ['ivory dark', 'rgb(49 49 47 / 0.8)', 'rgb(255 255 255 / 0.03)'],
  ] as const)('is one tint and one top sheen in %s', (name, glass, sheen) => {
    expect(themes[name]['color.surface.glass']).toBe(glass)
    expect(themes[name]['color.surface.glass-sheen']).toBe(sheen)
  })

  it('fades its sheen out over 44 px from the top', () => {
    expect(sizes['size.glass-sheen']).toBe('44px')
  })

  it.each(Object.keys(themes))('leaves no second glass fill in %s', (name) => {
    for (const removed of [
      'color.fill.glass-control',
      'color.surface.glass-popover',
      'color.surface.glass-float-bar',
      'color.line.float-bar',
      'color.fill.completion-selected',
    ])
      expect(themes[name as keyof typeof themes]).not.toHaveProperty([removed])
  })
})
