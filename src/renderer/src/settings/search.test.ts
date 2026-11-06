import { describe, expect, it } from 'vitest'
import { t } from '../i18n'
import type { PaneId } from './panes'
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

  describe('on an iPhone', () => {
    const panes: readonly PaneId[] = ['general', 'appearance', 'editing', 'preview', 'sync', 'ai']
    const phone = (query: string) => searchSettings(query, t, { onPhone: true, panes })

    it('finds a single setting and names its pane', () => {
      expect(phone('line numbers')).toEqual([
        {
          pane: 'editing',
          label: 'editorSettings.lineNumbers',
          paneLabel: 'settings.pane.editing',
        },
      ])
    })

    it('leaves out settings the iPhone does not show', () => {
      expect(searchSettings('synced scrolling', t)).not.toEqual([])
      expect(phone('synced scrolling')).toEqual([])
      expect(phone('menu bar')).toEqual([])
      expect(phone('word count')).toEqual([])
    })

    it('leaves out panes it does not list, and the settings in them', () => {
      expect(searchSettings('http', t)).not.toEqual([])
      expect(phone('http')).toEqual([])
      expect(phone('plugins')).toEqual([])
      expect(phone('license').some((result) => result.pane === 'licence')).toBe(false)
    })

    it('finds the settings named only on the iPhone, which the Mac never offers', () => {
      expect(phone('transparency')).toContainEqual({
        pane: 'appearance',
        label: 'phone.appearance.transparency',
        paneLabel: 'settings.pane.appearance',
      })
      expect(phone('transparency').map((result) => result.label)).not.toContain(
        'appearanceSettings.glassAmount',
      )
      expect(searchSettings('transparency', t).map((result) => result.label)).not.toContain(
        'phone.appearance.transparency',
      )
    })
  })
})
