import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_SETTINGS,
  FONT_FAMILIES,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  APPEARANCES,
  INDENT_UNITS,
  LINE_HEIGHTS,
  LIST_MARKERS,
  PASTE_URL_STYLES,
  TAB_WIDTHS,
  checkEditorSettingsPatch,
  indentText,
  parseEditorSettings,
  stepFontSize,
} from '../../src/core/editorSettings'

describe('editor settings', () => {
  it('defaults to the editor as it was', () => {
    expect(DEFAULT_EDITOR_SETTINGS).toEqual({
      lineNumbers: false,
      lineWrapping: true,
      readableWidth: false,
      fontSize: 13,
      fontFamily: 'mono',
      lineHeight: 1.4,
      indentUnit: 'spaces2',
      tabWidth: 4,
      listMarker: '-',
      spellCheck: false,
      highlightActiveLine: true,
      sidebarMaterial: true,
      pasteUrl: 'plain',
      // Split mode scrolls the editor and the preview together unless turned off.
      syncScroll: true,
      inlineImages: true,
      // The system's appearance, with Devot's own accent.
      appearance: 'system',
      systemAccent: false,
    })
  })

  it('offers choices that the Rust side accepts', () => {
    // The same lists and ranges as src-tauri/src/editor_settings.rs.
    expect(FONT_FAMILIES).toEqual(['system', 'mono', 'menlo', 'monaco', 'courierNew'])
    expect(INDENT_UNITS).toEqual(['spaces2', 'spaces4', 'tab'])
    expect(LIST_MARKERS).toEqual(['-', '*'])
    expect(PASTE_URL_STYLES).toEqual(['plain', 'autolink', 'link'])
    expect(APPEARANCES).toEqual(['light', 'dark', 'system'])
    expect([FONT_SIZE_MIN, FONT_SIZE_MAX]).toEqual([10, 32])
    for (const h of LINE_HEIGHTS) expect(h >= 1 && h <= 2.5).toBe(true)
    expect(LINE_HEIGHTS).toContain(DEFAULT_EDITOR_SETTINGS.lineHeight)
    for (const w of TAB_WIDTHS) expect(w >= 1 && w <= 8).toBe(true)
    expect(TAB_WIDTHS).toContain(DEFAULT_EDITOR_SETTINGS.tabWidth)
  })

  it('reads settings value by value, with defaults for anything invalid', () => {
    expect(parseEditorSettings(undefined)).toEqual(DEFAULT_EDITOR_SETTINGS)
    expect(parseEditorSettings('nope')).toEqual(DEFAULT_EDITOR_SETTINGS)
    const read = parseEditorSettings({
      lineNumbers: false,
      fontSize: 99,
      fontFamily: 'menlo',
      lineHeight: 1.8,
      listMarker: '+',
      tabWidth: 2,
      spellCheck: 'yes',
      sidebarMaterial: false,
      syncScroll: false,
      future: 1,
    })
    expect(read).toEqual({
      ...DEFAULT_EDITOR_SETTINGS,
      lineNumbers: false,
      fontFamily: 'menlo',
      lineHeight: 1.8,
      tabWidth: 2,
      sidebarMaterial: false,
      syncScroll: false,
    })
    expect(read).not.toHaveProperty('future')
    expect(parseEditorSettings({ syncScroll: 0 }).syncScroll).toBe(true)
    expect(parseEditorSettings({ sidebarMaterial: 'off' }).sidebarMaterial).toBe(true)
  })

  it('accepts a change of valid values only', () => {
    expect(checkEditorSettingsPatch({ fontSize: 16, listMarker: '*' })).toEqual({
      fontSize: 16,
      listMarker: '*',
    })
    expect(checkEditorSettingsPatch({ sidebarMaterial: false })).toEqual({ sidebarMaterial: false })
    expect(checkEditorSettingsPatch({ inlineImages: false })).toEqual({ inlineImages: false })
    for (const pasteUrl of PASTE_URL_STYLES)
      expect(checkEditorSettingsPatch({ pasteUrl })).toEqual({ pasteUrl })
    expect(checkEditorSettingsPatch({ syncScroll: false })).toEqual({ syncScroll: false })
    for (const bad of [
      { fontSize: 9 },
      { fontSize: 33 },
      { fontSize: 13.5 },
      { fontFamily: 'Papyrus' },
      { lineHeight: 3 },
      { indentUnit: 'spaces3' },
      { tabWidth: 0 },
      { listMarker: '+' },
      { pasteUrl: 'markdown' },
      { pasteUrl: true },
      { lineNumbers: 'false' },
      { theme: 'dark' },
      { sidebarMaterial: 'off' },
      { sidebarMaterial: null },
      { syncScroll: 'on' },
      { syncScroll: 1 },
      { inlineImages: 'on' },
      { inlineImages: 1 },
      { appearance: 'auto' },
      { appearance: true },
      { systemAccent: 'on' },
    ]) {
      expect(() => checkEditorSettingsPatch(bad)).toThrow('E_EDITOR_SETTINGS_INVALID')
    }
  })

  it('reads the appearance as light, dark or system, and anything else as system', () => {
    for (const appearance of ['light', 'dark', 'system'] as const) {
      expect(parseEditorSettings({ appearance }).appearance).toBe(appearance)
      expect(checkEditorSettingsPatch({ appearance })).toEqual({ appearance })
    }
    for (const appearance of ['Dark', 'auto', '', 1, null])
      expect(parseEditorSettings({ appearance }).appearance).toBe('system')
    expect(parseEditorSettings({ systemAccent: true }).systemAccent).toBe(true)
  })

  it('steps the font size within its range', () => {
    expect(stepFontSize(13, 1)).toBe(14)
    expect(stepFontSize(13, -1)).toBe(12)
    expect(stepFontSize(FONT_SIZE_MAX, 1)).toBe(FONT_SIZE_MAX)
    expect(stepFontSize(FONT_SIZE_MIN, -1)).toBe(FONT_SIZE_MIN)
  })

  it('turns the indent unit into the text one level inserts', () => {
    expect(indentText('spaces2')).toBe('  ')
    expect(indentText('spaces4')).toBe('    ')
    expect(indentText('tab')).toBe('\t')
  })
})
