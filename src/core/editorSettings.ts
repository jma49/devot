// Editor settings: how the note editor looks and behaves on this device
// (with whether split mode scrolls the editor and the preview together),
// plus whether the window shows the sidebar material (Settings >
// Appearance). They are a local preference, never note data: Rust keeps them in their
// own file (src-tauri/src/editor_settings.rs, which checks the same lists and
// ranges as this module) and they never sync.

export type FontFamilyId = 'system' | 'mono' | 'menlo' | 'monaco' | 'courierNew'
export type IndentUnitId = 'spaces2' | 'spaces4' | 'tab'
export type ListMarker = '-' | '*'
/**
 * What pasting a lone URL (nothing selected) inserts: the URL as copied, an
 * autolink (`<url>`) or a link with empty text (`[](url)`). A URL pasted
 * over selected text always makes that text a link.
 */
export type PasteUrlStyle = 'plain' | 'autolink' | 'link'
/** The appearance the windows show (Settings > Appearance): the system's, or always light or dark. */
export type AppearanceChoice = 'system' | 'light' | 'dark'

export interface EditorSettings {
  lineNumbers: boolean
  lineWrapping: boolean
  /** Lines no wider than the reading width (`size.reading-width`). */
  readableWidth: boolean
  /** In CSS pixels. */
  fontSize: number
  fontFamily: FontFamilyId
  lineHeight: number
  indentUnit: IndentUnitId
  /** How many columns a tab character takes. */
  tabWidth: number
  /** The bullet a new list item gets. */
  listMarker: ListMarker
  spellCheck: boolean
  highlightActiveLine: boolean
  /** The window shows the sidebar material; off, the sidebar is opaque. */
  sidebarMaterial: boolean
  pasteUrl: PasteUrlStyle
  /** Split mode keeps the editor and the preview at the same line (View > Synced Scrolling). */
  syncScroll: boolean
  /** Images (attachments) show under their lines in the editor. */
  inlineImages: boolean
  /** Light, Dark, or the system's appearance (the default). */
  appearance: AppearanceChoice
  /** The accent follows the macOS accent colour instead of Devot's palette. */
  systemAccent: boolean
}

/**
 * The editor as it was before these settings existed (with SF Mono), the
 * sidebar material on, synced scrolling on, images shown under their lines,
 * and the system's appearance with Devot's own accent.
 */
export const DEFAULT_EDITOR_SETTINGS: Readonly<EditorSettings> = Object.freeze({
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
  syncScroll: true,
  inlineImages: true,
  appearance: 'system',
  systemAccent: false,
})

export const FONT_FAMILIES: readonly FontFamilyId[] = [
  'system',
  'mono',
  'menlo',
  'monaco',
  'courierNew',
]
export const INDENT_UNITS: readonly IndentUnitId[] = ['spaces2', 'spaces4', 'tab']
export const LIST_MARKERS: readonly ListMarker[] = ['-', '*']
export const PASTE_URL_STYLES: readonly PasteUrlStyle[] = ['plain', 'autolink', 'link']
/** The appearances Settings offers, in its order. */
export const APPEARANCES: readonly AppearanceChoice[] = ['light', 'dark', 'system']
export const FONT_SIZE_MIN = 10
export const FONT_SIZE_MAX = 32
const LINE_HEIGHT_MIN = 1
const LINE_HEIGHT_MAX = 2.5
const TAB_WIDTH_MIN = 1
const TAB_WIDTH_MAX = 8
/** The line heights the Settings window offers. */
export const LINE_HEIGHTS: readonly number[] = [1.2, 1.4, 1.6, 1.8, 2]
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

/** What each setting accepts. */
const VALID: { readonly [K in keyof EditorSettings]: (v: unknown) => boolean } = {
  lineNumbers: isFlag,
  lineWrapping: isFlag,
  readableWidth: isFlag,
  fontSize: wholeIn(FONT_SIZE_MIN, FONT_SIZE_MAX),
  fontFamily: oneOf(FONT_FAMILIES),
  lineHeight: (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= LINE_HEIGHT_MIN && v <= LINE_HEIGHT_MAX,
  indentUnit: oneOf(INDENT_UNITS),
  tabWidth: wholeIn(TAB_WIDTH_MIN, TAB_WIDTH_MAX),
  listMarker: oneOf(LIST_MARKERS),
  spellCheck: isFlag,
  highlightActiveLine: isFlag,
  sidebarMaterial: isFlag,
  pasteUrl: oneOf(PASTE_URL_STYLES),
  syncScroll: isFlag,
  inlineImages: isFlag,
  appearance: oneOf(APPEARANCES),
  systemAccent: isFlag,
}

const KEYS = Object.keys(VALID) as (keyof EditorSettings)[]

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

/** Settings from storage or an event: each valid value, defaults for the rest. */
export function parseEditorSettings(value: unknown): EditorSettings {
  const from = record(value)
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
