import type { StorageAdapter } from '../../src/core'

// NoteService compacts history on a queue nothing waits for; every sweep ends with a
// compactRevisions call carrying a time, which is counted here.

export interface Sweeps {
  readonly count: number
  until(n: number): Promise<void>
}

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
