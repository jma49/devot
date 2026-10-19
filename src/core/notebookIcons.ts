// The notebook icon catalog: the SF Symbols a notebook can show, by category, with the extra words search matches (design/icons/notebook-symbols.json). Names only;
// Rust accepts only these names (`notebook_symbol` in src-tauri/src/storage/mod.rs).
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

export function isNotebookSymbol(name: unknown): name is string {
  return typeof name === 'string' && byName.has(name)
}

export const notebookSymbol = (name: string): NotebookSymbol | undefined => byName.get(name)

export function symbolsInCategory(category: NotebookIconCategory): NotebookSymbol[] {
  return NOTEBOOK_SYMBOLS.filter((s) => s.category === category)
}

export function searchNotebookSymbols(query: string): NotebookSymbol[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return NOTEBOOK_SYMBOLS.filter((s) => {
    const texts = [s.name, s.name.replaceAll('.', ' '), ...s.keywords]
    return words.every((w) => texts.some((text) => text.includes(w)))
  })
}
