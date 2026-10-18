// Editor settings: how the note editor looks and behaves on this device
// (with whether split mode scrolls the editor and the preview together),
// plus whether the window shows the sidebar material (Settings >
// Appearance). They are a local preference, never note data: Rust keeps them in their
// own file (src-tauri/src/editor_settings.rs, which checks the same lists and
// ranges as this module) and they never sync.

/**
 * A font (the app's, the notes' or code's, see `FONT_SLOTS`): the system
 * font, one of the monospaced system fonts, a font installed on this Mac
 * (`installedFont` and the like) or a font file the user imported
 * (`importedFont` and the like).
 */
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
/** The weight of the editor's text: the font's normal one or a CSS weight. */
export type FontWeightId = 'normal' | '300' | '400' | '500' | '600' | '700'
/**
 * What pasting a lone URL (nothing selected) inserts: the URL as copied, an
 * autolink (`<url>`), a link with empty text (`[](url)`), or the URL as
 * copied with a list of formats to choose from. A URL pasted over selected
 * text always makes that text a link.
 */
export type PasteUrlStyle = 'plain' | 'autolink' | 'link' | 'choose'
/**
 * How long lines wrap: never, always, everywhere but code blocks and tables
 * (`prose`), or everywhere but the code block or table under the caret.
 */
export type LineWrappingMode = 'off' | 'all' | 'prose' | 'unwrapAtCursor'
/** The appearance the windows show (Settings > Appearance): the system's, or always light or dark. */
export type AppearanceChoice = 'system' | 'light' | 'dark'
/**
 * The colour theme the windows show (Settings > Appearance): Devot's default
 * theme, or Ivory, a warm one. Each theme has a light and a dark appearance.
 */
export type ThemeChoice = 'default' | 'ivory'

/** How the note list shows a note's date: how long ago, or the date itself. */
export type ListDatesStyle = 'relative' | 'absolute'

export interface EditorSettings {
  lineNumbers: boolean
  lineWrapping: LineWrappingMode
  /** Lines no wider than the reading width (`size.reading-width`). */
  readableWidth: boolean
  /** In CSS pixels. */
  fontSize: number
  fontFamily: FontFamilyId
  /** The family name of the installed font the editor uses (`fontFamily` `installed`), or none. */
  installedFont: string | null
  /** The file name of the imported font the editor uses (`fontFamily` `imported`), or none. */
  importedFont: string | null
  /** The font of the app's own text (the sidebar, the lists, menus, Settings). */
  appFontFamily: FontFamilyId
  appInstalledFont: string | null
  appImportedFont: string | null
  /** The font of code blocks and inline code, in the editor and the preview. */
  codeFontFamily: FontFamilyId
  codeInstalledFont: string | null
  codeImportedFont: string | null
  lineHeight: number
  indentUnit: IndentUnitId
  /** How many columns a tab character takes. */
  tabWidth: number
  /** The bullet a new list item gets. */
  listMarker: ListMarker
  spellCheck: boolean
  highlightActiveLine: boolean
  /** The whole window shows the material (the key keeps its old name); off, the window is opaque. */
  sidebarMaterial: boolean
  /**
   * How see-through the regions' washes are, 0 (opaque) to 100; 50 is the
   * design value (Settings > Appearance > Transparency).
   */
  windowTransparency: number
  pasteUrl: PasteUrlStyle
  /** Split mode keeps the editor and the preview at the same line (View > Synced Scrolling). */
  syncScroll: boolean
  /** Images (attachments) show under their lines in the editor. */
  inlineImages: boolean
  /** Light, Dark, or the system's appearance (the default). */
  appearance: AppearanceChoice
  /** The colour theme: Devot's default, or Ivory (which ignores the system accent). */
  theme: ThemeChoice
  /** The accent follows the macOS accent colour instead of Devot's palette. */
  systemAccent: boolean
  /** The selection toolbar shows over selected text. */
  toolbar: boolean
  /** The editor scrolls past the end of the note. */
  scrollPastEnd: boolean
  /** Pixels kept above and below the cursor when it nears the edge. */
  cursorScrollMargin: number
  fontWeight: FontWeightId
  /** Spaces and tabs are drawn. */
  showInvisibles: boolean
  /** Spaces and tabs at the end of a line are tinted. */
  highlightTrailingWhitespace: boolean
  /** The preview's font size, in CSS pixels. */
  previewFontSize: number
  /** The notebook a new note goes to when the view has none (an ID), or none. */
  defaultNotebook: string | null
  /** The note list shows how long ago a note changed, or its date. */
  listDates: ListDatesStyle
  /** An update found downloads in the background (Settings > General). */
  autoDownloadUpdates: boolean
}

/**
 * The editor's defaults (notes and code in SF Mono, the app's text in the
 * system font), the sidebar material on, synced scrolling
 * on, images shown under their lines, and the system's appearance with
 * Devot's own theme and accent. A default applies to a setting the user never set:
 * Rust keeps only the values the user set.
 */
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
  windowTransparency: 50,
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
/**
 * The three fonts and the settings each is chosen with: the app's text, the
 * notes' text (the editor, and the preview once it is not the default) and
 * code (blocks and inline code in both).
 */
export type FontSlot = 'app' | 'note' | 'code'
export const FONT_SLOTS = {
  app: { family: 'appFontFamily', installed: 'appInstalledFont', imported: 'appImportedFont' },
  note: { family: 'fontFamily', installed: 'installedFont', imported: 'importedFont' },
  code: { family: 'codeFontFamily', installed: 'codeInstalledFont', imported: 'codeImportedFont' },
} as const satisfies Record<
  FontSlot,
  { family: keyof EditorSettings; installed: keyof EditorSettings; imported: keyof EditorSettings }
>
/** The slots in the order Settings shows them. */
export const FONT_SLOT_ORDER: readonly FontSlot[] = ['app', 'note', 'code']

/** One slot's font: its family and the installed and imported fonts it can name. */
export interface SlotFont {
  family: FontFamilyId
  installed: string | null
  imported: string | null
}

/** The font a slot uses. */
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
/** The line wrapping modes Settings offers, in its order. */
export const LINE_WRAPPING_MODES: readonly LineWrappingMode[] = [
  'off',
  'all',
  'prose',
  'unwrapAtCursor',
]

export const LIST_DATES_STYLES: readonly ListDatesStyle[] = ['relative', 'absolute']
export const PASTE_URL_STYLES: readonly PasteUrlStyle[] = ['plain', 'autolink', 'link', 'choose']
/** The appearances Settings offers, in its order. */
export const APPEARANCES: readonly AppearanceChoice[] = ['light', 'dark', 'system']
/** The themes Settings offers, in its order. */
export const THEMES: readonly ThemeChoice[] = ['default', 'ivory']
/** Whether the accent can follow the macOS accent colour: Ivory has its own accent. */
export const themeFollowsSystemAccent = (theme: ThemeChoice): boolean => theme === 'default'
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 32
const LINE_HEIGHT_MIN = 1
const LINE_HEIGHT_MAX = 2.5
const TAB_WIDTH_MIN = 1
const TAB_WIDTH_MAX = 8
export const CURSOR_SCROLL_MARGIN_MAX = 200
export const WINDOW_TRANSPARENCY_MAX = 100
/** The Transparency slider's step. */
export const WINDOW_TRANSPARENCY_STEP = 5
/** The line heights the Settings window offers. */
export const LINE_HEIGHTS: readonly number[] = [1.2, 1.4, 1.5, 1.6, 1.8, 2]
/** The tab widths the Settings window offers. */
export const TAB_WIDTHS: readonly number[] = [2, 4, 8]

const INVALID = 'E_EDITOR_SETTINGS_INVALID'

const wholeIn = (min: number, max: number) => (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const oneOf =
  <T>(list: readonly T[]) =>
  (v: unknown) =>
    list.includes(v as T)
const isFlag = (v: unknown) => typeof v === 'boolean'
/** A notebook ID: letters, digits, `-` and `_`, up to 64 of them. */
const isNotebookId = (v: unknown) =>
  v === null || (typeof v === 'string' && /^[\w-]{1,64}$/.test(v))

/**
 * An installed font's family name: letters, digits, spaces and `-_.&+()`,
 * up to 128 of them, not starting with a space or `.` (the system's hidden
 * families). The same check runs in Rust (src-tauri/src/fonts.rs).
 */
export const isFontFamilyName = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[\p{Alphabetic}\p{N}\-_&+()][\p{Alphabetic}\p{N} \-_.&+()]{0,127}$/u.test(v)

/**
 * An imported font's file name: a stem of letters, digits, spaces, `-` and
 * `_` (up to 64, not starting with a space) and a font extension, lowercase.
 * The same check runs in Rust (src-tauri/src/fonts.rs).
 */
export const isFontFileName = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[\p{Alphabetic}\p{N}\-_][\p{Alphabetic}\p{N} \-_]{0,63}\.(ttf|otf|woff|woff2)$/u.test(v)

const orNull = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v)

/** What each setting accepts. */
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
  windowTransparency: wholeIn(0, WINDOW_TRANSPARENCY_MAX),
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
}

const KEYS = Object.keys(VALID) as (keyof EditorSettings)[]

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/** Line wrapping was on/off before it became a mode: on is unwrap at cursor. */
function migrate(from: Record<string, unknown>): Record<string, unknown> {
  const old = from.lineWrapping
  return typeof old === 'boolean' ? { ...from, lineWrapping: old ? 'unwrapAtCursor' : 'off' } : from
}

/** Settings from storage or an event: each valid value, defaults for the rest. */
export function parseEditorSettings(value: unknown): EditorSettings {
  const from = migrate(record(value))
  const out: Record<string, unknown> = { ...DEFAULT_EDITOR_SETTINGS }
  for (const key of KEYS) {
    if (Object.hasOwn(from, key) && VALID[key](from[key])) out[key] = from[key]
  }
  return out as unknown as EditorSettings
}

/** A change to make; throws `E_EDITOR_SETTINGS_INVALID` for an unknown key or a bad value. */
export function checkEditorSettingsPatch(patch: unknown): Partial<EditorSettings> {
  const from = record(patch)
  for (const [key, value] of Object.entries(from)) {
    if (!Object.hasOwn(VALID, key) || !VALID[key as keyof EditorSettings](value))
      throw new Error(INVALID)
  }
  return { ...from } as Partial<EditorSettings>
}

/** The font size one step bigger (`delta` 1) or smaller (-1), within the range. */
export function stepFontSize(size: number, delta: 1 | -1): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size + delta))
}

/** The text one level of indentation inserts. */
export function indentText(unit: IndentUnitId): string {
  return unit === 'tab' ? '\t' : unit === 'spaces4' ? '    ' : '  '
}
