// The app's three fonts (Settings > Editor): the app's text, the notes' text
// and code (see FONT_SLOTS). An installed font is named in the CSS font list
// as it is; an imported one is read from Rust (`font_read`, the file in the
// app's data folder, checked again there) and loaded here as a font face
// under a family name of Devot's own, one per file. A list names an imported
// face only once it has loaded, so the CSS value changes when it is ready
// and the text (the editor's shadow tree too) takes it at once. Every list
// ends with the slot's default (the system font for the app's text, SF Mono
// for the rest), so a font that is missing, invalid or still loading shows
// that instead.
import {
  FONT_SLOT_ORDER,
  slotFont,
  type EditorSettings,
  type FontSlot,
  type SlotFont,
} from '../../core/editorSettings'
import { invoke } from './ipc'
import { sizes } from './theme/tokens'

const SYSTEM = sizes['font.family.ui']
const MONO = 'var(--font-family-mono)'

const STACKS = {
  system: SYSTEM,
  mono: MONO,
  menlo: `Menlo, ${MONO}`,
  monaco: `Monaco, ${MONO}`,
  courierNew: `'Courier New', ${MONO}`,
} as const

const FALLBACK: Readonly<Record<FontSlot, string>> = { app: SYSTEM, note: MONO, code: MONO }

/**
 * The family name an imported file is loaded under: Devot's own, one per
 * file. A file name has only letters, digits, spaces, `-`, `_` and the
 * extension's dot (checked when set); the dot becomes a space.
 */
export const importedFontFamily = (id: string): string =>
  `Devot Font ${id.replace(/[^\p{L}\p{N} _-]/gu, ' ')}`

/**
 * A slot's font list. Installed names were checked when set (no quotes or
 * backslashes), so they go in quoted as they are; an imported font is named
 * once `loaded` says its face is in place.
 */
export function fontStack(
  font: SlotFont,
  slot: FontSlot,
  loaded: (id: string) => boolean = () => true,
): string {
  const fallback = FALLBACK[slot]
  switch (font.family) {
    case 'installed':
      return font.installed ? `"${font.installed}", ${fallback}` : fallback
    case 'imported':
      return font.imported && loaded(font.imported)
        ? `"${importedFontFamily(font.imported)}", ${fallback}`
        : fallback
    default:
      return STACKS[font.family]
  }
}

export const FONT_VARIABLES: Readonly<Record<FontSlot, string>> = {
  app: '--font-family-ui',
  note: '--editor-font-family',
  code: '--code-font-family',
}

/**
 * The CSS variables for the three fonts. The preview's text keeps the app's
 * font until the note font is changed from its default, then takes it.
 */
export function fontVariables(
  settings: EditorSettings,
  loaded?: (id: string) => boolean,
): [name: string, value: string][] {
  const out = FONT_SLOT_ORDER.map((slot): [string, string] => [
    FONT_VARIABLES[slot],
    fontStack(slotFont(settings, slot), slot, loaded),
  ])
  const note = slotFont(settings, 'note')
  const preview = note.family === 'mono' ? 'var(--font-family-ui)' : fontStack(note, 'note', loaded)
  return [...out, ['--preview-font-family', preview]]
}

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
 * Keeps the imported fonts the slots use loaded, one face per file (two
 * slots may share one), and drops a face no slot uses any more. `use`
 * resolves to whether the slot's font is in place; `loaded` calls back each
 * time a face is added. A stored file is never replaced (Rust gives a
 * changed file a new name), so a face loaded once stays right; a file that
 * failed is tried again once a slot chooses it anew.
 */
export function importedFontLoader(env: FontEnv = pageEnv(), loaded: () => void = () => {}) {
  const wanted = new Map<FontSlot, string>()
  const faces = new Map<string, FontFace>()
  const loading = new Map<string, Promise<boolean>>()
  const failed = new Set<string>()
  const used = (id: string) => [...wanted.values()].includes(id)

  async function load(id: string): Promise<boolean> {
    try {
      const face = await env.load(importedFontFamily(id), await env.read(id))
      if (!used(id)) return false
      env.add(face)
      faces.set(id, face)
      loaded()
      return true
    } catch {
      // The slot's default shows instead (the font list ends with it).
      if (used(id)) console.warn('W_FONT_LOAD_FAILED')
      failed.add(id)
      return false
    } finally {
      loading.delete(id)
    }
  }

  return {
    has: (id: string): boolean => faces.has(id),
    use(slot: FontSlot, id: string | null): Promise<boolean> {
      if (id === null) wanted.delete(slot)
      else if (wanted.get(slot) !== id) {
        wanted.set(slot, id)
        failed.delete(id)
      }
      for (const [file, face] of faces) {
        if (used(file)) continue
        env.remove(face)
        faces.delete(file)
      }
      for (const file of failed) if (!used(file)) failed.delete(file)
      if (id === null || faces.has(id)) return Promise.resolve(true)
      if (failed.has(id)) return Promise.resolve(false)
      let pending = loading.get(id)
      if (!pending) {
        pending = load(id)
        loading.set(id, pending)
      }
      return pending
    },
  }
}

let pageLoader: ReturnType<typeof importedFontLoader> | undefined
const fontsLoadedListeners = new Set<() => void>()

export function subscribeFontsLoaded(notify: () => void): () => void {
  fontsLoadedListeners.add(notify)
  return () => fontsLoadedListeners.delete(notify)
}

export const importedFontLoaded = (id: string): boolean => pageLoader?.has(id) ?? false

export function syncImportedFonts(settings: EditorSettings): void {
  const ids = FONT_SLOT_ORDER.map((slot) => {
    const font = slotFont(settings, slot)
    return [slot, font.family === 'imported' ? font.imported : null] as const
  })
  if (!pageLoader && ids.every(([, id]) => id === null)) return
  pageLoader ??= importedFontLoader(pageEnv(), () => {
    for (const notify of fontsLoadedListeners) notify()
  })
  for (const [slot, id] of ids) void pageLoader.use(slot, id)
}

export interface FontFile {
  id: string
  name: string
}

export const installedFonts = (): Promise<string[]> => invoke<string[]>('fonts_installed')

export const importedFonts = (): Promise<FontFile[]> => invoke<FontFile[]>('fonts_list')

export const importFont = (): Promise<FontFile | null> => invoke<FontFile | null>('font_import')
