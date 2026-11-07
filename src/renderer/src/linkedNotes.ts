interface Dropping {
  trash: (id: string) => Promise<unknown>
  purge: (id: string) => Promise<void>
}

/** Deletes a note made for a link that was not kept: to the Trash and purged from it. */
export const dropNote = (core: Dropping, id: string): Promise<void> =>
  core
    .trash(id)
    .then(() => core.purge(id))
    .catch(() => console.warn('W_NOTE_DROP_FAILED', id))

/**
 * A link completion's discard (`LinkSources.discard`) for every window. The main window reloads its
 * lists once the note is gone (`after`); the note window and the phone have nothing to reload.
 */
export function linkedNoteDiscard<C extends Dropping>(
  core: () => C | null | undefined,
  after?: (core: C) => Promise<unknown>,
): (id: string) => Promise<void> {
  return async (id) => {
    const c = core()
    if (!c) return
    await dropNote(c, id)
    await after?.(c)
  }
}
