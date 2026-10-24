// The first-launch notes: a library that has never held anything gets a "Getting started" notebook with a welcome note and a Markdown example, once. The window
// passes the text in (it fills in the app's real key bindings), so this file holds the rule alone.
//
// "Once" needs no flag in the database: the notebook and notes have fixed IDs. A library is empty only before the first run (a deleted note is in the Trash, where it
// still counts; a purged one keeps its ID and is never written again), and a device that syncs in later writes the same IDs, so the copies merge field by field.
// Each body is seeded as the same Yjs state on every device (`NoteService.seed`), so the bodies merge as one; a device whose build seeded another text keeps both.

import { TEMPLATES_BOOK_ID } from './books'
import { createNoteService } from './notes'
import type { Clock } from './hlc'
import type { StorageAdapter } from './storage'

export const WELCOME_BOOK_ID = '00000000-0000-7000-8000-000000000010'

export interface WelcomeNote {
  id: string
  title: string
  body: string
  pinned?: boolean
  files?: readonly { id: string; name: string; data: Uint8Array }[]
}

export interface WelcomeContent {
  bookName: string
  notes: readonly WelcomeNote[]
}

export interface WelcomeOptions {
  storage: StorageAdapter
  clock: Clock
  newId: () => string
  now?: () => number
  content: WelcomeContent
}

/** The Templates notebook, made on demand, is not the user's. */
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

  const notes = createNoteService({ storage, clock, newId: options.newId, compact: false })
  for (const note of content.notes) {
    const { id } = note
    await notes.seed(id, note.title, WELCOME_BOOK_ID, note.body)
    for (const file of note.files ?? []) {
      await storage.putFile({ id: file.id, noteId: id, name: file.name }, file.data)
    }
    if (note.pinned) await notes.setPinned(id, true)
    await notes.release(id)
  }
  return content.notes[0]?.id ?? null
}
