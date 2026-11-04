// The link index (`links`): every save replaces the note's rows with the links its body holds.
// The docs set no budget for it; the budget is a baseline measured on a Linux runner with room for
// a busy machine, and the growth check needs no machine speed.
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { formatHlc, MAX_NOTE_LINKS, noteLink, noteLinks, type NoteRecord } from '../../src/core'
import { expectWithinBudget } from '../support/budget'
import { expectLinearGrowth, fourfoldGrowth } from '../support/growth'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

const noteId = (i: number) => `0192a6f0-0000-7000-8000-${String(i).padStart(12, '0')}`

/** A list of `count` note links, a line each, with a word of text between. */
const linkList = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i) => `- ${noteLink(`Note ${i}`, noteId(from + i))} next`).join(
    '\n',
  )

describe('the link index', { timeout: 120_000 }, () => {
  let storage: SqliteAdapter | undefined
  afterAll(() => storage?.close())

  it('reads the links of a body in time linear in its length', (context) => {
    const growth = fourfoldGrowth((count) => {
      const body = linkList(count)
      return () => {
        expect(noteLinks(body)).toHaveLength(count)
      }
    }, 2500)
    expectLinearGrowth(context, growth)
  })

  // An index note at the limit: each save of it rewrites all of its rows. Measured 105 ms on a busy
  // Linux runner (load 18 on 4 cores) for 10,000 links, the body's trigram index entry included.
  it(`saves a note of ${MAX_NOTE_LINKS} links, one changed, in under 150 ms`, async (context) => {
    storage = openSqliteAdapter(join(tempDir('devot-links-bench-'), 'devot.sqlite'))
    const hlc = formatHlc({ wall: 1, counter: 0, node: 'bench' })
    let note: NoteRecord = {
      id: noteId(MAX_NOTE_LINKS + 1),
      title: 'Index',
      titleHlc: hlc,
      bodyMd: linkList(MAX_NOTE_LINKS),
      ydoc: new Uint8Array([0]),
      bodyVersion: 0,
      bookId: null,
      bookHlc: '',
      status: 'none',
      statusHlc: '',
      pinned: false,
      pinnedHlc: '',
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      deletedHlc: null,
    }
    await storage.putNote(note)
    note = { ...note, bodyVersion: 1 }
    const times: number[] = []
    for (let round = 0; round < 7; round += 1) {
      note = {
        ...note,
        bodyMd: `${linkList(MAX_NOTE_LINKS - 1)}\n- ${noteLink('Changed', noteId(2 * MAX_NOTE_LINKS + round))}`,
      }
      const start = performance.now()
      await storage.putNote(note)
      times.push(performance.now() - start)
      note = { ...note, bodyVersion: note.bodyVersion + 1 }
    }
    const rows = storage.db
      .prepare('SELECT count(*) AS n FROM links WHERE source_id = ?')
      .get(note.id) as { n: number }
    expect(rows.n).toBe(MAX_NOTE_LINKS)
    expectWithinBudget(context, times.sort((a, b) => a - b)[3]!, 150)
  })
})
