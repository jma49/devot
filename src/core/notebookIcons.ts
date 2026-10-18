// The notebook icon catalog: the SF Symbols a notebook can show, by category,
// with the extra words search matches (design/icons/notebook-symbols.json).
// Names only; the UI renders them at runtime. Rust accepts only these names
// (`notebook_symbol` in src-tauri/src/storage/mod.rs).
import catalog from '../../design/icons/notebook-symbols.json'

/** The icon picker's categories, in the order its tabs show them. */
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
  /** The SF Symbol name, which is what a notebook stores. */
  name: string
  category: NotebookIconCategory
  /** Extra words search matches besides the name. */
  keywords: readonly string[]
}

/** The symbol a notebook shows without an icon of its own. */
export const DEFAULT_NOTEBOOK_SYMBOL = 'book.closed'

/** Every catalog symbol, category by category in catalog order. */
export const NOTEBOOK_SYMBOLS: readonly NotebookSymbol[] = Object.entries(catalog.symbols).map(
  ([name, entry]) => ({
    name,
    category: entry.category as NotebookIconCategory,
    keywords: entry.keywords,
  }),
)

const byName = new Map(NOTEBOOK_SYMBOLS.map((s) => [s.name, s]))

/** Each category's tab icon (a catalog symbol). */
export const CATEGORY_ICONS: Readonly<Record<NotebookIconCategory, string>> = Object.fromEntries(
  catalog.categories.map((c) => [c.id, c.icon]),
) as Record<NotebookIconCategory, string>

/** Whether `name` is a catalog symbol, the only names a notebook icon may be. */
export function isNotebookSymbol(name: unknown): name is string {
  return typeof name === 'string' && byName.has(name)
}

/** The catalog entry for `name`, if it is one. */
export const notebookSymbol = (name: string): NotebookSymbol | undefined => byName.get(name)

/** The symbols of one category, in catalog order. */
export function symbolsInCategory(category: NotebookIconCategory): NotebookSymbol[] {
  return NOTEBOOK_SYMBOLS.filter((s) => s.category === category)
}

/**
 * The symbols `query` finds, in catalog order: those where every word of the
 * query (any case) is part of the name (its dots read as spaces) or of one of
 * its keywords. None for an empty query.
 */
export function searchNotebookSymbols(query: string): NotebookSymbol[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return NOTEBOOK_SYMBOLS.filter((s) => {
    const texts = [s.name, s.name.replaceAll('.', ' '), ...s.keywords]
    return words.every((w) => texts.some((text) => text.includes(w)))
  })
}
