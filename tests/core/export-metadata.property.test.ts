import fc from 'fast-check'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  charCount,
  clipTitle,
  exportHeader,
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  fileStem,
  importMarkdown,
  markdownFile,
  MAX_TAG_NAME_CHARS,
  NOTE_STATUSES,
  sameName,
  trimWhitespace,
  type NoteStatus,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// Markdown export then import gives the same note: its title (exactly, as
// stored), tags (case included) and status, whatever characters they hold
// and whatever front matter the note has of its own, and its body (a note
// with front matter of its own comes back with the keys export set in it,
// and exporting it again gives the same file).

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

const dir = tempDir('devot-export-metadata-')
let libraries = 0

/** Imports one exported file into a new library: the note it made. */
async function importOne(fileName: string, text: string) {
  libraries += 1
  const sqlite = openSqliteAdapter(join(dir, `${libraries}.sqlite`))
  open.push(sqlite)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const services = {
    notes: createNoteService({ storage: sqlite, clock, newId, saveDelayMs: 5 }),
    books: createBookService({ storage: sqlite, clock, newId }),
    tags: createTagService({ storage: sqlite, clock, newId }),
  }
  const report = await importMarkdown({
    ...services,
    newId,
    scan: { id: 1, name: 'Folder', files: [fileName], skipped: [] },
    source: {
      read: async () => text,
      attach: async () => Promise.reject(new Error('E_IMPORT_FILE_NOT_FOUND')),
    },
  })
  const [summary] = await sqlite.listNotes()
  const tagNames = new Map((await sqlite.listTags()).map((t) => [t.id, t.name]))
  const record = summary ? await sqlite.getNote(summary.id) : null
  return {
    notes: report.notes,
    title: summary?.title,
    tags: (summary?.tagIds ?? []).map((id) => tagNames.get(id)).sort(),
    status: summary?.status,
    body: record?.bodyMd,
  }
}

// Written as code points: separators, spaces of other kinds, controls, a
// byte order mark, a composed and a decomposed accent, an emoji.
const chars = (...codes: number[]) => codes.map((c) => String.fromCodePoint(c))
const SPECIAL = chars(
  0x2028,
  0x2029,
  0x85,
  0xa0,
  0x3000,
  0x200b,
  0xfeff,
  0x1,
  0x9,
  0x7f,
  0xe9,
  0x301,
  0xdf,
  0x1f600,
)
const PIECES = [
  ...SPECIAL,
  ' ',
  '  ',
  "'",
  '"',
  '\\',
  '#',
  ':',
  ',',
  '[',
  ']',
  '{',
  '}',
  '-',
  '---',
  '|',
  '>',
  '&',
  '*',
  '%',
  '`',
  'a',
  'b',
  'Work',
  'work',
  'title: x',
  '# Devot metadata',
]
const CR = String.fromCodePoint(0xd)

const text = (maxLength: number, pieces: readonly string[] = PIECES) =>
  fc.array(fc.constantFrom(...pieces), { maxLength }).map((parts) => parts.join(''))

// A title as stored: one line, within the limit (a carriage return reads
// as a space, as it does in the title field).
const title = text(8, [...PIECES, CR]).map(clipTitle)

// Tag names as the tag service keeps them: trimmed, on one line, each a
// different tag (names match in any case).
const tag = text(4)
  .map(trimWhitespace)
  .filter((t) => t !== '' && !/[\r\n]/.test(t) && charCount(t) <= MAX_TAG_NAME_CHARS)
const tags = fc
  .uniqueArray(tag, {
    maxLength: 4,
    comparator: (a, b) => sameName(a, b) || a.toLowerCase() === b.toLowerCase(),
  })
  .map((list) => [...list].sort())

const status = fc.constantFrom<NoteStatus>(...NOTE_STATUSES)

// A body as stored (no carriage returns), with or without front matter of
// its own, which may say a title, tags or anything else, or start the way
// Devot's own block does.
const ownMatter = fc.record({
  header: fc.boolean(),
  title: fc.option(text(4)),
  tags: fc.option(fc.array(text(3), { maxLength: 3 })),
  other: fc.boolean(),
})
const body = fc
  .tuple(fc.option(ownMatter), fc.option(text(4)), fc.array(text(6), { maxLength: 3 }))
  .map(([matter, heading, lines]) => {
    const head: string[] = []
    if (matter) {
      head.push('---')
      if (matter.header) head.push('# Devot metadata')
      if (matter.title !== null) head.push(`title: ${matter.title}`)
      if (matter.tags !== null) head.push(`tags: [${matter.tags.join(', ')}]`)
      if (matter.other) head.push('author: me')
      head.push('---')
    }
    if (heading !== null) head.push(`# ${heading}`, '')
    return [...head, ...lines, ''].join('\n')
  })

describe('Markdown export then import', () => {
  it('gives the same title, tags, status and body', async () => {
    await fc.assert(
      fc.asyncProperty(fc.record({ title, tags, status, bodyMd: body }), async (entry) => {
        const fileName = `${fileStem(entry.title, 'Untitled')}.md`
        const file = markdownFile(entry, fileName, new Map())
        const back = await importOne(fileName, file)
        const devot = exportHeader(file)
        expect(back).toEqual({
          notes: 1,
          title: entry.title,
          tags: entry.tags,
          status: entry.status,
          body: devot ? devot.body : file,
        })
        // Devot's block leaves the body as it was; front matter of the
        // note's own changes only in the keys export set in it, after
        // which they agree.
        expect(devot?.body ?? entry.bodyMd).toBe(entry.bodyMd)
        expect(markdownFile({ ...entry, bodyMd: back.body! }, fileName, new Map())).toBe(file)
      }),
      { numRuns: 100 },
    )
  }, 60_000)
})
