// Note templates. A template is an ordinary note filed in a reserved notebook, Templates (TEMPLATES_BOOK_ID in books.ts). All Notes, notebooks, search and AI tools
// never show them.
//
// A note made from a template gets:
// - its title from the front matter `title`, else the template's own title;
// - its notebook from `notebook` (a name, or a path such as `Work/Meetings`), else the notebook the window shows;
// - its tags from `tags` (made when missing) and its status from `status`, read as import reads them (import.ts);
// - the template's body with variables filled in and those four keys taken out of the front matter (all of it when nothing else is left);
// - its own copies of the template's images (attachments belong to one note), with the links taking the copies' IDs.
//
// An instruction quote is a blockquote whose first line is a heading starting with `!` (`> # !Instructions`). It stays visible in the template and is removed from
// the note made from it.
//
// Variables: `{{date}}` (YYYY-MM-DD), `{{time}}` (HH:mm), `{{datetime}}`, each with an optional format after a colon (`{{date:dddd, D MMMM}}`, tokens below),
// `{{title}}`, and `{{uuid}}`, a random UUID v4 (the same wherever it appears in one note). Names match in any case; anything else between double braces is left as
// written. Dates use the wall clock of the system's time zone when the note is made; the clock and zone are injectable.

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

export const TEMPLATES_BOOK_NAME = 'Templates'

export const TEMPLATE_KEYS = ['title', 'notebook', 'tags', 'status'] as const

export interface TemplateClock {
  now: number
  offsetAt?: OffsetAt | undefined
  locale?: string | undefined
  uuid?: string | undefined
}

export interface TemplateContext extends TemplateClock {
  title?: string | undefined
}

export interface TemplateDraft {
  title: string
  body: string
  notebook: string | null
  tags: string[]
  status: NoteStatus | null
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|m|ss|s|A|a|Z/g

/** Tokens: YYYY YY, MMMM MMM MM M (name, short name, two digits, number), DD D, dddd ddd, HH H (0-23), hh h (1-12), mm m, ss s, A a (AM/PM, am/pm), Z (+08:00). Text in brackets is kept without the brackets; every other character as written. */
export function formatDate(
  at: number,
  pattern: string,
  options: Pick<TemplateClock, 'offsetAt' | 'locale'> = {},
): string {
  const offset = (options.offsetAt ?? systemOffset)(at)
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

const VARIABLE = /\{\{[ \t]*([A-Za-z]+)[ \t]*(?::([^{}\n]*))?\}\}/g

const DATE_FORMATS: Readonly<Record<string, string>> = {
  date: 'YYYY-MM-DD',
  time: 'HH:mm',
  datetime: 'YYYY-MM-DD HH:mm',
}

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

const INSTRUCTION_START = /^ {0,3}>[ \t]*#{1,6}[ \t]*!/
const QUOTE_LINE = /^ {0,3}>/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

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

/** `existingTitle`: the title of a note that already has one (a template applied to it); `{{title}}` in the body names that note. */
export function draftFromTemplate(
  template: { title: string; body: string },
  clock: TemplateClock,
  existingTitle = '',
): TemplateDraft {
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

/** The first in sidebar order with that name (any case), else the one at that `/`-separated path. */
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
  newId: () => string
  now?: () => number
}

export interface TemplateService {
  list(): Promise<NoteSummary[]>
  listWithNotes(): Promise<{ notes: NoteSummary[]; templates: NoteSummary[] }>
  create(title?: string): Promise<string>
  /** Pending edits to the template are included. Throws E_TEMPLATE_NOT_FOUND for anything but a live template. */
  draft(
    id: string,
    clock: TemplateClock,
    bookId?: string | null,
  ): Promise<TemplateDraft & { bookId: string | null }>
  /** A starter template is read-only: its edit is saved as a new template of the user's own, whose ID is returned. */
  save(id: string, edit: { title?: string; body?: string }): Promise<string>
  /** Keeps what the note has: tags and status stay (the template's tags are added; its status is used only while the note has none), its title unless empty; the template's body goes after the note's text. */
  applyTo(id: string, noteId: string, clock: TemplateClock): Promise<void>
  /** Goes to `bookId` when the template names no notebook that exists, unless that is not one of the user's live notebooks. */
  apply(id: string, clock: TemplateClock, bookId: string | null): Promise<string>
}

export function createTemplateService(options: TemplateServiceOptions): TemplateService {
  const { storage, notes, books, tags, clock, newId } = options
  const now = options.now ?? Date.now

  /** Every device writes the same ID, so their copies merge field by field (newer HLC wins). */
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
      icon: null,
      iconColor: null,
      iconHlc: '',
      sortKey: '',
      sortKeyHlc: '',
    })
  }

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
      // Another note whose save fails must not stop the template; this note's own pending edits still save.
      await notes.flush().catch(() => {})
      const status = (await storage.listNotes()).find((n) => n.id === noteId)?.status ?? 'none'
      const copies = newFileCopies(made.body, newId)
      if (copies.length > 0) await storage.copyFiles(noteId, copies)
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
