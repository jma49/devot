// Note templates. A template is an ordinary note (synced, searchable from
// its own view, edited like any note) filed in a reserved notebook,
// Templates (TEMPLATES_BOOK_ID in books.ts). The library leaves templates
// out: All Notes, the notebooks, search and AI tools never show them.
//
// A note made from a template gets:
// - its title from the front matter `title`, else the template's own title;
// - its notebook from `notebook` (a name, or a path such as `Work/Meetings`),
//   else the notebook the window shows (as a new note would);
// - its tags from `tags` (made when missing) and its status from `status`,
//   read as import reads them (import.ts);
// - the template's body with its variables filled in, and those four keys
//   taken out of the front matter (the whole front matter when nothing else
//   is left), so the new note's body holds only what is meant for it;
// - its own copies of the images the template shows (attachments belong to
//   one note, and purging the template would delete them), with the links
//   taking the copies' IDs.
//
// An instruction quote is a blockquote whose first line is a heading that
// starts with `!` (`> # !Instructions`). It explains the template, stays
// visible in the template itself and is removed from the note made from it.
//
// Variables: `{{date}}` (YYYY-MM-DD), `{{time}}` (HH:mm), `{{datetime}}`
// (YYYY-MM-DD HH:mm), each with an optional format after a colon
// (`{{date:dddd, D MMMM}}`, tokens below), `{{title}}`, the new note's
// title, and `{{uuid}}`, a random UUID v4 (the same one wherever it appears
// in one note, a new one for each note made). Names match in any case. Anything else between double braces is
// left as written. Dates are on the wall clock of the system's time zone
// at the moment the note is made; the clock and the zone are injectable.

import { systemOffset, type OffsetAt } from './activity'
import { buildBookTree, flattenBookTree, TEMPLATES_BOOK_ID, type BookService } from './books'
import { errorCode } from './errors'
import { newFileCopies, replaceFileLinks } from './files'
import type { Clock } from './hlc'
import { noteTitle, readFrontMatter, withoutFrontMatterKeys } from './import'
import type { NoteService } from './notes'
import { isStarterTemplate, starterTemplate } from './starterTemplates'
import type { BookRecord, NoteStatus, NoteSummary, StorageAdapter } from './storage'
import { sameName, type TagService } from './tags'
import { lineFeeds } from './text'

/** The stored name of the Templates notebook (the UI shows its own label). */
export const TEMPLATES_BOOK_NAME = 'Templates'

/** Front matter keys that set a new note's defaults and stay out of its body. */
export const TEMPLATE_KEYS = ['title', 'notebook', 'tags', 'status'] as const

/** When a note is made from a template, and how to write the date. */
export interface TemplateClock {
  /** The moment (ms since the epoch). */
  now: number
  /** The time zone's offset; the system's by default. */
  offsetAt?: OffsetAt | undefined
  /** The locale for month and weekday names; English by default. */
  locale?: string | undefined
  /** The UUID for `{{uuid}}`; random (v4) by default. */
  uuid?: string | undefined
}

export interface TemplateContext extends TemplateClock {
  /** The new note's title, for `{{title}}`; left as text when unknown. */
  title?: string | undefined
}

/** What a note made from a template gets (see the rules at the top). */
export interface TemplateDraft {
  title: string
  body: string
  /** The notebook's name or path, as written; null for none. */
  notebook: string | null
  tags: string[]
  status: NoteStatus | null
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

// Longer tokens first, so `MMMM` is not read as `MM` twice.
const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a|Z/g

/**
 * An instant written with a format, on the wall clock of a zone. Tokens:
 * YYYY YY (year), MMMM MMM MM M (month: name, short name, two digits,
 * number), DD D (day), dddd ddd (weekday name, short name), HH H (hour,
 * 0-23), hh h (hour, 1-12), mm m (minute), ss s (second), A a (AM/PM,
 * am/pm), Z (offset, +08:00). Text in brackets is kept as written, without
 * the brackets; every other character too.
 */
export function formatDate(
  at: number,
  pattern: string,
  options: Pick<TemplateClock, 'offsetAt' | 'locale'> = {},
): string {
  const offset = (options.offsetAt ?? systemOffset)(at)
  // The wall clock read through the UTC getters.
  const wall = new Date(at + offset * 60_000)
  const name = (part: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(options.locale ?? 'en-US', { ...part, timeZone: 'UTC' }).format(wall)
  const year = wall.getUTCFullYear()
  const hour = wall.getUTCHours()
  const twelve = hour % 12 || 12
  const sign = offset < 0 ? '-' : '+'
  const values: Record<string, () => string> = {
    YYYY: () => pad(year, 4),
    YY: () => pad(year % 100),
    MMMM: () => name({ month: 'long' }),
    MMM: () => name({ month: 'short' }),
    MM: () => pad(wall.getUTCMonth() + 1),
    M: () => String(wall.getUTCMonth() + 1),
    DD: () => pad(wall.getUTCDate()),
    D: () => String(wall.getUTCDate()),
    dddd: () => name({ weekday: 'long' }),
    ddd: () => name({ weekday: 'short' }),
    HH: () => pad(hour),
    H: () => String(hour),
    hh: () => pad(twelve),
    h: () => String(twelve),
    mm: () => pad(wall.getUTCMinutes()),
    m: () => String(wall.getUTCMinutes()),
    ss: () => pad(wall.getUTCSeconds()),
    s: () => String(wall.getUTCSeconds()),
    A: () => (hour < 12 ? 'AM' : 'PM'),
    a: () => (hour < 12 ? 'am' : 'pm'),
    Z: () => `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`,
  }
  return pattern.replace(TOKEN, (token, literal: string | undefined) =>
    literal !== undefined ? literal : (values[token]?.() ?? token),
  )
}

/** `{{name}}` or `{{name:format}}`, spaces allowed around the name, on one line. */
const VARIABLE = /\{\{[ \t]*([A-Za-z]+)[ \t]*(?::([^{}\n]*))?\}\}/g

const DATE_FORMATS: Readonly<Record<string, string>> = {
  date: 'YYYY-MM-DD',
  time: 'HH:mm',
  datetime: 'YYYY-MM-DD HH:mm',
}

/** `text` with its variables filled in, in one pass (see the rules at the top). */
export function expandTemplate(text: string, context: TemplateContext): string {
  let uuid = context.uuid
  return text.replace(VARIABLE, (whole, rawName: string, format: string | undefined) => {
    const name = rawName.toLowerCase()
    const fallback = DATE_FORMATS[name]
    if (fallback !== undefined) {
      return formatDate(context.now, format?.trim() || fallback, context)
    }
    if (name === 'uuid' && format === undefined) return (uuid ??= crypto.randomUUID())
    if (name === 'title' && format === undefined && context.title !== undefined) {
      return context.title
    }
    return whole
  })
}

/** An instruction quote's first line: `> # !Instructions`. */
const INSTRUCTION_START = /^ {0,3}>[ \t]*#{1,6}[ \t]*!/
const QUOTE_LINE = /^ {0,3}>/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/**
 * `text` without its instruction quotes (see the rules at the top): the
 * quote's lines, and the blank line after it. Ordinary quotes and anything
 * in a code block stay.
 */
export function withoutInstructions(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const mark = FENCE.exec(line)?.[1]
    if (mark !== undefined) {
      if (fence === null) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null
    }
    if (fence === null && !mark && INSTRUCTION_START.test(line)) {
      while (i + 1 < lines.length && QUOTE_LINE.test(lines[i + 1] ?? '')) i += 1
      if (lines[i + 1]?.trim() === '') i += 1
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

/**
 * What a note made from `template` at `clock` gets (see the rules at the top).
 * `existingTitle` is the title of a note that already has one (a template applied
 * to it): `{{title}}` in the body names that note.
 */
export function draftFromTemplate(
  template: { title: string; body: string },
  clock: TemplateClock,
  existingTitle = '',
): TemplateDraft {
  // As import does: a `\r` in a body would put later edits in the wrong place.
  const source = lineFeeds(template.body)
  // One UUID for the whole note, title included.
  const made = { ...clock, uuid: clock.uuid ?? crypto.randomUUID() }
  const own = readFrontMatter(source).title
  const title = noteTitle(
    expandTemplate(own !== null && own.trim() !== '' ? own : template.title, made),
  )
  const body = expandTemplate(withoutInstructions(source), {
    ...made,
    title: existingTitle !== '' ? existingTitle : title,
  })
  const meta = readFrontMatter(body)
  return {
    title,
    body: withoutFrontMatterKeys(body, TEMPLATE_KEYS),
    notebook: meta.notebook,
    tags: meta.tags,
    status: meta.status,
  }
}

/**
 * The notebook a template names: the first in sidebar order with that name
 * (in any case), else the one at that path of names separated by `/`;
 * null for none.
 */
export function resolveNotebook(name: string | null, books: readonly BookRecord[]): string | null {
  const wanted = name?.trim() ?? ''
  if (!wanted) return null
  const tree = buildBookTree(books)
  const named = flattenBookTree(tree).find((node) => sameName(node.name, wanted))
  if (named) return named.id
  const parts = wanted.split('/').map((part) => part.trim())
  let level = tree
  let found: string | null = null
  for (const part of parts) {
    const node = level.find((n) => sameName(n.name, part))
    if (!node) return null
    found = node.id
    level = node.children
  }
  return found
}

export interface TemplateServiceOptions {
  storage: StorageAdapter
  notes: NoteService
  books: BookService
  tags: TagService
  clock: Clock
  /** IDs for the copies of a template's images. */
  newId: () => string
  now?: () => number
}

export interface TemplateService {
  /** Live templates, most recently updated first. */
  list(): Promise<NoteSummary[]>
  /**
   * The live notes (as NoteService.list) and the templates (as list), from
   * one listing.
   */
  listWithNotes(): Promise<{ notes: NoteSummary[]; templates: NoteSummary[] }>
  /** A new, empty template; makes the Templates notebook on first use. */
  create(title?: string): Promise<string>
  /**
   * What a note made from template `id` at `clock` would get (pending edits
   * to the template included), and the notebook it would go to (see
   * apply). Throws E_TEMPLATE_NOT_FOUND for anything but a live template.
   */
  draft(
    id: string,
    clock: TemplateClock,
    bookId?: string | null,
  ): Promise<TemplateDraft & { bookId: string | null }>
  /**
   * Saves an edit of template `id` (its title and/or Markdown body). A
   * starter template is read-only: its edit is saved as a new template of
   * the user's own, whose ID is returned. A template of the user's own is
   * written in place and keeps its ID.
   */
  save(id: string, edit: { title?: string; body?: string }): Promise<string>
  /**
   * Fills note `noteId` from template `id`, keeping what the note has: its
   * tags and status stay (the template's tags are added; its status is used
   * only while the note has none), its title stays unless empty, and the
   * template's body goes after the note's own text (with its own copies
   * of the template's images).
   */
  applyTo(id: string, noteId: string, clock: TemplateClock): Promise<void>
  /**
   * Makes a note from template `id` (see the rules at the top) and returns
   * its ID. It goes to `bookId` when the template names no notebook that
   * exists, unless that is not one of the user's live notebooks.
   */
  apply(id: string, clock: TemplateClock, bookId: string | null): Promise<string>
}

export function createTemplateService(options: TemplateServiceOptions): TemplateService {
  const { storage, notes, books, tags, clock, newId } = options
  const now = options.now ?? Date.now

  /**
   * Writes the Templates notebook unless it is there. Every device writes
   * the same ID, so their copies merge field by field (newer HLC wins).
   */
  const ensureBook = async () => {
    if ((await storage.listBooks()).some((b) => b.id === TEMPLATES_BOOK_ID)) return
    const hlc = clock.tick()
    const at = now()
    await storage.putBook({
      id: TEMPLATES_BOOK_ID,
      name: TEMPLATES_BOOK_NAME,
      nameHlc: hlc,
      parentId: null,
      parentHlc: hlc,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      deletedHlc: null,
      aiAccess: false,
      aiAccessHlc: '',
      sortKey: '',
      sortKeyHlc: '',
    })
  }

  /** What a note made from template `id` gets, and the notebook it goes to. */
  const draft = async (
    id: string,
    at: TemplateClock,
    fallback: string | null = null,
    existingTitle = '',
  ) => {
    const starter = starterTemplate(id)
    const template = starter
      ? { title: starter.title, bodyMd: starter.body, bookId: TEMPLATES_BOOK_ID }
      : await notes.read(id).catch((error: unknown) => {
          // Any other failure keeps its own code.
          if (errorCode(error) === 'E_NOTE_NOT_FOUND') return null
          throw error
        })
    if (template?.bookId !== TEMPLATES_BOOK_ID) throw new Error('E_TEMPLATE_NOT_FOUND')
    const made = draftFromTemplate(
      { title: template.title, body: template.bodyMd },
      at,
      existingTitle,
    )
    const live = await books.list()
    const bookId =
      resolveNotebook(made.notebook, live) ??
      (fallback !== null && live.some((b) => b.id === fallback) ? fallback : null)
    return { ...made, bookId }
  }

  return {
    list: async () =>
      (await storage.listNotes()).filter((note) => note.bookId === TEMPLATES_BOOK_ID),

    async listWithNotes() {
      const library: NoteSummary[] = []
      const templates: NoteSummary[] = []
      for (const note of await storage.listNotes()) {
        ;(note.bookId === TEMPLATES_BOOK_ID ? templates : library).push(note)
      }
      return { notes: library, templates }
    },

    async create(title = '') {
      await ensureBook()
      return notes.create(title, TEMPLATES_BOOK_ID)
    },

    draft,

    async save(id, edit) {
      let target = id
      if (isStarterTemplate(id)) {
        const starter = starterTemplate(id)
        if (!starter) throw new Error('E_TEMPLATE_NOT_FOUND')
        // A starter is never written: the edit goes to a copy.
        await ensureBook()
        target = await notes.create(edit.title ?? starter.title, TEMPLATES_BOOK_ID)
        await notes.setBody(target, edit.body ?? starter.body)
        return target
      }
      if (edit.title !== undefined) await notes.setTitle(target, edit.title)
      if (edit.body !== undefined) await notes.setBody(target, edit.body)
      return target
    },

    async applyTo(id, noteId, at) {
      const note = await notes.read(noteId)
      const made = await draft(id, at, null, note.title)
      // Pending edits written, so the status read is the note's current one.
      await notes.flush()
      const status = (await storage.listNotes()).find((n) => n.id === noteId)?.status ?? 'none'
      // The note gets its own copies of the template's images, as a new note does.
      const copies = newFileCopies(made.body, newId)
      if (copies.length > 0) await storage.copyFiles(noteId, copies)
      // One step on the live note: what was typed meanwhile stays.
      await notes.fill(noteId, { title: made.title, markdown: replaceFileLinks(made.body, copies) })
      if (made.status !== null && made.status !== 'none' && status === 'none') {
        await notes.setStatus(noteId, made.status)
      }
      for (const tag of made.tags) await tags.addToNote(noteId, tag)
    },

    async apply(id, at, fallback) {
      const { bookId, ...made } = await draft(id, at, fallback)
      const noteId = await notes.create(made.title, bookId)
      try {
        const copies = newFileCopies(made.body, newId)
        if (copies.length > 0) await storage.copyFiles(noteId, copies)
        await notes.setBody(noteId, replaceFileLinks(made.body, copies))
        if (made.status !== null && made.status !== 'none') {
          await notes.setStatus(noteId, made.status)
        }
        for (const tag of made.tags) await tags.addToNote(noteId, tag)
      } catch (error) {
        // Leave no half-made note behind.
        await notes
          .trash(noteId)
          .then(() => notes.purge(noteId))
          .catch(() => console.warn('W_TEMPLATE_CLEANUP_FAILED', noteId))
        throw error
      }
      return noteId
    },
  }
}
