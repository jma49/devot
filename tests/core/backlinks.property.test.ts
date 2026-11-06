import fc from 'fast-check'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findBacklinks,
  formatHlc,
  MAX_BACKLINKS,
  noteLinks,
  noteUri,
  TEMPLATES_BOOK_ID,
  type NoteQuery,
  type NoteRecord,
} from '../../src/core'
import { openSqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Backlinks read the link index; they used to be a phrase search for the note's address. Both must
// find the same notes, except where the phrase search broke the rule of what counts as a link
// (docs/specs/markdown-dialect.md, Note links): an address in capitals, or one running on into more ID
// characters (a longer ID, so a link to another note), counted there and counts no more.

const TARGET = '0192a6f0-0000-7000-8000-000000000001'
const OTHER = '0192a6f0-0000-7000-8000-0000000000ff'

const phraseSearch = (id: string): NoteQuery => ({
  text: [{ field: 'body', value: noteUri(id), negate: false }],
  sets: [{ kind: 'book', ids: [TEMPLATES_BOOK_ID], negate: true }],
  pinned: null,
})

const address = `devot://note/${TARGET}`
const fragment = fc.oneof(
  fc.constant(`[Target](${address})`),
  fc.constant(`<${address}>`),
  fc.constant(`![](${address}#half)`),
  fc.constant(`\`${address}\``),
  fc.constant(address.toUpperCase()),
  fc.constant(`DEVOT://NOTE/${TARGET}`),
  fc.constant(`devot://note/${TARGET.toUpperCase()}`),
  fc.constantFrom('0', 'f', '-', 'A', 'g', ')', '?x', '/').map((next) => `${address}${next}`),
  fc.integer({ min: 13, max: address.length - 1 }).map((end) => address.slice(0, end)),
  fc.constant(`[Other](devot://note/${OTHER})`),
  fc.string({ maxLength: 8 }),
)

const note = fc.record({
  fragments: fc.array(fragment, { maxLength: 4 }),
  titleLink: fc.boolean(),
  place: fc.constantFrom('library', 'templates', 'trash', 'self'),
  updatedAt: fc.integer({ min: 0, max: 5 }),
})

describe('backlinks from the link index', () => {
  it('find the notes the phrase search found, but for addresses that are no link', async () => {
    const storage = openSqliteAdapter(join(tempDir('devot-backlinks-property-'), 'devot.sqlite'))
    try {
      await fc.assert(
        fc.asyncProperty(fc.array(note, { maxLength: 10 }), async (generated) => {
          storage.db.exec('DELETE FROM notes; DELETE FROM links')
          const bodies = new Map<string, string>()
          const records = generated.map((g, i): NoteRecord => {
            const id =
              g.place === 'self' ? TARGET : `0192a6f0-0000-7000-9000-${String(i).padStart(12, '0')}`
            const hlc = formatHlc({ wall: i + 1, counter: 0, node: 'prop' })
            const bodyMd = g.fragments.join(' ')
            bodies.set(id, bodyMd)
            return {
              id,
              title: g.titleLink ? address : `Note ${i}`,
              titleHlc: hlc,
              bodyMd,
              ydoc: new Uint8Array([0]),
              bodyVersion: 0,
              bookId: g.place === 'templates' ? TEMPLATES_BOOK_ID : null,
              bookHlc: hlc,
              status: 'none',
              statusHlc: '',
              pinned: false,
              pinnedHlc: '',
              createdAt: i,
              updatedAt: g.updatedAt,
              deletedAt: g.place === 'trash' ? 1 : null,
              deletedHlc: g.place === 'trash' ? hlc : null,
            }
          })
          // Only the first "self" is stored: the target is one note.
          const seen = new Set<string>()
          for (const record of records) {
            if (seen.has(record.id)) continue
            seen.add(record.id)
            await storage.putNote(record)
          }

          const before = (await storage.searchNotes(phraseSearch(TARGET), MAX_BACKLINKS + 1))
            .filter((n) => n.id !== TARGET)
            .map((n) => n.id)
          const found = await findBacklinks(storage, TARGET)
          const now = found.map((n) => n.id)

          const live = (await storage.listNotes()).filter(
            (n) => n.id !== TARGET && n.bookId !== TEMPLATES_BOOK_ID,
          )
          const links = (id: string) => noteLinks(bodies.get(id) ?? '').includes(TARGET)
          expect(now).toEqual(live.filter((n) => links(n.id)).map((n) => n.id))
          expect(before).toEqual(expect.arrayContaining(now))
          for (const dropped of before.filter((id) => !now.includes(id))) {
            expect(links(dropped)).toBe(false)
            expect((bodies.get(dropped) ?? '').toLowerCase()).toContain(address)
          }
        }),
        { numRuns: 100 },
      )
    } finally {
      storage.close()
    }
  })
})
