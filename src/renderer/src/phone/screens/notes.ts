import type { NoteCounts } from '../../../../core/noteCounts'
import { statsOf } from '../noteStats'
import type { ScreensHandlers } from './ops'

/** What Note Info and the tags picker ask of the core (docs/specs/iphone-screens.md, Operations). */
export interface NotesCore {
  readonly read: (id: string) => Promise<{ bodyMd: string }>
  readonly noteCounts: (markdown: string) => Promise<NoteCounts> | NoteCounts
  readonly history: (id: string) => Promise<readonly unknown[]>
  readonly backlinks: (id: string) => Promise<readonly { id: string; title: string }[]>
  readonly setNoteDates: (
    id: string,
    dates: { createdAt?: number; updatedAt?: number },
  ) => Promise<unknown>
  readonly addTag: (noteId: string, name: string) => Promise<string>
}

const date = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

/** Rust has checked every argument (`screens::message`); the core checks them again. */
export function noteHandlers(core: () => NotesCore | null): ScreensHandlers {
  const started = () => {
    const found = core()
    if (!found) throw new Error('E_SCREENS_UNAVAILABLE')
    return found
  }
  return {
    'note.info': async (args) => {
      const notes = started()
      const id = String(args['noteId'])
      const [note, history, backlinks] = await Promise.all([
        notes.read(id),
        notes.history(id),
        notes.backlinks(id),
      ])
      return {
        ...statsOf(await notes.noteCounts(note.bodyMd)),
        revisions: history.length,
        backlinks: backlinks.map((link) => ({ id: link.id, title: link.title })),
      }
    },
    'note.setDates': async (args) => {
      const createdAt = date(args['createdAt'])
      const updatedAt = date(args['updatedAt'])
      await started().setNoteDates(String(args['noteId']), {
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(updatedAt === undefined ? {} : { updatedAt }),
      })
      return {}
    },
    'note.addTag': async (args) => ({
      tagId: await started().addTag(String(args['noteId']), String(args['name'])),
    }),
  }
}
