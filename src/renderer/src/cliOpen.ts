// Where files from the `devot` command go, and which note opens after.
import { notebookForNewNote } from './notebookChoices'

export type OpenDestination =
  | { readonly kind: 'book'; readonly id: string | null }
  | { readonly kind: 'create'; readonly name: string }

/** An exact name wins over one differing only in case; a missing one is made. */
export function openDestination(
  name: string | null,
  books: readonly { readonly id: string; readonly name: string }[],
  defaultBookId: string | null,
): OpenDestination {
  if (name === null) {
    const id = notebookForNewNote(
      undefined,
      defaultBookId,
      books.map((b) => b.id),
    )
    return { kind: 'book', id }
  }
  const folded = name.toLocaleLowerCase()
  const found =
    books.find((b) => b.name === name) ?? books.find((b) => b.name.toLocaleLowerCase() === folded)
  return found ? { kind: 'book', id: found.id } : { kind: 'create', name }
}

/** Falls back to the first imported when the first file named was not. */
export function firstImported(
  noteIds: Readonly<Record<string, string>>,
  files: readonly { readonly path: string }[],
  first: string | null,
): string | undefined {
  const named = first === null ? undefined : noteIds[first]
  return named ?? files.map((f) => noteIds[f.path]).find((id) => id !== undefined)
}
