// Editor settings: how the note editor looks and behaves on this device, plus the window's sidebar material (Settings > Appearance). A local preference, never note
// data: Rust keeps them in their own file (src-tauri/src/editor_settings.rs, which checks the same lists and ranges as this module) and they never sync.

export type FontFamilyId =
  | 'system'
  | 'mono'
  | 'menlo'
  | 'monaco'
  | 'courierNew'
  | 'installed'
  | 'imported'
export type IndentUnitId = 'spaces2' | 'spaces4' | 'tab'
export type ListMarker = '-' | '*' | '+'
export type FontWeightId = 'normal' | '300' | '400' | '500' | '600' | '700'
export type PasteUrlStyle = 'plain' | 'autolink' | 'link' | 'choose'
export type LineWrappingMode = 'off' | 'all' | 'prose' | 'unwrapAtCursor'
export type AppearanceChoice = 'system' | 'light' | 'dark'
export type ThemeChoice = 'default' | 'ivory'

export type ListDatesStyle = 'relative' | 'absolute'
export type AnimationsChoice = 'always' | 'system' | 'off'

export interface EditorSettings {
  lineNumbers: boolean
  lineWrapping: LineWrappingMode
  readableWidth: boolean
  fontSize: number
  fontFamily: FontFamilyId
  installedFont: string | null
  importedFont: string | null
  appFontFamily: FontFamilyId
  appInstalledFont: string | null
  appImportedFont: string | null
  codeFontFamily: FontFamilyId
  codeInstalledFont: string | null
  codeImportedFont: string | null
  lineHeight: number
  indentUnit: IndentUnitId
  tabWidth: number
  listMarker: ListMarker
  spellCheck: boolean
  highlightActiveLine: boolean
  /** The whole window shows the material (the key keeps its old name); off, the window is opaque. */
  sidebarMaterial: boolean
  /** Adjusts the regions' washes from their design values: 0 is the design, -100 opaque, 100 twice as see-through. */
  windowTransparency: number
  pasteUrl: PasteUrlStyle
  syncScroll: boolean
  inlineImages: boolean
  appearance: AppearanceChoice
  theme: ThemeChoice
  systemAccent: boolean
  toolbar: boolean
  scrollPastEnd: boolean
  cursorScrollMargin: number
  fontWeight: FontWeightId
  showInvisibles: boolean
  highlightTrailingWhitespace: boolean
  previewFontSize: number
  defaultNotebook: string | null
  listDates: ListDatesStyle
  autoDownloadUpdates: boolean
  animations: AnimationsChoice
}

/** A default applies to a setting the user never set: Rust keeps only the values the user set. */
export const DEFAULT_EDITOR_SETTINGS: Readonly<EditorSettings> = Object.freeze({
  lineNumbers: false,
  lineWrapping: 'unwrapAtCursor',
  readableWidth: false,
  fontSize: 13,
  fontFamily: 'mono',
  installedFont: null,
  importedFont: null,
  appFontFamily: 'system',
  appInstalledFont: null,
  appImportedFont: null,
  codeFontFamily: 'mono',
  codeInstalledFont: null,
  codeImportedFont: null,
  lineHeight: 1.5,
  indentUnit: 'spaces2',
  tabWidth: 2,
  listMarker: '*',
  spellCheck: true,
  highlightActiveLine: false,
  sidebarMaterial: true,
  windowTransparency: 0,
  pasteUrl: 'link',
  syncScroll: true,
  inlineImages: true,
  appearance: 'system',
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
  listDates: 'relative',
  autoDownloadUpdates: true,
  animations: 'always',
})

export const FONT_FAMILIES: readonly FontFamilyId[] = [
  'system',
  'mono',
  'menlo',
  'monaco',
  'courierNew',
  'installed',
  'imported',
]
export type FontSlot = 'app' | 'note' | 'code'
export const FONT_SLOTS = {
  app: { family: 'appFontFamily', installed: 'appInstalledFont', imported: 'appImportedFont' },
  note: { family: 'fontFamily', installed: 'installedFont', imported: 'importedFont' },
  code: { family: 'codeFontFamily', installed: 'codeInstalledFont', imported: 'codeImportedFont' },
} as const satisfies Record<
  FontSlot,
  { family: keyof EditorSettings; installed: keyof EditorSettings; imported: keyof EditorSettings }
>
export const FONT_SLOT_ORDER: readonly FontSlot[] = ['app', 'note', 'code']

export interface SlotFont {
  family: FontFamilyId
  installed: string | null
  imported: string | null
}

export function slotFont(settings: EditorSettings, slot: FontSlot): SlotFont {
  const keys = FONT_SLOTS[slot]
  return {
    family: settings[keys.family],
    installed: settings[keys.installed],
    imported: settings[keys.imported],
  }
}

export const INDENT_UNITS: readonly IndentUnitId[] = ['spaces2', 'spaces4', 'tab']
export const LIST_MARKERS: readonly ListMarker[] = ['*', '-', '+']
export const FONT_WEIGHTS: readonly FontWeightId[] = ['normal', '300', '400', '500', '600', '700']
export const LINE_WRAPPING_MODES: readonly LineWrappingMode[] = [
  'off',
  'all',
  'prose',
  'unwrapAtCursor',
]

export const LIST_DATES_STYLES: readonly ListDatesStyle[] = ['relative', 'absolute']
export const ANIMATIONS: readonly AnimationsChoice[] = ['always', 'system', 'off']
export const PASTE_URL_STYLES: readonly PasteUrlStyle[] = ['plain', 'autolink', 'link', 'choose']
export const APPEARANCES: readonly AppearanceChoice[] = ['light', 'dark', 'system']
export const THEMES: readonly ThemeChoice[] = ['default', 'ivory']
export const themeFollowsSystemAccent = (theme: ThemeChoice): boolean => theme === 'default'
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 32
const LINE_HEIGHT_MIN = 1
const LINE_HEIGHT_MAX = 2.5
const TAB_WIDTH_MIN = 1
const TAB_WIDTH_MAX = 8
export const CURSOR_SCROLL_MARGIN_MAX = 200
export const WINDOW_TRANSPARENCY_MAX = 100
export const WINDOW_TRANSPARENCY_STEP = 5
export const LINE_HEIGHTS: readonly number[] = [1.2, 1.4, 1.5, 1.6, 1.8, 2]
export const TAB_WIDTHS: readonly number[] = [2, 4, 8]

const INVALID = 'E_EDITOR_SETTINGS_INVALID'

const wholeIn = (min: number, max: number) => (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const oneOf =
  <T>(list: readonly T[]) =>
  (v: unknown) =>
    list.includes(v as T)
const isFlag = (v: unknown) => typeof v === 'boolean'
const isNotebookId = (v: unknown) =>
  v === null || (typeof v === 'string' && /^[\w-]{1,64}$/.test(v))

export const isFontFamilyName = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[\p{Alphabetic}\p{N}\-_&+()][\p{Alphabetic}\p{N} \-_.&+()]{0,127}$/u.test(v)

export const isFontFileName = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[\p{Alphabetic}\p{N}\-_][\p{Alphabetic}\p{N} \-_]{0,63}\.(ttf|otf|woff|woff2)$/u.test(v)

const orNull = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v)

const VALID: { readonly [K in keyof EditorSettings]: (v: unknown) => boolean } = {
  lineNumbers: isFlag,
  lineWrapping: oneOf(LINE_WRAPPING_MODES),
  readableWidth: isFlag,
  fontSize: wholeIn(FONT_SIZE_MIN, FONT_SIZE_MAX),
  fontFamily: oneOf(FONT_FAMILIES),
  installedFont: orNull(isFontFamilyName),
  importedFont: orNull(isFontFileName),
  appFontFamily: oneOf(FONT_FAMILIES),
  appInstalledFont: orNull(isFontFamilyName),
  appImportedFont: orNull(isFontFileName),
  codeFontFamily: oneOf(FONT_FAMILIES),
  codeInstalledFont: orNull(isFontFamilyName),
  codeImportedFont: orNull(isFontFileName),
  lineHeight: (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= LINE_HEIGHT_MIN && v <= LINE_HEIGHT_MAX,
  indentUnit: oneOf(INDENT_UNITS),
  tabWidth: wholeIn(TAB_WIDTH_MIN, TAB_WIDTH_MAX),
  listMarker: oneOf(LIST_MARKERS),
  spellCheck: isFlag,
  highlightActiveLine: isFlag,
  sidebarMaterial: isFlag,
  windowTransparency: wholeIn(-WINDOW_TRANSPARENCY_MAX, WINDOW_TRANSPARENCY_MAX),
  pasteUrl: oneOf(PASTE_URL_STYLES),
  syncScroll: isFlag,
  inlineImages: isFlag,
  appearance: oneOf(APPEARANCES),
  theme: oneOf(THEMES),
  systemAccent: isFlag,
  toolbar: isFlag,
  scrollPastEnd: isFlag,
  cursorScrollMargin: wholeIn(0, CURSOR_SCROLL_MARGIN_MAX),
  fontWeight: oneOf(FONT_WEIGHTS),
  showInvisibles: isFlag,
  highlightTrailingWhitespace: isFlag,
  previewFontSize: wholeIn(FONT_SIZE_MIN, FONT_SIZE_MAX),
  defaultNotebook: isNotebookId,
  listDates: oneOf(LIST_DATES_STYLES),
  autoDownloadUpdates: isFlag,
  animations: oneOf(ANIMATIONS),
}

const KEYS = Object.keys(VALID) as (keyof EditorSettings)[]

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/** Line wrapping was on/off before it became a mode: on is unwrap at cursor. */
function migrate(from: Record<string, unknown>): Record<string, unknown> {
  const old = from.lineWrapping
  return typeof old === 'boolean' ? { ...from, lineWrapping: old ? 'unwrapAtCursor' : 'off' } : from
}

export function parseEditorSettings(value: unknown): EditorSettings {
  const from = migrate(record(value))
  const out: Record<string, unknown> = { ...DEFAULT_EDITOR_SETTINGS }
  for (const key of KEYS) {
    if (Object.hasOwn(from, key) && VALID[key](from[key])) out[key] = from[key]
  }
  return out as unknown as EditorSettings
}

export function checkEditorSettingsPatch(patch: unknown): Partial<EditorSettings> {
  const from = record(patch)
  for (const [key, value] of Object.entries(from)) {
    if (!Object.hasOwn(VALID, key) || !VALID[key as keyof EditorSettings](value))
      throw new Error(INVALID)
  }
  return { ...from } as Partial<EditorSettings>
}

export function stepFontSize(size: number, delta: 1 | -1): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size + delta))
}

export function indentText(unit: IndentUnitId): string {
  return unit === 'tab' ? '\t' : unit === 'spaces4' ? '    ' : '  '
}
