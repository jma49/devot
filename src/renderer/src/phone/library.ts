export type PhoneView =
  | { readonly kind: 'all' }
  | { readonly kind: 'pinned' }
  | { readonly kind: 'book'; readonly id: string }
  | { readonly kind: 'tag'; readonly id: string }
  | { readonly kind: 'templates' }
  | { readonly kind: 'trash' }

export type PhoneStatusFilter = 'all' | 'active' | 'on_hold' | 'completed'

/** A notebook's path from the top, as the note's breadcrumb shows it; empty when it has none. */
export function notebookPath(
  books: readonly { id: string; name: string; parentId: string | null }[],
  id: string | null,
): string {
  const names: string[] = []
  const seen = new Set<string>()
  let at = id
  while (at !== null && !seen.has(at)) {
    seen.add(at)
    const book = books.find((b) => b.id === at)
    if (!book) break
    names.unshift(book.name)
    at = book.parentId
  }
  return names.join(' / ')
}
