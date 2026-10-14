import { describe, expect, it } from 'vitest'
import { THEMES } from '../../../core/editorSettings'
import { applyAppearance, applyTheme, shownAppearance, type AppearanceTarget } from './appearance'

const root = (): AppearanceTarget => ({ dataset: {} })

describe('the theme on the root element', () => {
  it('marks the root with a chosen theme, as data-theme', () => {
    const target = root()
    applyTheme('ivory', target)
    expect(target.dataset['theme']).toBe('ivory')
  })

  it('leaves the root unmarked for the default theme, and unmarks it again', () => {
    const target = root()
    applyTheme('default', target)
    expect(target.dataset).toEqual({})
    applyTheme('ivory', target)
    applyTheme('default', target)
    expect(target.dataset).toEqual({})
  })

  it('marks the theme apart from the appearance, each independent of the other', () => {
    const target = root()
    applyAppearance('dark', target)
    applyTheme('ivory', target)
    expect(target.dataset).toEqual({ appearance: 'dark', theme: 'ivory' })
    applyAppearance('system', target)
    expect(target.dataset).toEqual({ theme: 'ivory' })
    expect(shownAppearance({ dataset: { appearance: 'light', theme: 'ivory' } })).toBe('light')
  })

  it('takes every theme the setting offers', () => {
    for (const theme of THEMES) {
      const target = root()
      applyTheme(theme, target)
      expect(target.dataset['theme']).toBe(theme === 'default' ? undefined : theme)
    }
  })
})
