import type { ScreensHandlers } from './ops'

/** What Swift's New Note asks of the page once its gate let it (docs/specs/iphone-screens.md, New Note). */
export interface NativeNewNote {
  /** The empty note, made in `bookId` (none: unfiled); `rev` is the note change that made it. */
  readonly create: (bookId: string | null) => Promise<{ id: string; rev: number }>
  /** The note's screen went with nothing changed: it goes too, if it is still as made. */
  readonly discard: (noteId: string) => void
}

const invalid = () => new Error('E_SCREENS_ARGS_INVALID')

const idOrNone = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value === '') throw invalid()
  return value
}

export function newNoteHandlers(newNote: () => NativeNewNote | null): ScreensHandlers {
  return {
    'note.create': async (args) => {
      const made = newNote()
      if (!made) throw new Error('E_SCREENS_UNAVAILABLE')
      return made.create(idOrNone(args['bookId']))
    },
    'note.discard': async (args) => {
      const noteId = idOrNone(args['noteId'])
      if (noteId === null) throw invalid()
      newNote()?.discard(noteId)
      return {}
    },
  }
}
