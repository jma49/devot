import { describe, expect, it } from 'vitest'
import { t } from '../i18n'
import { searchSettings } from './search'

describe('searchSettings', () => {
  it('finds nothing for an empty query', () => {
    expect(searchSettings('', t)).toEqual([])
    expect(searchSettings('   ', t)).toEqual([])
  })

  it('finds a pane by its name, before the settings in it', () => {
    const found = searchSettings('appearance', t)
    expect(found[0]).toEqual({ pane: 'appearance', label: 'settings.pane.appearance' })
  })

  it('finds a setting and names the pane it is in', () => {
    const found = searchSettings('transparency', t)
    expect(found).toContainEqual({
      pane: 'appearance',
      label: 'appearanceSettings.glassAmount',
      paneLabel: 'settings.pane.appearance',
    })
    expect(searchSettings('dark mode', t)).toContainEqual({
      pane: 'appearance',
      label: 'appearanceSettings.darkMode',
      paneLabel: 'settings.pane.appearance',
    })
  })

  it('needs every word, whatever the case', () => {
    expect(searchSettings('ICON style', t)).toContainEqual({
      pane: 'appearance',
      label: 'appearanceSettings.iconStyle',
      paneLabel: 'settings.pane.appearance',
    })
    expect(searchSettings('icon backup', t)).toEqual([])
  })

  it('finds the license pane by its new spelling', () => {
    expect(searchSettings('license', t).some((result) => result.pane === 'licence')).toBe(true)
  })
})
