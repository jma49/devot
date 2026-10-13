import type { WireStorage } from './storage/wire'

/**
 * `storage` that reports the note writes it completes: once a write has
 * succeeded, `onWrites` gets the note's ID and the `updatedAt` it was
 * written with, together with the other writes completed at the same moment. The lists use it to show a save's new date and
 * order without reloading. A failed write is not reported.
 */
export function reportingNoteWrites(
  storage: WireStorage,
  onWrites: (writes: ReadonlyMap<string, number>) => void,
): WireStorage {
  let pending: Map<string, number> | undefined
  const report = (id: string, updatedAt: number) => {
    if (!pending) {
      pending = new Map()
      // Before anything else the window does with the write's result (a
      // reload of the lists after a change comes later and wins).
      queueMicrotask(() => {
        const writes = pending
        pending = undefined
        if (writes) onWrites(writes)
      })
    }
    pending.set(id, Math.max(pending.get(id) ?? updatedAt, updatedAt))
  }
  return {
    ...storage,
    async putNote(note, links) {
      await storage.putNote(note, links)
      report(note.id, note.updatedAt)
    },
  }
}
