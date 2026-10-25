// What AI tools (devot-mcp, later the in-app assistant) may see and do.
//
// Only notebooks with Allow AI Access on are visible, each on its own (a
// sub-notebook needs its own switch); Templates never is (templates.ts). Their live notes are the only notes
// AI can find or read; trashed notes, notes in no notebook and notes whose
// notebook was deleted never are. Everything else answers as if it did not
// exist, so an error never reveals a hidden note or notebook.
//
// AI writes go through the note service like an import: a body is applied
// to the Yjs document as operations (the text difference), never written as
// a snapshot, so an edit merges with what the app holds of the note. Before
// AI changes an existing note, the body as it was is kept as a version (see
// keepBaseline in notes.ts), so History can bring it back. Each write is
// recorded with its writer in the note's document (authorship.ts, ADR 0007).

import type { Log, WriteField, Writer } from './authorship'
import { buildBookTree, createBookService, flattenBookTree, TEMPLATES_BOOK_ID } from './books'
import type { Clock } from './hlc'
import { UUID_V7 } from './ids'
import { MAX_NOTE_LINKS, noteLinks } from './links'
import { MAX_BODY_BYTES, MAX_TITLE_CHARS } from './noteLimits'
import { createNoteService } from './notes'
import { escapeRegExp, highlightTerms, parseSearch, resolveSearch } from './search'
import {
  MAX_BODY_IDS,
  NOTE_STATUSES,
  type BookRecord,
  type NoteQuery,
  type NoteStatus,
  type NoteSummary,
  type StorageAdapter,
} from './storage'
import { cleanTagName, createTagService, sameName } from './tags'
import { lineFeeds, trimWhitespace } from './text'

export const AI_SEARCH_LIMIT = 20
export const MAX_AI_SEARCH_LIMIT = 50
export const MAX_AI_BODY_BYTES = 1024 * 1024
export const MAX_AI_TAGS = 50
export const MAX_AI_PATCHES = 50
const SNIPPET_RADIUS = 80

export interface AiStorage {
  /** Notes filed directly in one of `bookIds`, as `StorageAdapter.searchNotes`. */
  searchNotesInBooks(
    query: NoteQuery,
    bookIds: readonly string[],
    limit: number,
  ): Promise<(NoteSummary & { bodyMd: string })[]>
  countNotesInBooks(bookIds: readonly string[]): Promise<Map<string, number>>
  noteTags(noteId: string): Promise<{ id: string; name: string }[]>
  /** With how many of those notes each tag is on. */
  tagsInBooks(bookIds: readonly string[]): Promise<{ id: string; name: string; notes: number }[]>
}

/**
 * AiStorage from the plain adapter's calls, for storage without its own
 * (the app's, whose Rust store has no AI queries): the same answers, from
 * the note list and a search narrowed to the notebooks.
 */
export function aiStorageOver(storage: StorageAdapter): AiStorage {
  const liveTags = async () =>
    new Map(
      (await storage.listTags()).filter((t) => t.deletedAt === null).map((t) => [t.id, t.name]),
    )
  const inBooks = async (bookIds: readonly string[]) => {
    const wanted = new Set(bookIds)
    return (await storage.listNotes()).filter((n) => n.bookId !== null && wanted.has(n.bookId))
  }
  return {
    async searchNotesInBooks(query, bookIds, limit) {
      if (bookIds.length === 0) return []
      const found = await storage.searchNotes(
        { ...query, sets: [...query.sets, { kind: 'book', ids: [...bookIds], negate: false }] },
        limit,
      )
      const bodies = new Map<string, string>()
      for (let at = 0; at < found.length; at += MAX_BODY_IDS) {
        const ids = found.slice(at, at + MAX_BODY_IDS).map((n) => n.id)
        for (const body of await storage.getBodies(ids)) bodies.set(body.id, body.bodyMd)
      }
      return found.flatMap(({ excerpt: _excerpt, ...summary }) => {
        const bodyMd = bodies.get(summary.id)
        return bodyMd === undefined ? [] : [{ ...summary, bodyMd }]
      })
    },
    async countNotesInBooks(bookIds) {
      const counts = new Map<string, number>()
      for (const note of await inBooks(bookIds)) {
        counts.set(note.bookId!, (counts.get(note.bookId!) ?? 0) + 1)
      }
      return counts
    },
    async noteTags(noteId) {
      const [notes, tags] = await Promise.all([storage.listNotes(), liveTags()])
      const tagIds = notes.find((n) => n.id === noteId)?.tagIds ?? []
      return tagIds.flatMap((id) => {
        const name = tags.get(id)
        return name === undefined ? [] : [{ id, name }]
      })
    },
    async tagsInBooks(bookIds) {
      const [notes, tags] = await Promise.all([inBooks(bookIds), liveTags()])
      const counts = new Map<string, number>()
      for (const note of notes) {
        for (const id of note.tagIds) counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      return [...counts].flatMap(([id, notes]) => {
        const name = tags.get(id)
        return name === undefined ? [] : [{ id, name, notes }]
      })
    },
  }
}

export interface AiServiceOptions {
  /** Without AiStorage's calls of its own, they are made of the plain ones (aiStorageOver). */
  storage: StorageAdapter & Partial<AiStorage>
  clock: Clock
  newId: () => string
  now?: () => number
  atomically?: <T>(work: () => Promise<T>) => Promise<T>
  /** Who the writes are recorded as (ADR 0007), asked at each write: devot-mcp's client names itself only once it has connected. */
  writer: () => Writer
  /** Info lines, codes and IDs only (see NoteServiceOptions.log). */
  log?: Log
}

export interface AiNotebookRef {
  id: string
  name: string
}

export interface AiNotebook extends AiNotebookRef {
  notes: number
}

export interface AiSearchHit {
  id: string
  title: string
  notebook: AiNotebookRef
  updatedAt: number
  snippet: string
}

export interface AiNote {
  id: string
  title: string
  notebook: AiNotebookRef
  status: NoteStatus
  pinned: boolean
  tags: string[]
  createdAt: number
  updatedAt: number
  markdown: string
}

export interface AiNewNote {
  title: string
  markdown: string
  notebook: string
}

export interface AiPatch {
  find: string
  replace: string
}

export interface AiNoteUpdate {
  id: string
  title?: string
  /** `patches` are applied one after another, each found in the body as the ones before left it. */
  body?: { markdown: string } | { patches: readonly AiPatch[] }
  notebook?: string
  tags?: readonly string[]
  status?: NoteStatus
}

export interface AiTag {
  name: string
  notes: number
}

export interface AiService {
  notebooks(): Promise<AiNotebook[]>
  search(query: string, limit?: number): Promise<AiSearchHit[]>
  /** Any ID that is not a visible note fails with E_NOTE_NOT_FOUND. */
  read(id: string): Promise<AiNote>
  create(input: AiNewNote): Promise<{ id: string; title: string; notebook: AiNotebookRef }>
  /** Keeps the body as it was as a version first; returns the note as it is after the change. */
  update(input: AiNoteUpdate): Promise<AiNote>
  /** Never deletes for good. */
  trash(id: string): Promise<{ id: string; title: string }>
  tags(): Promise<AiTag[]>
  /** At the top level or inside an allowed notebook (ID or exact name). */
  createNotebook(input: { name: string; parent?: string }): Promise<AiNotebookRef>
}

const ELLIPSIS = String.fromCodePoint(0x2026)
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

export function snippet(text: string, terms: readonly string[], radius = SNIPPET_RADIUS): string {
  const pattern = terms
    .filter((t) => t.length > 0)
    .map(escapeRegExp)
    .join('|')
  // Matched in the text itself, so case folding never shifts the position.
  const at = pattern ? Math.max(0, text.search(new RegExp(pattern, 'iu'))) : 0
  let start = Math.max(0, at - radius)
  let end = Math.min(text.length, at + radius)
  if (start > 0 && isLow(text.charCodeAt(start))) start -= 1
  if (end < text.length && isHigh(text.charCodeAt(end - 1))) end += 1
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  if (!body) return ''
  return `${start > 0 ? ELLIPSIS : ''}${body}${end < text.length ? ELLIPSIS : ''}`
}

const notFound = () => new Error('E_NOTE_NOT_FOUND')

function cleanTitle(title: string): string {
  const clean = title.trim()
  if (!clean || /[\r\n]/.test(clean) || [...clean].length > MAX_TITLE_CHARS) {
    throw new Error('E_NOTE_TITLE_INVALID')
  }
  return clean
}

const bytes = (text: string) => new TextEncoder().encode(text).length

/** `limit` is what AI may send as a whole body, or what a note may hold once patched. */
function checkBody(body: string, limit = MAX_AI_BODY_BYTES): void {
  if (bytes(body) > limit) throw new Error('E_NOTE_BODY_TOO_LARGE')
  // The app would refuse to save the note again (E_NOTE_LINKS_TOO_MANY).
  if (noteLinks(body).length > MAX_NOTE_LINKS) throw new Error('E_NOTE_LINKS_TOO_MANY')
}

/** E_AI_PATCH_NOT_FOUND when a patch's text is not in the body as the ones before left it; E_AI_PATCH_AMBIGUOUS when found more than once (overlaps too). */
export function applyPatches(body: string, patches: readonly AiPatch[]): string {
  if (patches.length === 0 || patches.length > MAX_AI_PATCHES) {
    throw new Error('E_AI_PATCHES_INVALID')
  }
  // What AI sends is limited as a whole body is; the note may be larger.
  const sent = patches.reduce((sum, p) => sum + bytes(p.find) + bytes(p.replace), 0)
  if (sent > MAX_AI_BODY_BYTES) throw new Error('E_NOTE_BODY_TOO_LARGE')
  let text = body
  for (const patch of patches) {
    const find = lineFeeds(patch.find)
    if (!find) throw new Error('E_AI_PATCHES_INVALID')
    const at = text.indexOf(find)
    if (at < 0) throw new Error('E_AI_PATCH_NOT_FOUND')
    if (text.indexOf(find, at + 1) >= 0) throw new Error('E_AI_PATCH_AMBIGUOUS')
    text = text.slice(0, at) + lineFeeds(patch.replace) + text.slice(at + find.length)
  }
  return text
}

function cleanTagNames(names: readonly string[]): string[] {
  if (names.length > MAX_AI_TAGS) throw new Error('E_AI_TAGS_TOO_MANY')
  const out: string[] = []
  for (const name of names) {
    const clean = cleanTagName(name)
    if (!out.some((n) => sameName(n, clean))) out.push(clean)
  }
  return out
}

export function createAiService(options: AiServiceOptions): AiService {
  const { storage, clock, newId } = options
  const over = aiStorageOver(storage)
  const aiStorage: AiStorage = {
    searchNotesInBooks: storage.searchNotesInBooks?.bind(storage) ?? over.searchNotesInBooks,
    countNotesInBooks: storage.countNotesInBooks?.bind(storage) ?? over.countNotesInBooks,
    noteTags: storage.noteTags?.bind(storage) ?? over.noteTags,
    tagsInBooks: storage.tagsInBooks?.bind(storage) ?? over.tagsInBooks,
  }
  const now = options.now ?? Date.now
  const atomically = options.atomically ?? (<T>(work: () => Promise<T>) => work())
  // Notes are released after every write, so nothing is cached between
  // calls: the app may change any note meanwhile. History is the app's to
  // compact: a sweep here would run inside the write transaction, holding
  // the database from the app, bucket days in this process's time zone and
  // thin notes AI may not see.
  const notes = createNoteService({
    storage,
    clock,
    newId,
    now,
    compact: false,
    ...(options.log ? { log: options.log } : {}),
  })
  const tagService = createTagService({ storage, clock, newId, now })
  const bookService = createBookService({ storage, clock, newId, now })

  // Templates may carry the switch from a Devot that showed it as a plain
  // notebook; it never counts.
  const allowedOf = (all: readonly BookRecord[]): Map<string, BookRecord> =>
    new Map(
      all.filter((b) => b.aiAccess === true && b.id !== TEMPLATES_BOOK_ID).map((b) => [b.id, b]),
    )
  const allowed = async (live?: readonly BookRecord[]) =>
    allowedOf(live ?? (await storage.listBooks()))

  const ref = (book: BookRecord): AiNotebookRef => ({ id: book.id, name: book.name })

  const resolveBook = async (notebook: string): Promise<BookRecord> => {
    const books = await allowed()
    const byId = books.get(notebook)
    if (byId) return byId
    const named = [...books.values()].filter((b) => b.name === notebook)
    if (named.length > 1) throw new Error('E_BOOK_AMBIGUOUS')
    const [book] = named
    if (!book) throw new Error('E_BOOK_NOT_FOUND')
    return book
  }

  const visible = async (id: string) => {
    if (!UUID_V7.test(id)) throw notFound()
    const record = await storage.getNote(id)
    const book = record?.bookId ? (await allowed()).get(record.bookId) : undefined
    if (!record || !book) throw notFound()
    return { record, book }
  }

  /** Whether setTags would change the note's tags. */
  const tagsChange = async (noteId: string, wanted: readonly string[]) => {
    const current = await aiStorage.noteTags(noteId)
    return (
      current.some((tag) => !wanted.some((name) => sameName(name, tag.name))) ||
      wanted.some((name) => !current.some((tag) => sameName(tag.name, name)))
    )
  }

  /** A name an existing tag has, in any case, puts that tag on the note (tag names are unique). */
  const setTags = async (noteId: string, wanted: readonly string[]) => {
    const current = await aiStorage.noteTags(noteId)
    for (const tag of current) {
      if (!wanted.some((name) => sameName(name, tag.name))) {
        await tagService.removeFromNote(noteId, tag.id)
      }
    }
    const missing = wanted.filter((name) => !current.some((tag) => sameName(tag.name, name)))
    if (missing.length === 0) return
    const all = await tagService.list()
    for (const name of missing) {
      const existing = all.find((tag) => sameName(tag.name, name))
      const tagId = existing?.id ?? (await tagService.ensure(name))
      await tagService.putOnNote(noteId, tagId)
    }
  }

  const service: AiService = {
    async notebooks() {
      const live = await storage.listBooks()
      const books = await allowed(live)
      const counts = await aiStorage.countNotesInBooks([...books.keys()])
      return flattenBookTree(buildBookTree(live)).flatMap((node) => {
        const book = books.get(node.id)
        return book ? [{ ...ref(book), notes: counts.get(book.id) ?? 0 }] : []
      })
    },

    async search(query, limit = AI_SEARCH_LIMIT) {
      const clauses = parseSearch(query)
      if (clauses.length === 0) throw new Error('E_SEARCH_QUERY_EMPTY')
      const [all, tags] = await Promise.all([storage.listBooks(), storage.listTags()])
      const books = allowedOf(all)
      if (books.size === 0) return []
      // `book:` names only notebooks AI may see.
      const resolved = resolveSearch(clauses, { books: all, tags, nameable: [...books.values()] })
      if (!resolved) return []
      const terms = highlightTerms(clauses).body
      const count = Math.min(Math.max(1, Math.floor(limit) || 1), MAX_AI_SEARCH_LIMIT)
      const found = await aiStorage.searchNotesInBooks(resolved, [...books.keys()], count)
      const hits: AiSearchHit[] = []
      for (const summary of found) {
        const book = summary.bookId === null ? undefined : books.get(summary.bookId)
        if (!book) continue
        hits.push({
          id: summary.id,
          title: summary.title,
          notebook: ref(book),
          updatedAt: summary.updatedAt,
          snippet: snippet(summary.bodyMd, terms),
        })
      }
      return hits
    },

    async read(id) {
      const { record, book } = await visible(id)
      const tags = (await aiStorage.noteTags(id))
        .map((t) => t.name)
        .sort((a, b) => a.localeCompare(b))
      return {
        id,
        title: record.title,
        notebook: ref(book),
        status: record.status,
        pinned: record.pinned,
        tags,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        markdown: record.bodyMd,
      }
    },

    async create({ title, markdown, notebook }) {
      const clean = cleanTitle(title)
      const body = lineFeeds(markdown)
      checkBody(body)
      return atomically(async () => {
        const book = await resolveBook(notebook)
        const id = await notes.create(clean, book.id)
        try {
          await notes.agentWrite(id, { writer: options.writer(), markdown: body, created: true })
        } finally {
          await notes.release(id)
        }
        return { id, title: clean, notebook: ref(book) }
      })
    },

    async update({ id, title, body, notebook, tags, status }) {
      if (
        title === undefined &&
        body === undefined &&
        notebook === undefined &&
        tags === undefined &&
        status === undefined
      ) {
        throw new Error('E_AI_UPDATE_EMPTY')
      }
      const newTitle = title === undefined ? undefined : cleanTitle(title)
      if (status !== undefined && !NOTE_STATUSES.includes(status)) {
        throw new Error('E_NOTE_STATUS_INVALID')
      }
      const wantedTags = tags === undefined ? undefined : cleanTagNames(tags)
      if (body !== undefined && 'markdown' in body) checkBody(lineFeeds(body.markdown))
      await atomically(async () => {
        const { record, book } = await visible(id)
        const target = notebook === undefined ? book : await resolveBook(notebook)
        let markdown: string | undefined
        if (body !== undefined) {
          if ('markdown' in body) {
            markdown = lineFeeds(body.markdown)
          } else {
            // Patched as the note's document holds the text, which the
            // edit is the difference from.
            markdown = applyPatches((await notes.read(id)).bodyMd, body.patches)
            checkBody(markdown, MAX_BODY_BYTES)
          }
        }
        const retitled = newTitle !== undefined && newTitle !== record.title
        const moved = target.id !== record.bookId
        const restatused = status !== undefined && status !== record.status
        const retagged = wantedTags !== undefined && (await tagsChange(id, wantedTags))
        const fields: WriteField[] = [
          ...(retitled ? (['title'] as const) : []),
          ...(moved ? (['notebook'] as const) : []),
          ...(retagged ? (['tags'] as const) : []),
          ...(restatused ? (['status'] as const) : []),
        ]
        try {
          await notes.agentWrite(id, {
            writer: options.writer(),
            ...(markdown === undefined ? {} : { markdown }),
            fields,
          })
          if (retitled) await notes.setTitle(id, newTitle)
          if (moved) await notes.setBook(id, target.id)
          if (restatused) await notes.setStatus(id, status)
        } finally {
          await notes.release(id)
        }
        if (wantedTags !== undefined) await setTags(id, wantedTags)
      })
      return service.read(id)
    },

    async trash(id) {
      return atomically(async () => {
        const { record } = await visible(id)
        await notes.agentWrite(id, { writer: options.writer(), fields: ['trash'] })
        await notes.trash(id)
        return { id, title: record.title }
      })
    },

    async tags() {
      const books = await allowed()
      if (books.size === 0) return []
      const found = await aiStorage.tagsInBooks([...books.keys()])
      return found
        .map(({ name, notes: count }) => ({ name, notes: count }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    async createNotebook({ name, parent }) {
      return atomically(async () => {
        const parentBook = parent === undefined ? undefined : await resolveBook(parent)
        const clean = trimWhitespace(name)
        // Notebooks are named in calls by exact name: a second one of a name
        // AI can see would make that name ambiguous.
        if ([...(await allowed()).values()].some((b) => b.name === clean)) {
          throw new Error('E_BOOK_NAME_TAKEN')
        }
        const id = await bookService.create(clean, parentBook?.id ?? null, { aiAccess: true })
        return { id, name: clean }
      })
    },
  }
  return service
}
