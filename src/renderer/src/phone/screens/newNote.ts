import type { MadeNote } from '../newNote'
import type { ScreensHandlers } from './ops'

/** What Swift's New Note asks of the page once its gate let it (docs/specs/iphone-screens.md, New Note). */
export interface NativeNewNote {
  /** The empty note, made in `bookId` (none: unfiled); `rev` is the note change that made it. */
  readonly create: (bookId: string | null) => Promise<{ id: string; rev: number }>
  /**
   * The note's screen went with nothing changed: it goes too, if it is still as made. `made` is
   * how an earlier launch made it, for a note this page did not make.
   */
  readonly discard: (noteId: string, made: MadeNote | null) => void
  /** Today's note, found or made (a write the gate held); `E_LICENCE_REQUIRED` when it would be made while editing is locked. */
  readonly today: () => Promise<{ id: string }>
}

const invalid = () => new Error('E_SCREENS_ARGS_INVALID')

const idOrNone = (value: unknown): string | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value === '') throw invalid()
  return value
}

const madeOrNone = (value: unknown): MadeNote | null => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const { bookId, ...rest } = value as Record<string, unknown>
  if (Object.keys(rest).length > 0) throw invalid()
  return { bookId: idOrNone(bookId) }
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
      newNote()?.discard(noteId, madeOrNone(args['made']))
      return {}
    },
    'note.today': async () => {
      const made = newNote()
      if (!made) throw new Error('E_SCREENS_UNAVAILABLE')
      return made.today()
    },
  }
}
