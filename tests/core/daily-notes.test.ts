// Today's note (issue #478) on real SQLite: found by title in the daily notebook, else made from the daily template with its
// variables filled, so running it twice in a day gives the same note; a notebook or template that is gone counts as none.
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBookService,
  createClock,
  createIdGenerator,
  createNoteService,
  createTagService,
  createTemplateService,
  dailyTitle,
  DAILY_TITLE_FORMATS,
  findTodaysNote,
  openTodaysNote,
  type DailyNotesSettings,
} from '../../src/core'
import { openSqliteAdapter, type SqliteAdapter } from '../support/sqlite-adapter'
import { tempDir } from '../support/temp-dirs'

// 2026-11-02 10:00 UTC, a Monday; the clock's zone is UTC so the day is the same everywhere.
const AT = Date.UTC(2026, 10, 2, 10)
const UTC = { offsetAt: () => 0, locale: 'en-US' }

const open: SqliteAdapter[] = []
afterEach(() => open.splice(0).forEach((a) => a.close()))

function world() {
  const storage = openSqliteAdapter(join(tempDir('devot-daily-'), 'devot.sqlite'))
  open.push(storage)
  const clock = createClock('mac1')
  const newId = createIdGenerator()
  const notes = createNoteService({ storage, clock, newId, saveDelayMs: 5 })
  const books = createBookService({ storage, clock, newId })
  const tags = createTagService({ storage, clock, newId })
  const templates = createTemplateService({ storage, notes, books, tags, clock, newId })
  const today = (settings: Partial<DailyNotesSettings>, at = AT, create = true) =>
    openTodaysNote({
      notes,
      templates,
      books,
      settings: { dailyNotebook: null, dailyTemplate: null, dailyTitleFormat: 'iso', ...settings },
      at,
      clock: UTC,
      create,
    })
  return { storage, notes, books, templates, today }
}

describe("the day's title", () => {
  it('comes in the three formats offered, in the given zone', () => {
    expect(DAILY_TITLE_FORMATS.map((f) => dailyTitle(f, AT, UTC))).toEqual([
      '2026-11-02',
      '02 Nov 2026',
      'Monday 2 November 2026',
    ])
    // Just before midnight east of UTC is already the next day there.
    expect(dailyTitle('iso', Date.UTC(2026, 10, 2, 23), { offsetAt: () => 120 })).toBe('2026-11-03')
  })

  it('finds the note by exact title, in the daily notebook when one is set', () => {
    const notes = [
      { id: '1', title: '2026-11-02', bookId: 'a' },
      { id: '2', title: '2026-11-02', bookId: 'b' },
      { id: '3', title: '2026-11-02 extra', bookId: 'b' },
    ]
    expect(findTodaysNote(notes, '2026-11-02', 'b')?.id).toBe('2')
    expect(findTodaysNote(notes, '2026-11-02', null)?.id).toBe('1')
    expect(findTodaysNote(notes, '2026-11-02', 'c')).toBeUndefined()
    expect(findTodaysNote(notes, '2026-11-03', null)).toBeUndefined()
  })
})

describe("opening today's note", () => {
  it('makes it once, in the daily notebook, and finds it the next time', async () => {
    const { notes, books, today } = world()
    const journal = await books.create('Journal', null)
    const first = await today({ dailyNotebook: journal })
    expect(first).toEqual({ id: expect.any(String), created: true, bookId: journal })
    const again = await today({ dailyNotebook: journal })
    expect(again).toEqual({ id: first.id, created: false, bookId: journal })
    expect(await notes.read(first.id)).toMatchObject({ title: '2026-11-02', bookId: journal })
    // A note of that title elsewhere is not the one.
    await notes.create('2026-11-02', null)
    expect((await today({ dailyNotebook: journal })).id).toBe(first.id)
    // Another day is another note.
    const tomorrow = await today({ dailyNotebook: journal }, AT + 24 * 60 * 60_000)
    expect(tomorrow.created).toBe(true)
    expect((await notes.read(tomorrow.id)).title).toBe('2026-11-03')
  })

  it('fills the daily template, keeps the daily title and notebook, and goes without a template that is gone', async () => {
    const { notes, books, templates, today } = world()
    const journal = await books.create('Journal', null)
    const elsewhere = await books.create('Elsewhere', null)
    const template = await templates.create('Day {{date}}')
    await notes.setBody(
      template,
      `---\nnotebook: Elsewhere\n---\n# {{date:dddd}}\n\n## Log\n\n## Notes\n`,
    )
    await notes.flush()
    const made = await today({
      dailyNotebook: journal,
      dailyTemplate: template,
      dailyTitleFormat: 'weekdayDayMonthYear',
    })
    expect(made.created).toBe(true)
    const note = await notes.read(made.id)
    expect(note.title).toBe('Monday 2 November 2026')
    expect(note.bookId).toBe(journal)
    expect(note.bodyMd).toBe('# Monday\n\n## Log\n\n## Notes\n')
    expect((await books.list()).some((b) => b.id === elsewhere)).toBe(true)
    expect(
      (
        await today({
          dailyNotebook: journal,
          dailyTemplate: template,
          dailyTitleFormat: 'weekdayDayMonthYear',
        })
      ).id,
    ).toBe(made.id)

    await notes.trash(template)
    const plain = await today({ dailyNotebook: journal, dailyTemplate: template })
    expect(plain.created).toBe(true)
    expect(await notes.read(plain.id)).toMatchObject({ title: '2026-11-02', bodyMd: '' })
  })

  it('makes one note when it is opened twice at once', async () => {
    const { notes, today } = world()
    const [a, b] = await Promise.all([today({}), today({})])
    expect(b.id).toBe(a.id)
    expect([a.created, b.created].sort()).toEqual([false, true])
    expect((await notes.list()).length).toBe(1)
  })

  it('only finds the note while notes may not be changed', async () => {
    const { notes, today } = world()
    await expect(today({}, AT, false)).rejects.toThrow('E_LICENCE_REQUIRED')
    expect(await notes.list()).toEqual([])
    const made = await today({})
    expect(await today({}, AT, false)).toEqual({ ...made, created: false })
  })

  it('finds a note retitled to the day a moment ago, before its title is saved', async () => {
    const { notes, today } = world()
    const id = await notes.create('', null)
    await notes.setTitle(id, '2026-11-02')
    expect(await today({})).toEqual({ id, created: false, bookId: null })
  })

  it('files the note in no notebook when the daily notebook is gone or unset', async () => {
    const { notes, today } = world()
    const made = await today({ dailyNotebook: '01890a5d-ac96-774b-bcce-b302099a8057' })
    expect(made.bookId).toBeNull()
    expect((await notes.read(made.id)).bookId).toBeNull()
    expect((await today({})).id).toBe(made.id)
  })
})
