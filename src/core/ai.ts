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
// keepBaseline in notes.ts), so History can bring it back.

import { buildBookTree, createBookService, flattenBookTree, TEMPLATES_BOOK_ID } from './books'
import type { Clock } from './hlc'
import { UUID_V7 } from './ids'
import { MAX_NOTE_LINKS, noteLinks } from './links'
import { MAX_TITLE_CHARS } from './noteLimits'
import { createNoteService } from './notes'
import { escapeRegExp, highlightTerms, parseSearch, resolveSearch } from './search'
import {
  NOTE_STATUSES,
  type BookRecord,
  type NoteQuery,
  type NoteStatus,
  type NoteSummary,
  type StorageAdapter,
} from './storage'
import { createTagService, MAX_TAG_NAME_CHARS, sameName } from './tags'
import { charCount, lineFeeds, trimWhitespace } from './text'

export const AI_SEARCH_LIMIT = 20
export const MAX_AI_SEARCH_LIMIT = 50
/** UTF-8 bytes; generous for any note an assistant writes in one call. */
export const MAX_AI_BODY_BYTES = 1024 * 1024
/** The most tags one update may give a note. */
export const MAX_AI_TAGS = 50
/** The most passages one update may replace. */
export const MAX_AI_PATCHES = 50
const SNIPPET_RADIUS = 80

/** Queries scoped to a few notebooks or one note, which AI needs from storage. */
export interface AiStorage {
  /**
   * Live notes filed directly in one of `bookIds` that meet `query` (as
   * `StorageAdapter.searchNotes`), best first, with their Markdown.
   */
  searchNotesInBooks(
    query: NoteQuery,
    bookIds: readonly string[],
    limit: number,
  ): Promise<(NoteSummary & { bodyMd: string })[]>
  /** How many live notes are filed directly in each of `bookIds`. */
  countNotesInBooks(bookIds: readonly string[]): Promise<Map<string, number>>
  /** The live tags on a note. */
  noteTags(noteId: string): Promise<{ id: string; name: string }[]>
  /**
   * The live tags on live notes filed directly in one of `bookIds`, each
   * with how many of those notes it is on.
   */
  tagsInBooks(bookIds: readonly string[]): Promise<{ id: string; name: string; notes: number }[]>
}

export interface AiServiceOptions {
  storage: StorageAdapter & AiStorage
  /** A clock with the AI client's own node ID. */
  clock: Clock
  newId: () => string
  now?: () => number
  /** Runs a write so it lands whole or not at all (storage transaction). */
  atomically?: <T>(work: () => Promise<T>) => Promise<T>
}

export interface AiNotebookRef {
  id: string
  name: string
}

export interface AiNotebook extends AiNotebookRef {
  /** Live notes filed directly in it. */
  notes: number
}

export interface AiSearchHit {
  id: string
  title: string
  notebook: AiNotebookRef
  updatedAt: number
  /** The body around the first match, on one line. */
  snippet: string
}

export interface AiNote {
  id: string
  title: string
  notebook: AiNotebookRef
  status: NoteStatus
  pinned: boolean
  /** Tag names, sorted. */
  tags: string[]
  createdAt: number
  updatedAt: number
  /** The Markdown snapshot of the body. */
  markdown: string
}

export interface AiNewNote {
  title: string
  markdown: string
  /** An allowed notebook's ID or exact name. */
  notebook: string
}

/** One passage to replace: `find` must occur exactly once in the body. */
export interface AiPatch {
  find: string
  replace: string
}

/** What to change in a note; fields left out stay as they are. */
export interface AiNoteUpdate {
  id: string
  title?: string
  /**
   * The new body: the whole Markdown (`markdown`), or passages replaced one
   * after another (`patches`), each found in the body as the ones before
   * left it.
   */
  body?: { markdown: string } | { patches: readonly AiPatch[] }
  /** An allowed notebook's ID or exact name to move the note to. */
  notebook?: string
  /** The note's tags from now on, by name; a name no tag has yet becomes a tag. */
  tags?: readonly string[]
  status?: NoteStatus
}

export interface AiTag {
  name: string
  /** Visible notes that carry it. */
  notes: number
}

export interface AiService {
  /** Notebooks AI may use, in the sidebar's order. */
  notebooks(): Promise<AiNotebook[]>
  /** Visible notes matching a search query (as in the app), best first. */
  search(query: string, limit?: number): Promise<AiSearchHit[]>
  /** A visible note; any other ID fails with E_NOTE_NOT_FOUND. */
  read(id: string): Promise<AiNote>
  /** Creates a note in an allowed notebook. */
  create(input: AiNewNote): Promise<{ id: string; title: string; notebook: AiNotebookRef }>
  /**
   * Changes a visible note, keeping its body as it was as a version first.
   * Returns the note as it is after the change.
   */
  update(input: AiNoteUpdate): Promise<AiNote>
  /** Moves a visible note to the Trash (never deletes it for good). */
  trash(id: string): Promise<{ id: string; title: string }>
  /** The tags on visible notes, by name. */
  tags(): Promise<AiTag[]>
  /**
   * Creates a notebook with Allow AI Access on, at the top level or inside
   * an allowed notebook (ID or exact name).
   */
  createNotebook(input: { name: string; parent?: string }): Promise<AiNotebookRef>
}

const ELLIPSIS = String.fromCodePoint(0x2026)
const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

/**
 * About `radius` characters of `text` on each side of the first term found
 * (case-insensitive), or its start when none is; whitespace runs become one
 * space, and cut ends get an ellipsis.
 */
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

/** A title AI gives a note, trimmed; E_NOTE_TITLE_INVALID unless one line of 1 to MAX_TITLE_CHARS. */
function cleanTitle(title: string): string {
  const clean = title.trim()
  if (!clean || /[\r\n]/.test(clean) || [...clean].length > MAX_TITLE_CHARS) {
    throw new Error('E_NOTE_TITLE_INVALID')
  }
  return clean
}

/** Throws unless the app could save `body` (size, note links). */
function checkBody(body: string): void {
  if (new TextEncoder().encode(body).length > MAX_AI_BODY_BYTES) {
    throw new Error('E_NOTE_BODY_TOO_LARGE')
  }
  // The app would refuse to save the note again (E_NOTE_LINKS_TOO_MANY).
  if (noteLinks(body).length > MAX_NOTE_LINKS) throw new Error('E_NOTE_LINKS_TOO_MANY')
}

/**
 * `body` with each patch applied in turn. A patch whose text is not in the
 * body as the ones before left it fails with E_AI_PATCH_NOT_FOUND; one
 * found more than once (overlaps too) with E_AI_PATCH_AMBIGUOUS.
 */
export function applyPatches(body: string, patches: readonly AiPatch[]): string {
  if (patches.length === 0 || patches.length > MAX_AI_PATCHES) {
    throw new Error('E_AI_PATCHES_INVALID')
  }
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

/**
 * Tag names as given, trimmed, each once (names that differ only in case are
 * one); E_TAG_NAME_INVALID for a name the app would refuse.
 */
function cleanTagNames(names: readonly string[]): string[] {
  if (names.length > MAX_AI_TAGS) throw new Error('E_AI_TAGS_TOO_MANY')
  const out: string[] = []
  for (const name of names) {
    const clean = trimWhitespace(name)
    // As the tag service checks it, before anything is written.
    if (!clean || /[\r\n]/.test(clean) || charCount(clean) > MAX_TAG_NAME_CHARS) {
      throw new Error('E_TAG_NAME_INVALID')
    }
    if (!out.some((n) => sameName(n, clean))) out.push(clean)
  }
  return out
}

export function createAiService(options: AiServiceOptions): AiService {
  const { storage, clock, newId } = options
  const now = options.now ?? Date.now
  const atomically = options.atomically ?? (<T>(work: () => Promise<T>) => work())
  // Notes are released after every write, so nothing is cached between
  // calls: the app may change any note meanwhile. History is the app's to
  // compact: a sweep here would run inside the write transaction, holding
  // the database from the app, bucket days in this process's time zone and
  // thin notes AI may not see.
  const notes = createNoteService({ storage, clock, newId, now, compact: false })
  const tagService = createTagService({ storage, clock, newId, now })
  const bookService = createBookService({ storage, clock, newId, now })

  // Templates may carry the switch from a Devot that showed it as a plain
  // notebook; it never counts.
  const allowedOf = (all: readonly BookRecord[]): Map<string, BookRecord> =>
    new Map(
      all.filter((b) => b.aiAccess === true && b.id !== TEMPLATES_BOOK_ID).map((b) => [b.id, b]),
    )
  /** The notebooks AI may use, from `live` (every live notebook) when given. */
  const allowed = async (live?: readonly BookRecord[]) =>
    allowedOf(live ?? (await storage.listBooks()))

  const ref = (book: BookRecord): AiNotebookRef => ({ id: book.id, name: book.name })

  /** The allowed notebook an ID or exact name names. */
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

  /** The stored note and its notebook, when AI may see it; else E_NOTE_NOT_FOUND. */
  const visible = async (id: string) => {
    if (!UUID_V7.test(id)) throw notFound()
    const record = await storage.getNote(id)
    const book = record?.bookId ? (await allowed()).get(record.bookId) : undefined
    if (!record || !book) throw notFound()
    return { record, book }
  }

  /** Makes the note's tags exactly `names` (see AiNoteUpdate.tags). */
  const setTags = async (noteId: string, names: readonly string[]) => {
    const wanted = cleanTagNames(names)
    const current = await storage.noteTags(noteId)
    for (const tag of current) {
      if (!wanted.some((name) => sameName(name, tag.name))) {
        await tagService.removeFromNote(noteId, tag.id)
      }
    }
    for (const name of wanted) {
      if (!current.some((tag) => sameName(tag.name, name))) await tagService.addToNote(noteId, name)
    }
  }

  const service: AiService = {
    async notebooks() {
      const live = await storage.listBooks()
      const books = await allowed(live)
      const counts = await storage.countNotesInBooks([...books.keys()])
      // Tree order, as the sidebar shows them: each notebook, then its sub-notebooks.
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
      const found = await storage.searchNotesInBooks(resolved, [...books.keys()], count)
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
      const tags = (await storage.noteTags(id))
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
          await notes.setBody(id, body)
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
      if (tags !== undefined) cleanTagNames(tags)
      await atomically(async () => {
        const { record, book } = await visible(id)
        const target = notebook === undefined ? book : await resolveBook(notebook)
        let markdown: string | undefined
        if (body !== undefined) {
          markdown =
            'markdown' in body
              ? lineFeeds(body.markdown)
              : applyPatches(record.bodyMd, body.patches)
          checkBody(markdown)
        }
        // Each change goes in as the app makes it; the release writes them
        // as one save, after the body as it was is kept as a version.
        try {
          if (markdown !== undefined) await notes.setBody(id, markdown)
          if (newTitle !== undefined && newTitle !== record.title) {
            await notes.setTitle(id, newTitle)
          }
          if (target.id !== record.bookId) await notes.setBook(id, target.id)
          if (status !== undefined && status !== record.status) await notes.setStatus(id, status)
        } finally {
          await notes.release(id)
        }
        if (tags !== undefined) await setTags(id, tags)
      })
      return service.read(id)
    },

    async trash(id) {
      return atomically(async () => {
        const { record } = await visible(id)
        await notes.trash(id)
        return { id, title: record.title }
      })
    },

    async tags() {
      const books = await allowed()
      if (books.size === 0) return []
      const found = await storage.tagsInBooks([...books.keys()])
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
        const id = await bookService.create(clean, parentBook?.id ?? null)
        await bookService.setAiAccess(id, true)
        return { id, name: clean }
      })
    },
  }
  return service
}
