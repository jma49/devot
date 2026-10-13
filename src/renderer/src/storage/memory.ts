// StorageAdapter kept in localStorage, for UI tests in a plain browser (the
// UI tests' build, vite.ui-test.config.ts). Never used in the app: its
// builds leave this file out, and the release build fails if one of its
// keys (all `devot.test.*`) is in the bundle (scripts/sentry/ui.ts). It
// merges records per field by HLC, like the SQLite stores, and refuses the
// notes the app's note_put refuses. It keeps no link index: nothing in the
// UI reads one yet.
// A UI test makes note writes fail (a full disk, say) by putting an error
// code in `devot.test.failNoteWrites`.
import type {
  ActivityRevision,
  BookRecord,
  NoteRecord,
  NoteSummary,
  NoteTagRecord,
  RevisionRecord,
  StorageAdapter,
  TagRecord,
} from '../../../core'
import { checkUpload, fileUri, type FileMeta } from '../../../core/files'
import { checkNote } from '../../../core/noteLimits'
import { bodyExcerpt, excerptTerms } from '../../../core/search'
import { isTagColor } from '../../../core/tags'

const NOTES = 'devot.test.notes'
const BOOKS = 'devot.test.books'
const TAGS = 'devot.test.tags'
const NOTE_TAGS = 'devot.test.noteTags'
const FILES = 'devot.test.files'
const REVISIONS = 'devot.test.revisions'
const COMPACTION = 'devot.test.compaction'
const FAIL_NOTE_WRITES = 'devot.test.failNoteWrites'

type StoredFile = FileMeta & { mime: string; base64: string }

type Stored = Omit<NoteRecord, 'ydoc'> & { ydoc: number[]; purgedAt?: number }

type StoredRevision = Omit<RevisionRecord, 'ydoc'> & { ydoc: number[] | null }

const newestFirst = (a: StoredRevision, b: StoredRevision) => b.at - a.at || (a.id < b.id ? 1 : -1)

function read<T>(key: string): T[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]') as T[]
  } catch {
    return []
  }
}

/** Takes `field` from whichever record has the newer `hlc`. */
function newer<T>(current: T, next: T, field: keyof T, hlc: keyof T): Partial<T> {
  const a = String(current[hlc] ?? '')
  const b = String(next[hlc] ?? '')
  return b > a ? ({ [field]: next[field], [hlc]: next[hlc] } as Partial<T>) : {}
}

function mergeNote(current: Stored | undefined, next: Stored): Stored {
  if (!current) return next
  return {
    ...current,
    bodyMd: next.bodyMd,
    ydoc: next.ydoc,
    updatedAt: Math.max(current.updatedAt, next.updatedAt),
    ...newer(current, next, 'title', 'titleHlc'),
    ...newer(current, next, 'bookId', 'bookHlc'),
    ...newer(current, next, 'status', 'statusHlc'),
    ...newer(current, next, 'pinned', 'pinnedHlc'),
    ...newer(current, next, 'deletedAt', 'deletedHlc'),
  }
}

function mergeTag(current: TagRecord | undefined, next: TagRecord): TagRecord {
  if (!current) return next
  return {
    ...current,
    updatedAt: Math.max(current.updatedAt, next.updatedAt),
    ...newer(current, next, 'name', 'nameHlc'),
    ...newer(current, next, 'color', 'colorHlc'),
    ...newer(current, next, 'deletedAt', 'deletedHlc'),
  }
}

function mergeBook(current: BookRecord | undefined, next: BookRecord): BookRecord {
  if (!current) return next
  return {
    ...current,
    updatedAt: Math.max(current.updatedAt, next.updatedAt),
    ...newer(current, next, 'name', 'nameHlc'),
    ...newer(current, next, 'parentId', 'parentHlc'),
    ...newer(current, next, 'aiAccess', 'aiAccessHlc'),
    // Equal clocks (keys given to old notebooks): the greater key wins, as in SQL.
    ...(next.sortKeyHlc === current.sortKeyHlc && next.sortKey > current.sortKey
      ? { sortKey: next.sortKey }
      : newer(current, next, 'sortKey', 'sortKeyHlc')),
    ...newer(current, next, 'deletedAt', 'deletedHlc'),
  }
}

export const memoryStorage: StorageAdapter = {
  async listNotes() {
    const liveTags = new Set(
      read<TagRecord>(TAGS)
        .filter((t) => t.deletedAt === null)
        .map((t) => t.id),
    )
    const links = read<NoteTagRecord>(NOTE_TAGS).filter((l) => l.present && liveTags.has(l.tagId))
    return read<Stored>(NOTES)
      .filter((n) => n.deletedAt === null)
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1))
      .map(({ id, title, createdAt, updatedAt, bookId, status, pinned }) => ({
        id,
        title,
        createdAt,
        updatedAt,
        bookId,
        status,
        pinned,
        tagIds: links.filter((l) => l.noteId === id).map((l) => l.tagId),
      }))
  },
  async getNote(id, options) {
    const n = read<Stored>(NOTES).find(
      (x) => x.id === id && x.purgedAt === undefined && (options?.trashed || x.deletedAt === null),
    )
    if (!n) return null
    const { purgedAt: _, ...record } = n
    return { ...record, ydoc: new Uint8Array(n.ydoc) }
  },
  // The query rules of the SQLite stores, in plain code (newest first, no ranking).
  async searchNotes(query, limit) {
    const live = await memoryStorage.listNotes()
    const stored = new Map(read<Stored>(NOTES).map((n) => [n.id, n]))
    const has = (text: string, value: string) => text.toLowerCase().includes(value.toLowerCase())
    const found: NoteSummary[] = []
    for (const note of live) {
      const { title = '', bodyMd = '' } = stored.get(note.id) ?? {}
      const text = { any: `${title}\n${bodyMd}`, title, body: bodyMd }
      const meets =
        query.text.every((t) => has(text[t.field], t.value) !== t.negate) &&
        query.sets.every((set) => {
          const values =
            set.kind === 'book' ? [note.bookId] : set.kind === 'tag' ? note.tagIds : [note.status]
          return values.some((v) => v !== null && set.ids.includes(v)) !== set.negate
        }) &&
        (!query.pinned || note.pinned)
      if (!meets) continue
      const excerpt = bodyExcerpt(bodyMd, excerptTerms(query))
      found.push(excerpt === undefined ? note : { ...note, excerpt })
      if (found.length === limit) break
    }
    return found
  },
  async putFile(meta, data) {
    const mime = checkUpload(meta, data)
    const live = read<Stored>(NOTES).some((n) => n.id === meta.noteId && n.deletedAt === null)
    if (!live) throw new Error('E_NOTE_NOT_FOUND')
    const base64 = btoa(String.fromCharCode(...data))
    localStorage.setItem(
      FILES,
      JSON.stringify([...read<StoredFile>(FILES), { ...meta, mime, base64 }]),
    )
  },
  async copyFiles(noteId, copies) {
    const live = read<Stored>(NOTES).some((n) => n.id === noteId && n.deletedAt === null)
    if (!live) throw new Error('E_NOTE_NOT_FOUND')
    const files = read<StoredFile>(FILES)
    const made = copies.flatMap(({ from, to }) => {
      const file = files.find((f) => f.id === from)
      return file ? [{ ...file, id: to, noteId }] : []
    })
    localStorage.setItem(FILES, JSON.stringify([...files, ...made]))
  },
  async listTrash() {
    return read<Stored>(NOTES)
      .filter((n) => n.deletedAt !== null && n.purgedAt === undefined)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
      .map((n) => ({ id: n.id, title: n.title, deletedAt: n.deletedAt ?? 0, bookId: n.bookId }))
  },
  async purgeNote(id, at, hlc) {
    const all = read<Stored>(NOTES)
    const next = all.map((n) =>
      n.id === id && n.purgedAt === undefined
        ? {
            ...n,
            title: '',
            bodyMd: '',
            ydoc: [],
            deletedAt: n.deletedAt ?? at,
            deletedHlc: hlc,
            purgedAt: at,
          }
        : n,
    )
    localStorage.setItem(NOTES, JSON.stringify(next))
    const links = read<NoteTagRecord>(NOTE_TAGS).filter((l) => l.noteId !== id)
    localStorage.setItem(NOTE_TAGS, JSON.stringify(links))
    // Attachments another note still shows pass to it (a live one first,
    // then the smallest ID), as in the SQLite stores (HAND_OVER_FILES_SQL);
    // the rest go.
    const heirs = next
      .filter((n) => n.id !== id && n.purgedAt === undefined)
      .sort(
        (a, b) =>
          Number(a.deletedAt !== null) - Number(b.deletedAt !== null) || (a.id < b.id ? -1 : 1),
      )
    const files = read<StoredFile>(FILES).flatMap((f) => {
      if (f.noteId !== id) return [f]
      const heir = heirs.find((n) => n.bodyMd.includes(fileUri(f.id)))
      return heir ? [{ ...f, noteId: heir.id }] : []
    })
    localStorage.setItem(FILES, JSON.stringify(files))
    const revisions = read<StoredRevision>(REVISIONS).filter((r) => r.noteId !== id)
    localStorage.setItem(REVISIONS, JSON.stringify(revisions))
  },
  async putRevision(revision) {
    const note = read<Stored>(NOTES).find((n) => n.id === revision.noteId)
    if (!note || note.purgedAt !== undefined) return
    const all = read<StoredRevision>(REVISIONS)
    const current = all.find((r) => r.id === revision.id)
    if (current && (current.noteId !== revision.noteId || current.kind !== revision.kind)) return
    const next = { ...revision, ydoc: revision.ydoc ? Array.from(revision.ydoc) : null }
    localStorage.setItem(
      REVISIONS,
      JSON.stringify([...all.filter((r) => r.id !== revision.id), next]),
    )
  },
  async listRevisions(noteId) {
    return read<StoredRevision>(REVISIONS)
      .filter((r) => r.noteId === noteId)
      .sort(newestFirst)
      .map((revision) => {
        const { ydoc: _, ...summary } = revision
        return summary
      })
  },
  async getRevision(id) {
    const found = read<StoredRevision>(REVISIONS).find((r) => r.id === id)
    return found ? { ...found, ydoc: found.ydoc ? new Uint8Array(found.ydoc) : null } : null
  },
  async deleteRevisions(noteId, ids) {
    const drop = new Set(ids)
    const kept = read<StoredRevision>(REVISIONS).filter(
      (r) => r.noteId !== noteId || !drop.has(r.id),
    )
    localStorage.setItem(REVISIONS, JSON.stringify(kept))
  },
  // The rules of the SQLite stores' compaction statements (REVISION_SQL).
  async listCompactable(from, to, after, limit) {
    const plain = read<StoredRevision>(REVISIONS).filter(
      (r) => r.kind === 'body' && r.value === null,
    )
    const old = new Map<string, number[]>()
    for (const r of plain) {
      if (r.at < to) old.set(r.noteId, [...(old.get(r.noteId) ?? []), r.at])
    }
    const weighed = new Set(
      [...old]
        .filter(([noteId, times]) => noteId > after && times.length > 1)
        .filter(([, times]) => times.some((at) => at >= from))
        .map(([noteId]) => noteId)
        .sort()
        .slice(0, limit),
    )
    return plain
      .filter((r) => weighed.has(r.noteId))
      .sort((a, b) => (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : newestFirst(a, b)))
      .map(({ noteId, id, at }) => ({ noteId, id, at }))
  },
  async compactRevisions(ids, sweptAt) {
    const drop = new Set(ids)
    const kept = read<StoredRevision>(REVISIONS).filter(
      (r) => !drop.has(r.id) || r.kind !== 'body' || r.value !== null,
    )
    localStorage.setItem(REVISIONS, JSON.stringify(kept))
    if (sweptAt !== null) localStorage.setItem(COMPACTION, String(sweptAt))
  },
  async lastCompaction() {
    const at = localStorage.getItem(COMPACTION)
    return at === null ? null : Number(at)
  },
  // The rules of the SQLite stores' activity statements (ACTIVITY_SQL).
  async listActivity(since) {
    const inOrder = read<StoredRevision>(REVISIONS)
      .filter((r) => r.kind === 'body' || r.kind === 'title')
      .sort((a, b) => a.at - b.at || (a.length ?? 0) - (b.length ?? 0) || (a.id < b.id ? -1 : 1))
    const last = new Map<string, number>()
    const revisions: ActivityRevision[] = []
    for (const r of inOrder) {
      const body = r.kind === 'body'
      const previous = body ? (last.get(r.noteId) ?? null) : null
      if (body && r.length !== null) last.set(r.noteId, r.length)
      // A baseline is only the version before the next one (BASELINE).
      if (r.at >= since && !(body && r.value !== null)) {
        revisions.push({
          noteId: r.noteId,
          kind: body ? 'body' : 'title',
          at: r.at,
          length: r.length,
          previous,
        })
      }
    }
    const notes = read<Stored>(NOTES)
      .filter((n) => n.purgedAt === undefined && n.createdAt >= since)
      .map((n) => ({ id: n.id, createdAt: n.createdAt }))
    return { notes, revisions }
  },
  async putNote(note) {
    const failure = localStorage.getItem(FAIL_NOTE_WRITES)
    if (failure) throw new Error(failure)
    checkNote(note)
    const all = read<Stored>(NOTES)
    // A purge is final.
    if (all.some((n) => n.id === note.id && n.purgedAt !== undefined)) return
    const next = mergeNote(
      all.find((n) => n.id === note.id),
      { ...note, ydoc: Array.from(note.ydoc) },
    )
    localStorage.setItem(NOTES, JSON.stringify([...all.filter((n) => n.id !== note.id), next]))
  },
  async listBooks() {
    return read<BookRecord>(BOOKS).filter((b) => b.deletedAt === null)
  },
  async putBook(book) {
    const all = read<BookRecord>(BOOKS)
    const next = mergeBook(
      all.find((b) => b.id === book.id),
      book,
    )
    localStorage.setItem(BOOKS, JSON.stringify([...all.filter((b) => b.id !== book.id), next]))
  },
  async listTags() {
    // Read like SQLite does: a colour outside the palette is none.
    return read<TagRecord>(TAGS)
      .filter((t) => t.deletedAt === null)
      .map((t) => ({
        ...t,
        color: isTagColor(t.color) ? t.color : null,
        colorHlc: t.colorHlc ?? '',
      }))
  },
  async putTag(tag) {
    const all = read<TagRecord>(TAGS)
    const next = mergeTag(
      all.find((t) => t.id === tag.id),
      tag,
    )
    localStorage.setItem(TAGS, JSON.stringify([...all.filter((t) => t.id !== tag.id), next]))
  },
  async putNoteTag(link) {
    const all = read<NoteTagRecord>(NOTE_TAGS)
    const same = (l: NoteTagRecord) => l.noteId === link.noteId && l.tagId === link.tagId
    const current = all.find(same)
    if (current && current.hlc >= link.hlc) return
    localStorage.setItem(NOTE_TAGS, JSON.stringify([...all.filter((l) => !same(l)), link]))
  },
  async getNoteTag(noteId, tagId) {
    return (
      read<NoteTagRecord>(NOTE_TAGS).find((l) => l.noteId === noteId && l.tagId === tagId) ?? null
    )
  },
}
