// The first-launch notes: a library that has never held anything gets a "Getting started" notebook with a welcome note and a Markdown example, once. The window
// passes the text in (it fills in the app's real key bindings), so this file holds the rule alone.
//
// "Once" needs no flag in the database: the notebook and notes have fixed IDs. A library is empty only before the first run (a deleted note is in the Trash, where it
// still counts; a purged one keeps its ID and is never written again), and a device that syncs in later writes the same IDs, so the copies merge field by field.
// Each body is seeded as the same Yjs state on every device (`seedState`), so the bodies merge as one; a device whose build seeded another text keeps both.
// Storage writes the seed in one call (`StorageAdapter.seedWelcome`): the app's store writes its own bundled copy whatever the licence, so a locked library takes these notes and nothing else.

import { TEMPLATES_BOOK_ID } from './books'
import { clipTitle } from './noteLimits'
import { seedState } from './notes'
import { lineFeeds } from './text'
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

/** What `StorageAdapter.seedWelcome` writes: every field stamped with `hlc`, every date `at`. */
export interface WelcomeSeed {
  hlc: string
  at: number
  bookName: string
  notes: readonly { id: string; title: string; bodyMd: string; ydoc: Uint8Array; pinned: boolean }[]
  files: readonly { id: string; noteId: string; name: string; data: Uint8Array }[]
}

export interface WelcomeOptions {
  storage: StorageAdapter
  clock: Clock
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

export function welcomeSeed(content: WelcomeContent, hlc: string, at: number): WelcomeSeed {
  return {
    hlc,
    at,
    bookName: content.bookName,
    notes: content.notes.map((note) => ({
      id: note.id,
      title: clipTitle(note.title),
      bodyMd: lineFeeds(note.body),
      ydoc: seedState(note.id, note.body),
      pinned: note.pinned ?? false,
    })),
    files: content.notes.flatMap((note) =>
      (note.files ?? []).map((file) => ({ ...file, noteId: note.id })),
    ),
  }
}

/** `StorageAdapter.seedWelcome` for the stores in TypeScript, which check no licence: the seed's records through its own writes, if the library is empty. */
export async function writeWelcomeSeed(
  storage: StorageAdapter,
  seed: WelcomeSeed,
): Promise<boolean> {
  if (!(await isEmptyLibrary(storage))) return false
  const { hlc, at } = seed
  await storage.putBook({
    id: WELCOME_BOOK_ID,
    name: seed.bookName,
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
  for (const note of seed.notes) {
    await storage.putNote({
      id: note.id,
      title: note.title,
      titleHlc: hlc,
      bodyMd: note.bodyMd,
      ydoc: note.ydoc,
      bodyVersion: 0,
      bookId: WELCOME_BOOK_ID,
      bookHlc: hlc,
      status: 'none',
      statusHlc: '',
      pinned: note.pinned,
      pinnedHlc: note.pinned ? hlc : '',
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      deletedHlc: null,
      agentWrites: [],
    })
  }
  for (const file of seed.files) {
    await storage.putFile({ id: file.id, noteId: file.noteId, name: file.name }, file.data)
  }
  return true
}

export async function seedWelcome(options: WelcomeOptions): Promise<string | null> {
  const { storage, clock, content } = options
  const now = options.now ?? Date.now
  const seeded = await storage.seedWelcome(welcomeSeed(content, clock.tick(), now()))
  return seeded ? (content.notes[0]?.id ?? null) : null
}
