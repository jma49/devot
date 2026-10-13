// What AI tools (devot-mcp, later the in-app assistant) may see and do.
//
// Only notebooks with Allow AI Access on are visible, each on its own (a
// sub-notebook needs its own switch); Templates never is (templates.ts). Their live notes are the only notes
// AI can find or read; trashed notes, notes in no notebook and notes whose
// notebook was deleted never are. Everything else answers as if it did not
// exist, so an error never reveals a hidden note or notebook.
//
// AI-created notes go through the note service like an import: the body is
// applied to the Yjs document as operations, never written as a snapshot.

import { buildBookTree, flattenBookTree, TEMPLATES_BOOK_ID } from './books'
import type { Clock } from './hlc'
import { UUID_V7 } from './ids'
import { MAX_NOTE_LINKS, noteLinks } from './links'
import { MAX_TITLE_CHARS } from './noteLimits'
import { createNoteService } from './notes'
import { escapeRegExp, highlightTerms, parseSearch, resolveSearch } from './search'
import type { BookRecord, NoteQuery, NoteStatus, NoteSummary, StorageAdapter } from './storage'
import { lineFeeds } from './text'

export const AI_SEARCH_LIMIT = 20
export const MAX_AI_SEARCH_LIMIT = 50
/** UTF-8 bytes; generous for any note an assistant writes in one call. */
export const MAX_AI_BODY_BYTES = 1024 * 1024
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
  /** The names of the live tags on a note. */
  noteTagNames(noteId: string): Promise<string[]>
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

export interface AiService {
  /** Notebooks AI may use, in the sidebar's order. */
  notebooks(): Promise<AiNotebook[]>
  /** Visible notes matching a search query (as in the app), best first. */
  search(query: string, limit?: number): Promise<AiSearchHit[]>
  /** A visible note; any other ID fails with E_NOTE_NOT_FOUND. */
  read(id: string): Promise<AiNote>
  /** Creates a note in an allowed notebook. */
  create(input: AiNewNote): Promise<{ id: string; title: string; notebook: AiNotebookRef }>
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

  return {
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
      if (!UUID_V7.test(id)) throw notFound()
      const record = await storage.getNote(id)
      const book = record?.bookId ? (await allowed()).get(record.bookId) : undefined
      if (!record || !book) throw notFound()
      const tags = (await storage.noteTagNames(id)).sort((a, b) => a.localeCompare(b))
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
      const clean = title.trim()
      if (!clean || /[\r\n]/.test(clean) || [...clean].length > MAX_TITLE_CHARS) {
        throw new Error('E_NOTE_TITLE_INVALID')
      }
      const body = lineFeeds(markdown)
      if (new TextEncoder().encode(body).length > MAX_AI_BODY_BYTES) {
        throw new Error('E_NOTE_BODY_TOO_LARGE')
      }
      // The app would refuse to save the note again (E_NOTE_LINKS_TOO_MANY).
      if (noteLinks(body).length > MAX_NOTE_LINKS) throw new Error('E_NOTE_LINKS_TOO_MANY')
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
  }
}
