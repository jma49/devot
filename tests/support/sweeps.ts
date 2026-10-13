import type { StorageAdapter } from '../../src/core'

// The note service compacts history on a queue of its own that no user
// action waits for (NoteService's sweep), so a test that checks what a sweep
// did waits for it here: every sweep ends with the storage call that records
// its time (compactRevisions with a time). This counts those calls on the
// adapter the service writes to.

export interface Sweeps {
  /** Sweeps that have finished so far. */
  readonly count: number
  /** Resolves once `n` sweeps have finished in all. */
  until(n: number): Promise<void>
}

/** Counts the finished sweeps of the note services writing to `storage`. */
export function watchSweeps(storage: StorageAdapter): Sweeps {
  const compact = storage.compactRevisions.bind(storage)
  let count = 0
  const waiting: { n: number; resolve: () => void }[] = []
  storage.compactRevisions = async (ids, sweptAt) => {
    await compact(ids, sweptAt)
    if (sweptAt === null) return
    count += 1
    for (const due of waiting.filter((w) => count >= w.n)) {
      waiting.splice(waiting.indexOf(due), 1)
      due.resolve()
    }
  }
  return {
    get count() {
      return count
    },
    until: (n) =>
      count >= n ? Promise.resolve() : new Promise((resolve) => waiting.push({ n, resolve })),
  }
}
