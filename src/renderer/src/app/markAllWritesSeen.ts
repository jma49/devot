import { errorCode } from '../../../core/errors'

/** Marks each note's unseen agent writes seen on its own, so one note failing leaves the others marked, then reloads. */
export async function markAllWritesSeen(
  mark: (noteId: string, writeIds: string[]) => Promise<unknown>,
  unseen: ReadonlyMap<string, string[]>,
  reload: () => void,
): Promise<void> {
  const notes = [...unseen]
  const results = await Promise.allSettled(notes.map(([noteId, ids]) => mark(noteId, ids)))
  reload()
  results.forEach((result, i) => {
    if (result.status === 'rejected')
      console.warn('W_AGENT_WRITES_SEEN_FAILED', notes[i]![0], errorCode(result.reason))
  })
}
