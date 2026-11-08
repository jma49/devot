/**
 * The note writes the page's storage completes, numbered: Swift tells a new note the user has
 * changed from one left as made by a change counted after the one that made it.
 */
let rev = 0
const listeners = new Set<(rev: number, ids: readonly string[]) => void>()

export const noteChangesRev = (): number => rev

export function noteWritesReported(ids: Iterable<string>): void {
  const changed = [...ids]
  if (changed.length === 0) return
  rev += 1
  for (const listener of listeners) listener(rev, changed)
}

export function watchNoteChanges(listener: (rev: number, ids: readonly string[]) => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
