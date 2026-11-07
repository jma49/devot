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

interface Making {
  create: (title: string, bookId: string | null) => Promise<string>
}

/**
 * A link completion's create (`LinkSources.create`) for every window: the note goes in the notebook
 * `bookOf` picks. Before the core has started it rejects with `E_CORE_NOT_READY`, so the completion
 * leaves the link as typed.
 */
export function linkedNoteCreate<C extends Making>(
  core: () => C | null | undefined,
  bookOf: (core: C) => string | null | Promise<string | null>,
  after?: (core: C) => Promise<unknown>,
): (title: string) => Promise<string> {
  return async (title) => {
    const c = core()
    if (!c) throw new Error('E_CORE_NOT_READY')
    const id = await c.create(title, await bookOf(c))
    await after?.(c)
    return id
  }
}
