import type { Core } from '../../core-client'

// From a row's touch-down to its tap; a touch that became a scroll or a peek lets the note go.
export const PREPARED_MS = 1500

interface Prepared {
  readonly core: Core
  state?: Uint8Array
  readonly timer: ReturnType<typeof setTimeout>
}

/**
 * Notes opened when a finger lands on their row, so the editor swaps the body in without waiting
 * for it. Each is held until the editor takes it, which then owns the hold, or until it expires.
 */
export function createPreparedNotes(expiresMs = PREPARED_MS) {
  const notes = new Map<string, Prepared>()
  const release = (noteId: string) => {
    const left = notes.get(noteId)
    if (!left) return
    notes.delete(noteId)
    clearTimeout(left.timer)
    void left.core.unhold(noteId)
  }
  return {
    prepare(core: Core, noteId: string): void {
      if (notes.get(noteId)?.core === core) return
      release(noteId)
      const entry: Prepared = { core, timer: setTimeout(() => release(noteId), expiresMs) }
      notes.set(noteId, entry)
      void core.hold(noteId)
      core.open(noteId).then(
        (opened) => {
          if (notes.get(noteId) === entry) entry.state = opened.state
        },
        () => release(noteId),
      )
    },
    take(core: Core, noteId: string): Uint8Array | undefined {
      const entry = notes.get(noteId)
      if (entry?.core !== core || !entry.state) return undefined
      notes.delete(noteId)
      clearTimeout(entry.timer)
      return entry.state
    },
    clear(): void {
      for (const noteId of [...notes.keys()]) release(noteId)
    },
  }
}

export type PreparedNotes = ReturnType<typeof createPreparedNotes>
