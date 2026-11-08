import type { NoteStatus, NoteSummary, TagRecord } from '../../../../core'
import type { NoteCounts } from '../../../../core/noteCounts'
import { noteFrontMatter } from '../../../../core/noteFacts'
import { TEMPLATES_BOOK_ID } from '../../../../core/templatesBook'
import { t } from '../../i18n'
import { frontMatterChange, tagChanges } from '../../preview/frontMatterApply'
import { previewNote } from '../../preview/Preview'
import { statsOf } from '../noteStats'
import type { ScreensHandlers } from './ops'

/** What Note Info and the tags picker ask of the core (docs/specs/iphone-screens.md, Operations). */
export interface NotesCore {
  readonly read: (id: string) => Promise<{ title: string; bodyMd: string }>
  readonly noteCounts: (markdown: string) => Promise<NoteCounts> | NoteCounts
  readonly history: (id: string) => Promise<readonly unknown[]>
  readonly backlinks: (id: string) => Promise<readonly { id: string; title: string }[]>
  readonly setNoteDates: (
    id: string,
    dates: { createdAt?: number; updatedAt?: number },
  ) => Promise<unknown>
  readonly addTag: (noteId: string, name: string) => Promise<string>
  readonly removeTag: (noteId: string, tagId: string) => Promise<unknown>
  readonly setTitle: (id: string, title: string) => Promise<unknown>
  readonly setStatus: (id: string, status: NoteStatus) => Promise<unknown>
}

/** The page's list of notes and tags, which the front matter is compared with. */
export interface NotesLibrary {
  readonly note: (id: string) => NoteSummary | undefined
  readonly tags: readonly TagRecord[]
  readonly refresh: () => Promise<unknown>
}

const argsInvalid = () => new Error('E_SCREENS_ARGS_INVALID')

const date = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined)

/** Rust has checked every argument (`screens::message`); the core checks them again. */
export function noteHandlers(
  core: () => NotesCore | null,
  library: () => NotesLibrary,
): ScreensHandlers {
  const started = () => {
    const found = core()
    if (!found) throw new Error('E_SCREENS_UNAVAILABLE')
    return found
  }
  const ownTags = (id: string) => {
    const { note, tags } = library()
    const ids = note(id)?.tagIds ?? []
    return tags.filter((tag) => ids.includes(tag.id))
  }
  /** Templates keep their front matter as written: nothing in it is the note's to apply. */
  const fields = (id: string, title: string) => {
    const found = library().note(id)
    if (!found || found.bookId === TEMPLATES_BOOK_ID) return undefined
    return previewNote({
      title,
      status: found.status,
      tags: ownTags(id).map((tag) => tag.name),
      tagColors: library().tags.flatMap(({ name, color }) => (color ? [{ name, color }] : [])),
      canApply: true,
    })
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
        frontMatter: noteFrontMatter(note.bodyMd, fields(id, note.title), t('note.untitled')),
      }
    },
    'note.applyFrontMatter': async (args) => {
      const notes = started()
      const id = String(args['noteId'])
      const change = frontMatterChange(String(args['field']), String(args['value']))
      if (!change) throw argsInvalid()
      if (change.field === 'title') await notes.setTitle(id, change.value)
      else if (change.field === 'status') await notes.setStatus(id, change.value)
      else {
        const { add, remove } = tagChanges(ownTags(id), change.value)
        for (const name of add) await notes.addTag(id, name)
        for (const tagId of remove) await notes.removeTag(id, tagId)
        await library().refresh()
      }
      return {}
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
