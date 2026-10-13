// A Devot database written the way the app writes it, for devot-mcp tests:
// notebooks with and without Allow AI Access and notes in every state AI
// must never see. Every note mentions "kiwi".
import { join } from 'node:path'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
} from '../../src/core'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

export interface World {
  path: string
  books: { shared: string; inside: string; priv: string; gone: string }
  ids: {
    shared: string
    inside: string
    priv: string
    loose: string
    trashed: string
    purged: string
    orphan: string
  }
}

/** The notes AI must never see, by why. */
export const HIDDEN = ['inside', 'priv', 'loose', 'trashed', 'purged', 'orphan'] as const

export async function makeWorld(): Promise<World> {
  const path = join(tempDir('devot-mcp-'), 'devot.sqlite')
  const storage = openSqliteAdapter(path)
  try {
    const clock = createClock('mac1')
    const newId = createIdGenerator()
    const books = createBookService({ storage, clock, newId })
    const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
    const note = async (title: string, body: string, bookId: string | null) => {
      const id = await notes.create(title, bookId)
      await notes.setBody(id, body)
      await notes.release(id)
      return id
    }
    const shared = await books.create('Shared', null)
    const inside = await books.create('Inside', shared)
    const priv = await books.create('Private', null)
    const gone = await books.create('Gone', null)
    await books.setAiAccess(shared, true)
    await books.setAiAccess(gone, true)
    const ids = {
      shared: await note('Shared kiwi', 'A shared kiwi note.', shared),
      inside: await note('Inside kiwi', 'A kiwi in a sub-notebook.', inside),
      priv: await note('Private kiwi', 'A private kiwi note.', priv),
      loose: await note('Loose kiwi', 'A kiwi in no notebook.', null),
      trashed: await note('Trashed kiwi', 'A kiwi in the trash.', shared),
      purged: await note('Purged kiwi', 'A purged kiwi.', shared),
      orphan: await note('Orphan kiwi', 'A kiwi whose notebook was deleted.', gone),
    }
    await notes.trash(ids.trashed)
    await notes.trash(ids.purged)
    await notes.purge(ids.purged)
    await books.remove(gone)
    return { path, books: { shared, inside, priv, gone }, ids }
  } finally {
    storage.close()
  }
}
