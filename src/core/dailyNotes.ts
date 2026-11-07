// Today's note (issue #478): one note a day, found by its title in the daily notebook and made from
// the daily template when it is missing. The settings are this device's (editor settings); a
// notebook or template that is gone counts as none.

import type { BookService } from './books'
import type { NoteService } from './notes'
import type { NoteSummary } from './storage'
import type { DailyTitleFormat } from './dailyTitleFormats'
import { formatDate, type TemplateClock, type TemplateService } from './templates'

export { DAILY_TITLE_FORMATS, type DailyTitleFormat } from './dailyTitleFormats'

const PATTERNS: Readonly<Record<DailyTitleFormat, string>> = {
  iso: 'YYYY-MM-DD',
  dayMonthYear: 'DD MMM YYYY',
  weekdayDayMonthYear: 'dddd D MMMM YYYY',
}

export interface DailyNotesSettings {
  dailyNotebook: string | null
  dailyTemplate: string | null
  dailyTitleFormat: DailyTitleFormat
}

/** The title of the day's note, in this device's time zone: `2026-11-02`, `02 Nov 2026` or `Monday 2 November 2026`. */
export function dailyTitle(
  format: DailyTitleFormat,
  at: number,
  clock: Pick<TemplateClock, 'offsetAt' | 'locale'> = {},
): string {
  return formatDate(at, PATTERNS[format] ?? PATTERNS.iso, clock)
}

type Titled = Pick<NoteSummary, 'id' | 'title' | 'bookId'>

/** The live note titled `title` (after NFC normalisation) in `bookId`, or anywhere when there is no daily notebook; the first listed when several. */
export function findTodaysNote(
  notes: readonly Titled[],
  title: string,
  bookId: string | null,
): Titled | undefined {
  const wanted = title.normalize('NFC')
  return notes.find(
    (note) => note.title.normalize('NFC') === wanted && (bookId === null || note.bookId === bookId),
  )
}

export interface OpenedToday {
  id: string
  created: boolean
  bookId: string | null
}

export interface DailyNotesDeps {
  notes: NoteService
  templates: TemplateService
  books: BookService
  settings: DailyNotesSettings
  at: number
  clock?: Pick<TemplateClock, 'offsetAt' | 'locale'>
  /** False while notes may not be changed (read-only after the trial): a missing note is E_LICENCE_REQUIRED. */
  create?: boolean
}

/** One find-or-create at a time per note service, so two at once cannot both make the day's note. */
const running = new WeakMap<NoteService, Promise<unknown>>()

/**
 * Finds today's note, or makes it: from the daily template with its variables filled (`{{date}}`),
 * else empty, titled for the day and filed in the daily notebook (the template's own notebook does
 * not win here). Running it twice in a day gives the same note.
 */
export function openTodaysNote(deps: DailyNotesDeps): Promise<OpenedToday> {
  const before = running.get(deps.notes) ?? Promise.resolve()
  const next = before.catch(() => undefined).then(() => findOrMake(deps))
  running.set(deps.notes, next)
  return next
}

async function findOrMake(deps: DailyNotesDeps): Promise<OpenedToday> {
  const { notes, templates, books, settings, at } = deps
  const title = dailyTitle(settings.dailyTitleFormat, at, deps.clock)
  const live = await books.list()
  const bookId =
    settings.dailyNotebook !== null && live.some((b) => b.id === settings.dailyNotebook)
      ? settings.dailyNotebook
      : null
  // The list is read from storage: a title typed a moment ago must be there.
  await notes.flush()
  const found = findTodaysNote(await notes.list(), title, bookId)
  if (found) return { id: found.id, created: false, bookId: found.bookId }
  if (deps.create === false) throw new Error('E_LICENCE_REQUIRED')
  const template =
    settings.dailyTemplate !== null &&
    (await templates.list()).some((t) => t.id === settings.dailyTemplate)
      ? settings.dailyTemplate
      : null
  let id: string
  if (template === null) {
    id = await notes.create(title, bookId)
  } else {
    id = await templates.apply(template, { now: at, ...deps.clock }, bookId)
    await notes.setTitle(id, title)
    if ((await notes.read(id)).bookId !== bookId) await notes.setBook(id, bookId)
  }
  await notes.flush()
  return { id, created: true, bookId }
}
