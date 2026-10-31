import { afterEach, describe, expect, it, vi } from 'vitest'
import { THEMES } from '../../../core/editorSettings'
import {
  applyAppearance,
  applyAppearanceSettings,
  applyTheme,
  shownAppearance,
  type AppearanceTarget,
} from './appearance'

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

describe('the theme for the appearance shown', () => {
  afterEach(() => vi.unstubAllGlobals())
  const systemIs = (appearance: 'light' | 'dark') =>
    vi.stubGlobal('matchMedia', () => ({ matches: appearance === 'dark' }))
  const themes = { lightTheme: 'ivory', darkTheme: 'tide' } as const

  it('takes the light theme in the light appearance and the dark one in the dark', () => {
    systemIs('dark')
    const target = root()
    applyAppearanceSettings({ appearance: 'light', ...themes }, target)
    expect(target.dataset).toEqual({ appearance: 'light', theme: 'ivory' })
    applyAppearanceSettings({ appearance: 'dark', ...themes }, target)
    expect(target.dataset).toEqual({ appearance: 'dark', theme: 'tide' })
  })

  it('follows the system appearance while the window does', () => {
    const target = root()
    systemIs('light')
    applyAppearanceSettings({ appearance: 'system', ...themes }, target)
    expect(target.dataset).toEqual({ theme: 'ivory' })
    systemIs('dark')
    applyAppearanceSettings({ appearance: 'system', ...themes }, target)
    expect(target.dataset).toEqual({ theme: 'tide' })
  })

  it('leaves the root unmarked when the appearance shown has the default theme', () => {
    systemIs('dark')
    const target = root()
    applyAppearanceSettings(
      { appearance: 'system', lightTheme: 'ivory', darkTheme: 'default' },
      target,
    )
    expect(target.dataset).toEqual({})
  })
})
