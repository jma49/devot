import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_SETTINGS,
  FONT_FAMILIES,
  FONT_WEIGHTS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  APPEARANCES,
  THEMES,
  INDENT_UNITS,
  LINE_HEIGHTS,
  LINE_WRAPPING_MODES,
  LIST_MARKERS,
  PASTE_URL_STYLES,
  TAB_WIDTHS,
  checkEditorSettingsPatch,
  indentText,
  parseEditorSettings,
  stepFontSize,
  themeFollowsSystemAccent,
} from '../../src/core/editorSettings'

describe('editor settings', () => {
  it('has roomy defaults, the new ones for settings the user never set', () => {
    expect(DEFAULT_EDITOR_SETTINGS).toEqual({
      lineNumbers: false,
      // Everything wraps except the code block or table under the caret.
      lineWrapping: 'unwrapAtCursor',
      readableWidth: false,
      fontSize: 13,
      fontFamily: 'mono',
      installedFont: null,
      importedFont: null,
      lineHeight: 1.5,
      indentUnit: 'spaces2',
      tabWidth: 2,
      listMarker: '*',
      spellCheck: true,
      highlightActiveLine: false,
      sidebarMaterial: true,
      pasteUrl: 'link',
      // Split mode scrolls the editor and the preview together unless turned off.
      syncScroll: true,
      inlineImages: true,
      // The system's appearance, with Devot's own accent.
      appearance: 'system',
      // Devot's own theme.
      theme: 'default',
      systemAccent: false,
      toolbar: true,
      scrollPastEnd: true,
      cursorScrollMargin: 0,
      fontWeight: 'normal',
      showInvisibles: false,
      highlightTrailingWhitespace: false,
      previewFontSize: 15,
      defaultNotebook: null,
      // An update found downloads in the background unless turned off.
      autoDownloadUpdates: true,
    })
  })

  it('offers choices that the Rust side accepts', () => {
    // The same lists and ranges as src-tauri/src/editor_settings.rs.
    expect(FONT_FAMILIES).toEqual([
      'system',
      'mono',
      'menlo',
      'monaco',
      'courierNew',
      'installed',
      'imported',
    ])
    expect(INDENT_UNITS).toEqual(['spaces2', 'spaces4', 'tab'])
    expect(LIST_MARKERS).toEqual(['*', '-', '+'])
    expect(FONT_WEIGHTS).toEqual(['normal', '300', '400', '500', '600', '700'])
    expect(PASTE_URL_STYLES).toEqual(['plain', 'autolink', 'link'])
    expect(LINE_WRAPPING_MODES).toEqual(['off', 'all', 'prose', 'unwrapAtCursor'])
    expect(APPEARANCES).toEqual(['light', 'dark', 'system'])
    expect(THEMES).toEqual(['default', 'ivory'])
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
      listMarker: '#',
      tabWidth: 8,
      toolbar: false,
      cursorScrollMargin: 999,
      fontWeight: '500',
      previewFontSize: 18,
      defaultNotebook: 'abc-1',
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
      tabWidth: 8,
      toolbar: false,
      fontWeight: '500',
      previewFontSize: 18,
      defaultNotebook: 'abc-1',
      sidebarMaterial: false,
      syncScroll: false,
    })
    expect(read).not.toHaveProperty('future')
    expect(parseEditorSettings({ syncScroll: 0 }).syncScroll).toBe(true)
    // An invalid value falls back to its default, a stored old value is kept.
    expect(parseEditorSettings({ lineHeight: 9, cursorScrollMargin: 'a' })).toEqual(
      DEFAULT_EDITOR_SETTINGS,
    )
    expect(parseEditorSettings({ lineHeight: 1.4, tabWidth: 4, listMarker: '-' })).toEqual({
      ...DEFAULT_EDITOR_SETTINGS,
      lineHeight: 1.4,
      tabWidth: 4,
      listMarker: '-',
    })
    expect(parseEditorSettings({ listMarker: '+' }).listMarker).toBe('+')
    expect(parseEditorSettings({ defaultNotebook: 'a b' }).defaultNotebook).toBeNull()
    expect(parseEditorSettings({ sidebarMaterial: 'off' }).sidebarMaterial).toBe(true)
    expect(parseEditorSettings({ autoDownloadUpdates: false }).autoDownloadUpdates).toBe(false)
    expect(parseEditorSettings({ autoDownloadUpdates: 'no' }).autoDownloadUpdates).toBe(true)
  })

  it('reads line wrapping as a mode, and the old on/off as unwrap at cursor/off', () => {
    for (const lineWrapping of LINE_WRAPPING_MODES)
      expect(parseEditorSettings({ lineWrapping }).lineWrapping).toBe(lineWrapping)
    expect(parseEditorSettings({ lineWrapping: true }).lineWrapping).toBe('unwrapAtCursor')
    expect(parseEditorSettings({ lineWrapping: false }).lineWrapping).toBe('off')
    expect(parseEditorSettings({ lineWrapping: 'sometimes' }).lineWrapping).toBe('unwrapAtCursor')
    for (const lineWrapping of LINE_WRAPPING_MODES)
      expect(checkEditorSettingsPatch({ lineWrapping })).toEqual({ lineWrapping })
    for (const lineWrapping of [true, false, 'unwrap-at-cursor', null])
      expect(() => checkEditorSettingsPatch({ lineWrapping })).toThrow('E_EDITOR_SETTINGS_INVALID')
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
    expect(checkEditorSettingsPatch({ autoDownloadUpdates: false })).toEqual({
      autoDownloadUpdates: false,
    })
    for (const bad of [
      { autoDownloadUpdates: 'on' },
      { autoDownloadUpdates: null },
      { fontSize: 9 },
      { fontSize: 33 },
      { fontSize: 13.5 },
      { fontFamily: 'Papyrus' },
      { lineHeight: 3 },
      { indentUnit: 'spaces3' },
      { tabWidth: 0 },
      { listMarker: '#' },
      { toolbar: 'on' },
      { scrollPastEnd: null },
      { cursorScrollMargin: 201 },
      { fontWeight: 'bold' },
      { fontWeight: 400 },
      { showInvisibles: 1 },
      { highlightTrailingWhitespace: 'yes' },
      { previewFontSize: 9 },
      { defaultNotebook: '' },
      { defaultNotebook: 5 },
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

  it('takes an installed font by family name and an imported one by file name', () => {
    const fonts = {
      fontFamily: 'imported',
      installedFont: 'Fira Code',
      importedFont: '\u9716\u9e5c Mono.woff2',
    }
    expect(checkEditorSettingsPatch(fonts)).toEqual(fonts)
    expect(checkEditorSettingsPatch({ installedFont: null, importedFont: null })).toEqual({
      installedFont: null,
      importedFont: null,
    })
    expect(parseEditorSettings(fonts)).toMatchObject(fonts)
    for (const bad of [
      { installedFont: '' },
      { installedFont: 'Fira"; } body { color: red' },
      { installedFont: "It's" },
      { installedFont: '.AppleSystemUIFont' },
      { installedFont: 'x'.repeat(129) },
      { importedFont: '../editor-settings.json' },
      { importedFont: 'font.exe' },
      { importedFont: 'Font.TTF' },
      { importedFont: ' lead.ttf' },
    ]) {
      expect(() => checkEditorSettingsPatch(bad)).toThrow('E_EDITOR_SETTINGS_INVALID')
      expect(parseEditorSettings(bad)).toMatchObject({ installedFont: null, importedFont: null })
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

  it('reads the theme as default or ivory, and anything else as default', () => {
    for (const theme of ['default', 'ivory'] as const) {
      expect(parseEditorSettings({ theme }).theme).toBe(theme)
      expect(checkEditorSettingsPatch({ theme })).toEqual({ theme })
    }
    for (const theme of ['Ivory', 'dark', 'system', '', 1, null, true]) {
      expect(parseEditorSettings({ theme }).theme).toBe('default')
      expect(() => checkEditorSettingsPatch({ theme })).toThrow('E_EDITOR_SETTINGS_INVALID')
    }
    // A theme with a bad value does not spoil the settings beside it.
    expect(parseEditorSettings({ theme: 'nope', appearance: 'dark' })).toMatchObject({
      theme: 'default',
      appearance: 'dark',
    })
  })

  it('lets only the default theme follow the system accent', () => {
    expect(themeFollowsSystemAccent('default')).toBe(true)
    expect(themeFollowsSystemAccent('ivory')).toBe(false)
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
