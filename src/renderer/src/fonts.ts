// The editor's own fonts (Settings > Editor > Font Family). An installed
// font is named in the CSS font list as it is; an imported one is read from
// Rust (`font_read`, the file in the app's data folder, checked again there)
// and loaded here as a font face under one family name of Devot's own. Every
// list ends with SF Mono, so a font that is missing, invalid or still
// loading shows SF Mono instead.
import type { EditorSettings } from '../../core/editorSettings'
import { invoke } from './ipc'

/** The family name an imported font is loaded under. */
export const IMPORTED_FONT_FAMILY = 'Devot Imported Font'
const FALLBACK = 'var(--font-family-mono)'

/** Each built-in font as a CSS font list; the monospaced ones fall back to SF Mono. */
const STACKS = {
  system: 'var(--font-family-ui)',
  mono: FALLBACK,
  menlo: `Menlo, ${FALLBACK}`,
  monaco: `Monaco, ${FALLBACK}`,
  courierNew: `'Courier New', ${FALLBACK}`,
} as const

/**
 * The editor's font list. Installed and imported names were checked when set
 * (no quotes or backslashes), so they go in quoted as they are.
 */
export function fontStack(
  settings: Pick<EditorSettings, 'fontFamily' | 'installedFont' | 'importedFont'>,
): string {
  switch (settings.fontFamily) {
    case 'installed':
      return settings.installedFont ? `"${settings.installedFont}", ${FALLBACK}` : FALLBACK
    case 'imported':
      return settings.importedFont ? `"${IMPORTED_FONT_FAMILY}", ${FALLBACK}` : FALLBACK
    default:
      return STACKS[settings.fontFamily]
  }
}

/** What loading a font face needs (the page's, or a test's). */
export interface FontEnv {
  read(id: string): Promise<ArrayBuffer>
  load(family: string, bytes: ArrayBuffer): Promise<FontFace>
  add(face: FontFace): void
  remove(face: FontFace): void
}

const pageEnv = (): FontEnv => ({
  read: (id) => invoke<ArrayBuffer>('font_read', { id }),
  load: (family, bytes) => new FontFace(family, bytes).load(),
  add: (face) => void document.fonts.add(face),
  remove: (face) => void document.fonts.delete(face),
})

/**
 * Keeps one imported font loaded: the file the settings name, or none.
 * `use` resolves to whether that font is in place; a newer call wins over
 * one still loading.
 */
export function importedFontLoader(env: FontEnv = pageEnv()) {
  let wanted: string | null = null
  let face: FontFace | undefined
  let loaded: string | null = null
  return {
    async use(id: string | null): Promise<boolean> {
      if (id === wanted) return id === null || loaded === id
      wanted = id
      if (face) env.remove(face)
      face = undefined
      loaded = null
      if (id === null) return true
      try {
        const next = await env.load(IMPORTED_FONT_FAMILY, await env.read(id))
        if (wanted !== id) return false
        env.add(next)
        face = next
        loaded = id
        return true
      } catch {
        // SF Mono shows instead (the font list ends with it).
        if (wanted === id) console.warn('W_FONT_LOAD_FAILED')
        return false
      }
    },
  }
}

const pageLoader = { current: undefined as ReturnType<typeof importedFontLoader> | undefined }

/** Loads the imported font the settings use, or drops the one loaded. */
export function syncImportedFont(settings: EditorSettings): void {
  const id = settings.fontFamily === 'imported' ? settings.importedFont : null
  if (id === null && !pageLoader.current) return
  pageLoader.current ??= importedFontLoader()
  void pageLoader.current.use(id)
}

/** An imported font: its file name (the ID) and the name Settings shows. */
export interface FontFile {
  id: string
  name: string
}

/** The fonts installed on this Mac, by family name. */
export const installedFonts = (): Promise<string[]> => invoke<string[]>('fonts_installed')

/** The imported fonts. */
export const importedFonts = (): Promise<FontFile[]> => invoke<FontFile[]>('fonts_list')

/** Asks for a font file and imports it; null when the user cancelled. */
export const importFont = (): Promise<FontFile | null> => invoke<FontFile | null>('font_import')
