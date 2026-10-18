// The first-launch notes. A library that has never held anything gets a
// "Getting started" notebook with a welcome note and a Markdown example,
// once. The window passes the text in (it fills in the app's real key
// bindings), so this file holds the rule alone.
//
// "Once" needs no flag in the database: the notebook and the notes have
// fixed IDs. A library is empty only before the first run (a note the user
// deleted is in the Trash, where it still counts; one purged for good keeps
// its ID, and a purged note is never written again), and a device that syncs
// in later writes the same IDs, so the copies merge field by field.

import { TEMPLATES_BOOK_ID } from './books'
import { createNoteService } from './notes'
import type { Clock } from './hlc'
import type { StorageAdapter } from './storage'

/** The notebook the first-launch notes are filed in. */
export const WELCOME_BOOK_ID = '00000000-0000-7000-8000-000000000010'

/** One first-launch note; `id` is fixed, so the note exists once per library. */
export interface WelcomeNote {
  id: string
  title: string
  body: string
  pinned?: boolean
  /** Pictures the body shows; each is stored under its fixed ID. */
  files?: readonly { id: string; name: string; data: Uint8Array }[]
}

export interface WelcomeContent {
  bookName: string
  /** In the order they should show (the first is the one to open). */
  notes: readonly WelcomeNote[]
}

export interface WelcomeOptions {
  storage: StorageAdapter
  clock: Clock
  /** Makes the IDs of everything but the fixed ones (versions). */
  newId: () => string
  now?: () => number
  content: WelcomeContent
}

/**
 * Whether the library has never held anything: no live note, no note in the
 * Trash and no notebook (the Templates notebook, made on demand, is not the
 * user's).
 */
async function isEmptyLibrary(storage: StorageAdapter): Promise<boolean> {
  const [notes, trash, books] = await Promise.all([
    storage.listNotes(),
    storage.listTrash(),
    storage.listBooks(),
  ])
  return (
    notes.every((n) => n.bookId === TEMPLATES_BOOK_ID) &&
    trash.length === 0 &&
    books.every((b) => b.id === TEMPLATES_BOOK_ID)
  )
}

/**
 * Writes the first-launch notes into an empty library. Resolves to the ID of
 * the note to open first, or null when the library is not empty (nothing is
 * written).
 */
export async function seedWelcome(options: WelcomeOptions): Promise<string | null> {
  const { storage, clock, content } = options
  const now = options.now ?? Date.now
  if (!(await isEmptyLibrary(storage))) return null

  const hlc = clock.tick()
  const at = now()
  await storage.putBook({
    id: WELCOME_BOOK_ID,
    name: content.bookName,
    nameHlc: hlc,
    parentId: null,
    parentHlc: hlc,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    deletedHlc: null,
    aiAccess: false,
    aiAccessHlc: '',
    icon: null,
    iconColor: null,
    iconHlc: '',
    sortKey: '',
    sortKeyHlc: '',
  })

  // A note service whose next ID is the note's fixed one (a note takes its
  // ID first when it is made).
  const fixed: string[] = []
  const notes = createNoteService({
    storage,
    clock,
    newId: () => fixed.shift() ?? options.newId(),
    compact: false,
  })
  for (const note of content.notes) {
    fixed.push(note.id)
    const id = await notes.create(note.title, WELCOME_BOOK_ID)
    await notes.setBody(id, note.body)
    for (const file of note.files ?? []) {
      await storage.putFile({ id: file.id, noteId: id, name: file.name }, file.data)
    }
    if (note.pinned) await notes.setPinned(id, true)
    await notes.release(id)
  }
  return content.notes[0]?.id ?? null
}
