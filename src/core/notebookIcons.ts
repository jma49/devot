// The notebook icon catalogs: the SF Symbols (design/icons/notebook-symbols.json) and Lucide icons (design/icons/notebook-lucide.json) a notebook can show, by
// category, with the extra words search matches. Names only; Rust accepts only these names (`notebook_icon` in src-tauri/src/storage/mod.rs).
import lucideCatalog from '../../design/icons/notebook-lucide.json'
import catalog from '../../design/icons/notebook-symbols.json'

export const NOTEBOOK_ICON_CATEGORIES = [
  'people',
  'nature',
  'communication',
  'media',
  'business',
  'development',
  'design',
  'files',
  'travel',
  'home',
  'gaming',
  'tools',
] as const
export type NotebookIconCategory = (typeof NOTEBOOK_ICON_CATEGORIES)[number]

export interface NotebookSymbol {
  name: string
  category: NotebookIconCategory
  keywords: readonly string[]
}

export const DEFAULT_NOTEBOOK_SYMBOL = 'book.closed'

export const NOTEBOOK_SYMBOLS: readonly NotebookSymbol[] = Object.entries(catalog.symbols).map(
  ([name, entry]) => ({
    name,
    category: entry.category as NotebookIconCategory,
    keywords: entry.keywords,
  }),
)

const byName = new Map(NOTEBOOK_SYMBOLS.map((s) => [s.name, s]))

export const CATEGORY_ICONS: Readonly<Record<NotebookIconCategory, string>> = Object.fromEntries(
  catalog.categories.map((c) => [c.id, c.icon]),
) as Record<NotebookIconCategory, string>

export const LUCIDE_ICON_PREFIX = 'lucide:'

export type NotebookIconSet = 'sfSymbols' | 'lucide'

/** `name` is what `books.icon` stores: `lucide:<glyph>`. */
export const NOTEBOOK_LUCIDE_ICONS: readonly NotebookSymbol[] = Object.entries(
  lucideCatalog.symbols,
).map(([glyph, entry]) => ({
  name: `${LUCIDE_ICON_PREFIX}${glyph}`,
  category: entry.category as NotebookIconCategory,
  keywords: entry.keywords,
}))

const lucideByName = new Map(NOTEBOOK_LUCIDE_ICONS.map((s) => [s.name, s]))

export const CATEGORY_LUCIDE_GLYPHS: Readonly<Record<NotebookIconCategory, string>> =
  Object.fromEntries(lucideCatalog.categories.map((c) => [c.id, c.icon])) as Record<
    NotebookIconCategory,
    string
  >

export function isNotebookSymbol(name: unknown): name is string {
  return typeof name === 'string' && byName.has(name)
}

export function isNotebookIcon(name: unknown): name is string {
  return isNotebookSymbol(name) || (typeof name === 'string' && lucideByName.has(name))
}

export const notebookIcon = (name: string): NotebookSymbol | undefined =>
  byName.get(name) ?? lucideByName.get(name)

/** The Lucide glyph of a stored icon; null for an SF Symbol or a name outside the catalog. */
export const lucideGlyphOf = (icon: string | null): string | null =>
  icon !== null && lucideByName.has(icon) ? icon.slice(LUCIDE_ICON_PREFIX.length) : null

export const notebookIconSet = (icon: string): NotebookIconSet =>
  lucideByName.has(icon) ? 'lucide' : 'sfSymbols'

const iconsOf = (set: NotebookIconSet) =>
  set === 'lucide' ? NOTEBOOK_LUCIDE_ICONS : NOTEBOOK_SYMBOLS

export function symbolsInCategory(
  category: NotebookIconCategory,
  set: NotebookIconSet = 'sfSymbols',
): NotebookSymbol[] {
  return iconsOf(set).filter((s) => s.category === category)
}

export function searchNotebookSymbols(
  query: string,
  set: NotebookIconSet = 'sfSymbols',
): NotebookSymbol[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return iconsOf(set).filter((s) => {
    const name = s.name.startsWith(LUCIDE_ICON_PREFIX)
      ? s.name.slice(LUCIDE_ICON_PREFIX.length)
      : s.name
    const texts = [name, name.replace(/[.-]/g, ' '), ...s.keywords]
    return words.every((w) => texts.some((text) => text.includes(w)))
  })
}
