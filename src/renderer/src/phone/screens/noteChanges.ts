/**
 * The writes the page's storage completes, numbered, for the native lists: Swift reads again the
 * rows a change names, reads every list again when it skipped a number or `all` is set, and tells
 * a new note the user has changed from one left as made by a change counted after it.
 */
let rev = 0
const listeners = new Set<(rev: number, ids: readonly string[], all: boolean) => void>()

export type LibraryNotice = 'books.changed' | 'tags.changed' | 'savedSearches.changed'
const libraryListeners = new Set<(notice: LibraryNotice) => void>()

export const noteChangesRev = (): number => rev

function report(ids: readonly string[], all: boolean) {
  rev += 1
  for (const listener of listeners) listener(rev, ids, all)
}

export function noteWritesReported(ids: Iterable<string>): void {
  const changed = [...new Set(ids)]
  if (changed.length > 0) report(changed, false)
}

/** Sync or another process wrote notes the page cannot name. */
export const externalChangesReported = (): void => report([], true)

export function libraryWritesReported(notice: LibraryNotice): void {
  for (const listener of libraryListeners) listener(notice)
}

export function watchNoteChanges(
  listener: (rev: number, ids: readonly string[], all: boolean) => void,
) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function watchLibraryChanges(listener: (notice: LibraryNotice) => void) {
  libraryListeners.add(listener)
  return () => {
    libraryListeners.delete(listener)
  }
}
