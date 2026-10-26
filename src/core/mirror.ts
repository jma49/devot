// The Markdown mirror: a folder the user picked, kept up to date with every note as a Markdown file, laid out like an export of all notebooks (export.ts).
// SQLite stays the source of truth: the folder is written by Devot and never read back.
//
// Rust holds the folder and its manifest (`.devot-mirror.json`, src-tauri/src/mirror.rs) and runs the operations planned here, re-checking each against the manifest
// and the disk. Devot moves or deletes only paths the manifest lists, and only while they still hold what it wrote; a file changed outside Devot is kept under a
// new name and dropped from the manifest.
//
// Rules of the plan (`planMirror`, pure):
// - Names stay: a note keeps its file and a notebook its folder while the name still fits its title. A new name is the first of `Plan.md`, `Plan 2.md`, ... free in
//   its folder (not in the manifest, not given in this pass, nothing else on disk). Names are compared by `nameKey`, so two names macOS takes for one file are one
//   name; a folder keeps its name only across what macOS folds (`fileKey`).
// - An unlisted file that holds exactly what Devot would write is adopted, not rewritten: a batch's files reach the disk before its manifest, so a crash leaves
//   them unlisted. An attachment copy is matched by the hash of its bytes.
// - A path that reads `other` is a link or lies under a non-folder: the folders on the way are asked. A notebook folder that is no longer a real folder is lost and
//   replaced; `attachments` cannot be, so only names are kept there.
// - A note's file is written only when its `source` changed, or the file is missing or was changed.
// - Attachments are copied once per attachment a mirrored note shows (with Include Attachments) and removed when none does; without it only names are kept.
// - Work comes in slices (`limit`), so a first mirror of many notes does a few hundred at a time.

import { buildBookTree, TEMPLATES_BOOK_ID, type BookNode } from './books'
import { errorCode } from './errors'
import {
  ATTACHMENTS_FOLDER,
  attachmentIds,
  fileKey,
  fileStem,
  markdownFile,
  nameKey,
} from './export'
import { sha256Hex } from './sha256'
import type { NoteStatus, NoteSummary, StorageAdapter, TagRecord, BookRecord } from './storage'

export interface MirrorNoteEntry {
  path: string
  sha256: string
  size: number
  source: string
  files: string[]
}

export interface MirrorFileEntry {
  path: string
  /** The SHA-256 of the copy Devot wrote; null: no copy, only the name (Include Attachments off). */
  sha256: string | null
  size: number
}

export interface MirrorManifest {
  notes: Record<string, MirrorNoteEntry>
  files: Record<string, MirrorFileEntry>
  books: Record<string, string>
}

export const emptyManifest = (): MirrorManifest => ({ notes: {}, files: {}, books: {} })

/** A regular file's SHA-256 (hex), `dir`, `other` (a link, say), or null for nothing. */
export type DiskState = string | 'dir' | 'other' | null

const DIR = 'dir'
const OTHER = 'other'

const isFile = (state: DiskState | undefined): state is string =>
  typeof state === 'string' && state !== DIR && state !== OTHER

export type MirrorEntryKind = 'note' | 'file'

export type MirrorOp =
  /** The file at `path` was changed outside Devot: it stays, renamed to a free "edited outside Devot" name, and leaves the manifest. */
  | { kind: 'keep'; entry: MirrorEntryKind; id: string; path: string }
  /** The entry leaves the manifest; nothing on disk changes (its file is gone, or not Devot's). */
  | { kind: 'forget'; entry: MirrorEntryKind; id: string }
  | { kind: 'remove'; entry: MirrorEntryKind; id: string; path: string; sha256: string }
  /** `from`: the note's file now (must still hold what the manifest says, or `sha256`), moved to `path`. A file already at `path` that is not Devot's is never replaced unless it holds exactly `text`: then Devot adopts it. */
  | {
      kind: 'note'
      id: string
      path: string
      from: string | null
      sha256: string
      text?: string
      source: string
      files: string[]
    }
  | { kind: 'file'; id: string; path: string; copy: boolean }
  /** A null path forgets the notebook's folder. */
  | { kind: 'book'; id: string; path: string | null }

export interface MirrorResult {
  code?: string
  /** E_MIRROR_EXISTS and E_MIRROR_CHANGED: the path in the way, and what is there now. */
  path?: string
  state?: DiskState
  size?: number
  sha256?: string | null
  kept?: string
  /** The note's file moved but its new text could not be written: Rust lists it where it went. */
  moved?: boolean
}

export function applyResult(manifest: MirrorManifest, op: MirrorOp, result: MirrorResult): void {
  switch (op.kind) {
    case 'keep':
    case 'forget':
    case 'remove':
      if (op.entry === 'note') delete manifest.notes[op.id]
      else delete manifest.files[op.id]
      return
    case 'note':
      manifest.notes[op.id] = {
        path: op.path,
        sha256: op.sha256,
        size: result.size ?? 0,
        source: op.source,
        files: op.files,
      }
      return
    case 'file':
      manifest.files[op.id] = {
        path: op.path,
        sha256: op.copy ? (result.sha256 ?? null) : null,
        size: op.copy ? (result.size ?? 0) : 0,
      }
      return
    case 'book':
      if (op.path === null) delete manifest.books[op.id]
      else manifest.books[op.id] = op.path
  }
}

export interface MirrorTextSpec {
  id: string
  /** Identifies the inputs: a text rendered under another key is stale. */
  key: string
  title: string
  bodyMd: string
  tags: string[]
  status: NoteStatus
  path: string
  fileName: string
  paths: [string, string][]
}

export interface MirrorText {
  key: string
  text: string
  sha256: string
}

export function renderMirrorText(spec: MirrorTextSpec): MirrorText {
  const text = markdownFile(
    { title: spec.title, bodyMd: spec.bodyMd, tags: spec.tags, status: spec.status },
    spec.fileName,
    new Map(spec.paths),
  )
  return { key: spec.key, text, sha256: sha256Hex(text) }
}

function digest(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/** The update time stands for the body, though a merged remote edit older than the note's keeps it: that body reaches the file with the note's next change (#386, A019). `-` marks an attachment not in the database. */
export function noteSource(
  note: Pick<NoteSummary, 'updatedAt' | 'title' | 'status'>,
  tags: readonly string[],
  path: string,
  marks: readonly string[],
  memo?: MirrorMemo,
): string {
  const inputs = [
    String(note.updatedAt),
    note.title,
    note.status,
    tags.join('\u001f'),
    path,
    ...marks,
  ].join('\u001e')
  let source = memo?.sources.get(inputs)
  if (source === undefined) {
    source = digest(inputs)
    memo?.sources.set(inputs, source)
  }
  return source
}

const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0))
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
/** Names' keys joined by a character no name holds, so two paths with one key name one file. */
const pathKey = (path: string) => path.split('/').map(nameKey).join('\u0000')

function fits(name: string, stem: string, ext: string): boolean {
  if (!name.endsWith(ext)) return false
  const base = name.slice(0, name.length - ext.length)
  if (base === stem) return true
  return base.startsWith(`${stem} `) && /^(?:[2-9]|[1-9]\d+)$/.test(base.slice(stem.length + 1))
}

export function numberedName(name: string, n: number): string {
  if (n <= 1) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} ${n}${name.slice(dot)}` : `${name} ${n}`
}

class Names {
  private readonly byFolder = new Map<string, Set<string>>()

  addPath(path: string): void {
    let folder = ''
    for (const part of path.split('/')) {
      this.add(folder, part)
      folder = joinPath(folder, part)
    }
  }

  add(folder: string, name: string): void {
    const key = pathKey(folder)
    let names = this.byFolder.get(key)
    if (!names) this.byFolder.set(key, (names = new Set()))
    names.add(nameKey(name))
  }

  has(folder: string, name: string): boolean {
    return this.byFolder.get(pathKey(folder))?.has(nameKey(name)) ?? false
  }
}

export interface MirrorPlanInput {
  notes: readonly NoteSummary[]
  books: readonly BookRecord[]
  tags: readonly TagRecord[]
  manifest: MirrorManifest
  includeAttachments: boolean
  untitled: string
  bodies: ReadonlyMap<string, string>
  /** Attachment file names (Rust's, see `mirror_files`); null when not in the database. */
  files: ReadonlyMap<string, string | null>
  /** Asked only for attachments whose copy has a file in the way. */
  hashes: ReadonlyMap<string, string | null>
  /** A note may be rendered for a place it does not take in the end, to tell whether a file there is its own. */
  texts: ReadonlyMap<string, ReadonlyMap<string, MirrorText>>
  disk: ReadonlyMap<string, DiskState>
  /** Notes to leave as they are in this pass (their work failed). */
  skip?: ReadonlySet<string>
  /** At most this many notes get new files in one plan; the rest wait (`deferred`). */
  limit?: number
  memo?: MirrorMemo
}

/** Cache only; a plan gives the same result without it. */
export interface MirrorMemo {
  stems: Map<string, string>
  sources: Map<string, string>
  links: Map<string, string[]>
}

export const createMirrorMemo = (): MirrorMemo => ({
  stems: new Map(),
  sources: new Map(),
  links: new Map(),
})

export interface MirrorPlan {
  needs: {
    bodies: string[]
    files: string[]
    hashes: string[]
    texts: MirrorTextSpec[]
    paths: string[]
  }
  ops: MirrorOp[]
  deferred: number
}

interface Place {
  folder: string
  name: string
  depth: number
}

export function planMirror(input: MirrorPlanInput): MirrorPlan {
  const { manifest, disk } = input
  const skip = input.skip ?? new Set<string>()
  const needBodies = new Set<string>()
  const needFiles = new Set<string>()
  const needHashes = new Set<string>()
  const needPaths = new Set<string>()
  const texts: MirrorTextSpec[] = []
  const known = (path: string): DiskState | undefined =>
    disk.has(path) ? (disk.get(path) ?? null) : undefined
  const ask = (path: string) => {
    if (!disk.has(path)) needPaths.add(path)
  }

  const books = input.books.filter((b) => b.id !== TEMPLATES_BOOK_ID)
  const liveBooks = new Set(books.map((b) => b.id))
  const tagNames = new Map(input.tags.map((t) => [t.id, t.name]))
  const notes = input.notes.filter((n) => n.bookId !== TEMPLATES_BOOK_ID && !skip.has(n.id))
  const mirrored = new Map(notes.map((n) => [n.id, n]))
  const bookOf = (note: NoteSummary) =>
    note.bookId !== null && liveBooks.has(note.bookId) ? note.bookId : null
  const tagLists = new Map<string, string[]>()
  const tagsOf = (note: NoteSummary) => {
    const key = note.tagIds.join()
    let names = tagLists.get(key)
    if (!names) {
      names = note.tagIds
        .flatMap((t) => tagNames.get(t) ?? [])
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      tagLists.set(key, names)
    }
    return names
  }
  const stems = input.memo?.stems ?? new Map<string, string>()
  const stemOf = (title: string) => {
    let stem = stems.get(title)
    if (stem === undefined) {
      stem = fileStem(title, input.untitled)
      stems.set(title, stem)
    }
    return stem
  }

  // Paths of manifest files that stay this pass (and keep their names
  // taken, even when they move), and of anything else known on disk.
  const manifestPaths = new Set<string>()
  const taken = new Names()
  for (const [id, entry] of Object.entries(manifest.notes)) {
    manifestPaths.add(entry.path)
    if (mirrored.has(id) || skip.has(id)) taken.addPath(entry.path)
  }
  for (const entry of Object.values(manifest.files)) manifestPaths.add(entry.path)
  // Anything else on disk is in the way (by name, case ignored); at a
  // manifest path, only what is not a file (a file there is Devot's, or
  // kept under a new name first).
  const foreign = new Map<string, DiskState>()
  for (const [path, state] of disk) {
    if (state !== null && !(isFile(state) && manifestPaths.has(path))) {
      foreign.set(pathKey(path), state)
    }
    // A link, or under something that is not a real folder: which folder on
    // the way it is decides whether a notebook's folder is lost.
    if (state === OTHER) {
      for (let folder = parentOf(path); folder; folder = parentOf(folder)) ask(folder)
    }
  }
  const lost = (path: string) => {
    const state = known(path)
    return state === DIR || state === OTHER
  }
  const folderLost = (path: string) => {
    const state = known(path)
    return state !== undefined && state !== null && state !== DIR
  }

  const links = input.memo?.links ?? new Map<string, string[]>()
  const linksOf = (body: string) => {
    let ids = links.get(body)
    if (!ids) {
      ids = attachmentIds(body)
      links.set(body, ids)
    }
    return ids
  }
  const shown = new Map<string, string[]>()
  for (const note of notes) {
    const body = input.bodies.get(note.id)
    shown.set(note.id, body !== undefined ? linksOf(body) : (manifest.notes[note.id]?.files ?? []))
  }
  const wanted = new Set<string>()
  for (const ids of shown.values()) {
    for (const id of ids) {
      const name = input.files.get(id)
      if (name === undefined) needFiles.add(id)
      else if (name !== null) wanted.add(id)
    }
  }
  const held = new Set<string>()
  for (const id of skip) for (const fileId of manifest.notes[id]?.files ?? []) held.add(fileId)
  const attachmentsLost = folderLost(ATTACHMENTS_FOLDER)
  const copies = input.includeAttachments && !attachmentsLost
  /** Until the answer is known the file is taken to be the copy, and the notes that show it wait. */
  const isCopy = (id: string, state: DiskState | undefined) => {
    if (!copies || !isFile(state)) return false
    const hash = input.hashes.get(id)
    if (hash === undefined) needHashes.add(id)
    return hash === undefined || hash === state
  }
  const fileTaken = new Set<string>()
  const filePath = new Map<string, string>()
  const fileLost = (id: string, entry: MirrorFileEntry) => {
    if (lost(entry.path)) return true
    if (entry.sha256 !== null) return false
    // A name only (no copy) is lost to a file that appeared there, unless
    // that file is the copy itself.
    const state = known(entry.path)
    return state !== undefined && state !== null && !(wanted.has(id) && isCopy(id, state))
  }
  for (const id of wanted) {
    const entry = manifest.files[id]
    // While `attachments` is lost, every name is as good: none is renumbered.
    if (entry && (attachmentsLost || !fileLost(id, entry))) {
      fileTaken.add(pathKey(entry.path))
      filePath.set(id, entry.path)
    }
  }
  for (const id of held) {
    const entry = manifest.files[id]
    if (entry) fileTaken.add(pathKey(entry.path))
  }
  for (const [id, entry] of Object.entries(manifest.files)) {
    if (fileLost(id, entry)) fileTaken.add(pathKey(entry.path))
  }
  const fileFree = (id: string, path: string) =>
    !fileTaken.has(pathKey(path)) &&
    (attachmentsLost || !foreign.has(pathKey(path)) || isCopy(id, foreign.get(pathKey(path))))
  for (const id of [...wanted].sort()) {
    if (filePath.has(id)) continue
    const base = input.files.get(id)!
    let path = `${ATTACHMENTS_FOLDER}/${base}`
    for (let n = 2; !fileFree(id, path); n += 1) {
      path = `${ATTACHMENTS_FOLDER}/${numberedName(base, n)}`
    }
    fileTaken.add(pathKey(path))
    filePath.set(id, path)
  }

  /** Undefined while an attachment's name or hash is not known yet. */
  const layoutAt = (note: NoteSummary, path: string, depth: number) => {
    const ids = shown.get(note.id) ?? []
    if (ids.some((id) => input.files.get(id) === undefined || needHashes.has(id))) return undefined
    const up = '../'.repeat(depth)
    const paths = ids.flatMap((id): [string, string][] => {
      const at = filePath.get(id)
      return at === undefined ? [] : [[id, up + at]]
    })
    const tags = tagsOf(note)
    const key = [note.updatedAt, note.title, note.status, ...tags, path, ...paths.flat()].join(
      '\u0000',
    )
    return { ids, paths, tags, key }
  }
  /** Rendered for that very place, so whatever the note was rendered for before, it finds its own file. Until rendered the file is taken to be its own. */
  const holdsText = (note: NoteSummary, path: string, depth: number, state: DiskState) => {
    if (!isFile(state)) return false
    const layout = layoutAt(note, path, depth)
    const text = input.texts.get(note.id)?.get(path)
    return layout === undefined || text?.key !== layout.key || text.sha256 === state
  }

  const notePlace = new Map<string, Place>()
  const bookFolder = new Map<string, string>()
  const byBook = new Map<string | null, NoteSummary[]>()
  for (const note of notes) {
    const key = bookOf(note)
    const list = byBook.get(key) ?? []
    list.push(note)
    byBook.set(key, list)
  }
  const withNotes = new Set<string>()
  const markNotes = (node: BookNode): boolean => {
    let any = (byBook.get(node.id)?.length ?? 0) > 0
    for (const child of node.children) any = markNotes(child) || any
    if (any) withNotes.add(node.id)
    return any
  }
  const tree = buildBookTree(books)
  tree.forEach(markNotes)

  const place = (folder: string, depth: number, here: NoteSummary[], subs: BookNode[]) => {
    const given = new Set<string>()
    const free = (name: string, own: string | undefined, note?: NoteSummary) => {
      const key = nameKey(name)
      if (given.has(key) || (depth === 0 && key === nameKey(ATTACHMENTS_FOLDER))) return false
      const path = joinPath(folder, name)
      if (own !== undefined && pathKey(own) === pathKey(path)) {
        // Its own path in another form (of case, say): free while nothing
        // is there or what is there is its own (that very path, or one file
        // under two names, on a file system that takes them for one).
        const there = known(path)
        return there === undefined || there === null || path === own || there === known(own)
      }
      if (taken.has(folder, name)) return false
      const state = foreign.get(pathKey(path))
      if (state === undefined) return true
      const entry = note && manifest.notes[note.id]
      if (entry && entry.sha256 === state) {
        // A move cut short before the manifest was saved left the note's last text here and
        // nothing at its old path: Rust finishes the move in place.
        const old = known(entry.path)
        if (old === null) return true
        if (old === undefined) ask(entry.path)
      }
      // A folder Devot did not make may be shared; a file is the note's only
      // when it holds exactly what Devot would write there for it.
      return note === undefined ? state === DIR : holdsText(note, path, depth, state)
    }
    const ownPath = (path: string | undefined, gone: (path: string) => boolean) =>
      path !== undefined && pathKey(parentOf(path)) === pathKey(folder) && !gone(path)
        ? path
        : undefined
    const ordered = [...here].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    const renamed: NoteSummary[] = []
    for (const note of ordered) {
      const current = manifest.notes[note.id]?.path
      const stem = stemOf(note.title)
      if (
        current !== undefined &&
        parentOf(current) === folder &&
        fits(nameOf(current), stem, '.md') &&
        !given.has(nameKey(nameOf(current))) &&
        !lost(current)
      ) {
        given.add(nameKey(nameOf(current)))
        notePlace.set(note.id, { folder, name: nameOf(current), depth })
      } else {
        renamed.push(note)
      }
    }
    const subsHere = subs.filter((b) => withNotes.has(b.id))
    const moved: BookNode[] = []
    for (const book of subsHere) {
      const current = manifest.books[book.id]
      // A folder keeps its name across a change of case (or of the form of
      // its accents) only, what macOS itself folds (`fileKey`, not the key
      // names are numbered by): moving files to another name macOS takes
      // for the same folder leaves them where they are.
      if (
        current !== undefined &&
        parentOf(current) === folder &&
        fits(fileKey(nameOf(current)), fileKey(fileStem(book.name, '_')), '') &&
        !given.has(nameKey(nameOf(current))) &&
        !folderLost(current)
      ) {
        given.add(nameKey(nameOf(current)))
        bookFolder.set(book.id, current)
      } else {
        moved.push(book)
      }
    }
    for (const note of renamed) {
      const stem = stemOf(note.title)
      const own = ownPath(manifest.notes[note.id]?.path, lost)
      let name = `${stem}.md`
      for (let n = 2; !free(name, own, note); n += 1) name = `${stem} ${n}.md`
      given.add(nameKey(name))
      notePlace.set(note.id, { folder, name, depth })
    }
    for (const book of moved) {
      const stem = fileStem(book.name, '_')
      const own = ownPath(manifest.books[book.id], folderLost)
      let name = stem
      for (let n = 2; !free(name, own); n += 1) name = `${stem} ${n}`
      given.add(nameKey(name))
      bookFolder.set(book.id, joinPath(folder, name))
    }
    for (const book of subsHere) {
      place(bookFolder.get(book.id)!, depth + 1, byBook.get(book.id) ?? [], book.children)
    }
  }
  place('', 0, byBook.get(null) ?? [], tree)

  const fileMark = (id: string): string => {
    const name = input.files.get(id)
    if (name === undefined) {
      needFiles.add(id)
      return '?'
    }
    return name === null ? '-' : (manifest.files[id]?.path ?? '+')
  }
  const candidates: NoteSummary[] = []
  for (const note of notes) {
    const where = notePlace.get(note.id)!
    const path = joinPath(where.folder, where.name)
    const entry = manifest.notes[note.id]
    if (entry && entry.path === path) {
      const marks = entry.files.map(fileMark)
      // Undecided until the attachments it shows are known.
      if (marks.includes('?')) continue
      const state = known(entry.path)
      const intact = state === undefined || state === entry.sha256
      if (intact && entry.source === noteSource(note, tagsOf(note), path, marks, input.memo)) {
        continue
      }
    }
    candidates.push(note)
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
  const limit = input.limit ?? Infinity
  const active = candidates.slice(0, limit)
  for (const note of active) if (!input.bodies.has(note.id)) needBodies.add(note.id)

  const keeps: MirrorOp[] = []
  const forgets: MirrorOp[] = []
  const removes: MirrorOp[] = []
  const fileOps: MirrorOp[] = []
  const noteOps: MirrorOp[] = []
  const bookOps: MirrorOp[] = []
  const takeOut = (kind: MirrorEntryKind, id: string, path: string, sha256: string) => {
    const state = known(path)
    if (state === undefined) return ask(path)
    if (state === null || state === DIR || state === OTHER)
      forgets.push({ kind: 'forget', entry: kind, id })
    else if (state === sha256) removes.push({ kind: 'remove', entry: kind, id, path, sha256 })
    else keeps.push({ kind: 'keep', entry: kind, id, path })
  }

  for (const [id, entry] of Object.entries(manifest.notes)) {
    if (!mirrored.has(id) && !skip.has(id)) takeOut('note', id, entry.path, entry.sha256)
  }

  for (const note of active) {
    const body = input.bodies.get(note.id)
    if (body === undefined) continue
    const where = notePlace.get(note.id)!
    const path = joinPath(where.folder, where.name)
    const layout = layoutAt(note, path, where.depth)
    if (!layout) continue
    const { ids, paths, tags, key } = layout
    const marks = ids.map((id) => filePath.get(id) ?? '-')
    const source = noteSource(note, tags, path, marks, input.memo)
    const text = input.texts.get(note.id)?.get(path)
    if (text?.key !== key) {
      texts.push({
        id: note.id,
        key,
        title: note.title,
        bodyMd: body,
        tags,
        status: note.status,
        path,
        fileName: where.name,
        paths,
      })
      continue
    }
    const entry = manifest.notes[note.id]
    let from: string | null = null
    let state: DiskState | undefined
    if (entry) {
      if (entry.path === path && entry.sha256 === text.sha256) {
        state = known(path)
        if (state === undefined || state === entry.sha256) {
          const same = entry.source === source && entry.files.join() === ids.join()
          if (!same)
            noteOps.push({
              kind: 'note',
              id: note.id,
              path,
              from: path,
              sha256: text.sha256,
              source,
              files: ids,
            })
          continue
        }
      }
      state = known(entry.path)
      if (state === undefined) {
        ask(entry.path)
        continue
      }
      if (state === DIR || state === OTHER)
        forgets.push({ kind: 'forget', entry: 'note', id: note.id })
      else if (state === entry.sha256 || state === text.sha256) from = entry.path
      else if (state !== null)
        keeps.push({ kind: 'keep', entry: 'note', id: note.id, path: entry.path })
    }
    if (from === path && state === text.sha256) {
      noteOps.push({
        kind: 'note',
        id: note.id,
        path,
        from,
        sha256: text.sha256,
        source,
        files: ids,
      })
      continue
    }
    if (from !== path) {
      ask(path)
      let folder = where.folder
      while (folder && !taken.has(parentOf(folder), nameOf(folder))) {
        ask(folder)
        folder = parentOf(folder)
      }
    }
    // What is at the new place holds exactly this text already (a file the
    // manifest does not list, or the note's own under another case): Rust
    // takes it as it is, so the text need not go.
    const adopt = from !== path && !manifestPaths.has(path) && known(path) === text.sha256
    noteOps.push({
      kind: 'note',
      id: note.id,
      path,
      from,
      sha256: text.sha256,
      ...(adopt ? {} : { text: text.text }),
      source,
      files: ids,
    })
  }

  const filesKnown = needFiles.size === 0
  for (const [id, entry] of filesKnown ? Object.entries(manifest.files) : []) {
    if (held.has(id) && !wanted.has(id)) continue
    const keepName = wanted.has(id) && filePath.get(id) === entry.path
    if (entry.sha256 === null) {
      if (!keepName) forgets.push({ kind: 'forget', entry: 'file', id })
      continue
    }
    if (!keepName || !copies) takeOut('file', id, entry.path, entry.sha256)
    else {
      const state = known(entry.path)
      if (state === null) fileOps.push({ kind: 'file', id, path: entry.path, copy: true })
      else if (state !== undefined && state !== entry.sha256) {
        keeps.push({ kind: 'keep', entry: 'file', id, path: entry.path })
        fileOps.push({ kind: 'file', id, path: entry.path, copy: true })
      }
    }
  }
  for (const [id, path] of filesKnown ? filePath : []) {
    const entry = manifest.files[id]
    const copied = entry?.sha256 != null && entry.path === path
    if (copies ? copied : entry?.sha256 === null && entry.path === path) continue
    // A new copy or name: nothing that is not Devot's may be there, but the
    // copy itself (Rust adopts it). While `attachments` is lost, only the
    // name is recorded, and nothing there is looked at.
    const state = known(path)
    if (state === undefined && !attachmentsLost) ask(path)
    else if (
      state === null ||
      (!copies && (copied || attachmentsLost)) ||
      (copies && isFile(state) && state === input.hashes.get(id))
    ) {
      fileOps.push({ kind: 'file', id, path, copy: copies })
    }
  }

  for (const [id, folder] of bookFolder) {
    if (manifest.books[id] !== folder) bookOps.push({ kind: 'book', id, path: folder })
  }
  for (const id of Object.keys(manifest.books)) {
    if (!bookFolder.has(id)) bookOps.push({ kind: 'book', id, path: null })
  }

  return {
    needs: {
      bodies: [...needBodies],
      files: [...needFiles],
      hashes: [...needHashes],
      texts,
      paths: [...needPaths],
    },
    ops: [...keeps, ...forgets, ...removes, ...fileOps, ...noteOps, ...bookOps],
    deferred: candidates.length - active.length,
  }
}

export interface MirrorOpened {
  generation: number
  includeAttachments: boolean
  /** Null when the caller already holds this generation's. */
  manifest: MirrorManifest | null
}

export interface MirrorHost {
  /** Throws E_MIRROR_OFF, or the code the mirror paused with. */
  open(known: number | null): Promise<MirrorOpened>
  /** Live notes only. */
  bodies(ids: readonly string[]): Promise<{ id: string; bodyMd: string }[]>
  /** Attachments that are in the database only. */
  files(ids: readonly string[]): Promise<{ id: string; name: string }[]>
  hashes(ids: readonly string[]): Promise<{ id: string; sha256: string }[]>
  /** For null, every manifest path whose file does not hold what the manifest says. */
  check(generation: number, paths: readonly string[] | null): Promise<Record<string, DiskState>>
  /** One result each, in order, up to a failure that stops them all. */
  apply(generation: number, ops: readonly MirrorOp[]): Promise<MirrorResult[]>
}

export interface MirrorRunnerOptions {
  storage: Pick<StorageAdapter, 'listNotes' | 'listBooks' | 'listTags'>
  host: MirrorHost
  untitled: string
  /** A pass runs this long after the last change... */
  delayMs?: number
  /** ...but no later than this after the first one it waits for. */
  maxWaitMs?: number
  /** A paused mirror checks its folder again this often (and on `wake`). */
  retryMs?: number
  slice?: number
  onError?: (code: string) => void
  /** Hands the event loop back between steps (the worker answers the UI meanwhile). */
  yieldNow?: () => Promise<void>
}

export interface MirrorRunner {
  touch(): void
  /** A full pass runs soon unless one for `generation` runs or ran already (a resume starts one itself). */
  reconcile(generation?: number): void
  wake(): void
  /** A running pass ends after its current batch, so the manifest records it. */
  stop(): Promise<void>
  /** Settles once no pass runs or waits (tests). */
  idle(): Promise<void>
}

const PAUSED = /^E_MIRROR_(FOLDER|MANIFEST)_/
const RETRYABLE = new Set(['E_MIRROR_EXISTS', 'E_MIRROR_CHANGED'])
const STALE = 'E_MIRROR_STALE'
/** A safety net: a pass never plans more often than this. */
const MAX_PLANS = 10_000
const MAX_TRIES = 3
/** Times a note's file may be rendered in one pass; one whose place keeps changing is then left as it is so it never holds up the others. */
const MAX_RENDERS = 10
const UNSETTLED = 'E_MIRROR_UNSETTLED'
const CHUNK = { bodies: 200, files: 1000, hashes: 20, paths: 2000, ops: 200 }

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const chunks = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

const entryKey = (op: MirrorOp) =>
  op.kind === 'book'
    ? `book:${op.id}`
    : `${op.kind === 'note' ? 'note' : op.kind === 'file' ? 'file' : op.entry}:${op.id}`

export function createMirrorRunner(options: MirrorRunnerOptions): MirrorRunner {
  const { storage } = options
  const delayMs = options.delayMs ?? 1000
  const maxWaitMs = options.maxWaitMs ?? 5000
  const retryMs = options.retryMs ?? 30_000
  const slice = options.slice ?? 1000
  const yieldNow = options.yieldNow ?? (() => new Promise<void>((r) => setTimeout(r, 0)))
  let enabled = false
  let paused = false
  let wantFull = false
  let wantPass = false
  let firstWait: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined
  let epoch = 0
  let manifest: MirrorManifest | null = null
  let generation: number | null = null
  let reconciled: number | null = null
  let askedFor: number | null = null

  const schedule = (ms: number) => {
    clearTimeout(timer)
    timer = setTimeout(() => void run(), ms)
  }

  const fail = (error: unknown) => {
    const code = errorCode(error, 'E_MIRROR_FAILED')
    // What Rust holds may be ahead of our copy (a batch it ran when the pass
    // stopped or failed): read it again next time.
    manifest = null
    generation = null
    reconciled = null
    if (code === STOPPED) return
    options.onError?.(code)
    // A stale generation means the setting changed: the window asks for the
    // reconcile that follows. Nothing here runs again on its own but a pause.
    if (code === 'E_MIRROR_OFF') enabled = false
    else if (PAUSED.test(code)) {
      paused = true
      wantFull = true
      schedule(retryMs)
    }
  }

  const run = async (): Promise<void> => {
    timer = undefined
    if (running || !enabled || (!wantPass && !wantFull)) return
    const full = wantFull
    wantFull = false
    wantPass = false
    firstWait = undefined
    running = pass(full)
      .then(() => {
        paused = false
      })
      .catch(fail)
      .finally(() => {
        running = undefined
        if (enabled && !paused && (wantPass || wantFull)) schedule(0)
      })
    await running
  }

  const pass = async (full: boolean) => {
    const mine = epoch
    const step = async <T>(work: Promise<T>): Promise<T> => {
      const value = await work
      if (epoch !== mine) throw new Error(STOPPED)
      return value
    }
    const host = stepping(options.host, step)
    const pause = () => step(yieldNow())
    const opened = await host.open(generation)
    if (opened.manifest) {
      manifest = opened.manifest
    } else if (!manifest || generation !== opened.generation) {
      throw new Error(STALE)
    }
    // The folder opened: the mirror is not paused (a resume's own full pass
    // runs now, and a reconcile asked for its generation is this one).
    paused = false
    generation = opened.generation
    if (full) {
      reconciled = opened.generation
      // A reconcile asked for this generation meanwhile: this pass is it.
      if (wantFull && askedFor === opened.generation) wantFull = false
    }
    const current = manifest
    const gen = opened.generation
    const [notes, books, tags] = await step(
      Promise.all([storage.listNotes(), storage.listBooks(), storage.listTags()]),
    )
    const bodies = new Map<string, string>()
    const files = new Map<string, string | null>()
    const hashes = new Map<string, string | null>()
    const texts = new Map<string, Map<string, MirrorText>>()
    const disk = new Map<string, DiskState>()
    const skip = new Set<string>()
    const memo = createMirrorMemo()
    const failed = new Set<string>()
    const tries = new Map<string, number>()
    const renders = new Map<string, number>()
    let stale = false
    if (full) {
      for (const entry of [...Object.values(current.notes), ...Object.values(current.files)]) {
        if (entry.sha256 !== null) disk.set(entry.path, entry.sha256)
      }
      for (const [path, state] of Object.entries(await host.check(gen, null))) disk.set(path, state)
    }
    for (let plans = 0; plans < MAX_PLANS; plans += 1) {
      await pause()
      const plan = planMirror({
        notes,
        books,
        tags,
        manifest: current,
        includeAttachments: opened.includeAttachments,
        untitled: options.untitled,
        bodies,
        files,
        hashes,
        texts,
        disk,
        skip,
        limit: slice,
        memo,
      })
      const { needs } = plan
      const asks =
        needs.bodies.length +
        needs.files.length +
        needs.hashes.length +
        needs.texts.length +
        needs.paths.length
      if (asks) {
        // A note rendered again and again never settles: it is left as it is.
        const specs = needs.texts.filter((spec) => {
          const count = (renders.get(spec.id) ?? 0) + 1
          renders.set(spec.id, count)
          if (count <= MAX_RENDERS) return true
          options.onError?.(UNSETTLED)
          skip.add(spec.id)
          return false
        })
        await gather(host, pause, { ...needs, texts: specs }, gen, {
          bodies,
          files,
          hashes,
          texts,
          disk,
          skip,
        })
        continue
      }
      const ops = plan.ops.filter((op) => !failed.has(entryKey(op)))
      if (ops.length === 0) {
        if (stale) {
          manifest = null
          generation = null
        }
        return
      }
      for (const batch of chunks(ops, CHUNK.ops)) {
        const results = await host.apply(gen, batch)
        for (const [i, op] of batch.entries()) {
          const result = results[i]
          // Rust stops at a failure that ends the batch; it is the last result.
          if (!result) throw new Error(results.at(-1)?.code ?? 'E_MIRROR_FAILED')
          const { code } = result
          // The next pass reads the manifest again, which lists the file where it went.
          if (result.moved) stale = true
          if (code === undefined) {
            applyResult(current, op, result)
            forgetDisk(disk, op)
            if (op.kind === 'note') {
              // Written: its body and file are not needed again this pass
              // (a first mirror holds about one slice of them at a time).
              bodies.delete(op.id)
              texts.delete(op.id)
            }
          } else if (RETRYABLE.has(code) && result.path !== undefined) {
            disk.set(result.path, result.state ?? null)
            const key = entryKey(op)
            const tried = (tries.get(key) ?? 0) + 1
            tries.set(key, tried)
            if (tried >= MAX_TRIES) {
              options.onError?.(code)
              failed.add(key)
            }
          } else if (PAUSED.test(code) || code === 'E_MIRROR_OFF') {
            throw new Error(code)
          } else if (code === STALE) {
            // This entry was planned from an older manifest: it waits for the
            // next pass, which reads the manifest again.
            failed.add(entryKey(op))
            stale = true
          } else {
            options.onError?.(code)
            failed.add(entryKey(op))
            // An attachment that cannot be copied is shown by its link instead.
            if (op.kind === 'file' && code === 'E_FILE_NOT_FOUND') files.set(op.id, null)
          }
        }
        await pause()
      }
    }
    // Never reached unless something keeps changing under every plan.
    options.onError?.(UNSETTLED)
  }

  const gather = async (
    host: MirrorHost,
    pause: () => Promise<void>,
    needs: MirrorPlan['needs'],
    gen: number,
    known: {
      bodies: Map<string, string>
      files: Map<string, string | null>
      hashes: Map<string, string | null>
      texts: Map<string, Map<string, MirrorText>>
      disk: Map<string, DiskState>
      skip: Set<string>
    },
  ) => {
    for (const ids of chunks(needs.bodies, CHUNK.bodies)) {
      const found = new Map((await host.bodies(ids)).map((b) => [b.id, b.bodyMd]))
      for (const id of ids) {
        const body = found.get(id)
        // Gone meanwhile (trashed, purged): the next pass sees it.
        if (body === undefined) known.skip.add(id)
        else known.bodies.set(id, body)
      }
    }
    for (const ids of chunks(needs.files, CHUNK.files)) {
      const found = new Map((await host.files(ids)).map((f) => [f.id, f.name]))
      for (const id of ids) known.files.set(id, found.get(id) ?? null)
    }
    for (const ids of chunks(needs.hashes, CHUNK.hashes)) {
      const found = new Map((await host.hashes(ids)).map((f) => [f.id, f.sha256]))
      for (const id of ids) known.hashes.set(id, found.get(id) ?? null)
    }
    let started = Date.now()
    for (const spec of needs.texts) {
      let byPath = known.texts.get(spec.id)
      if (!byPath) known.texts.set(spec.id, (byPath = new Map()))
      byPath.set(spec.path, renderMirrorText(spec))
      if (Date.now() - started > 16) {
        await pause()
        started = Date.now()
      }
    }
    for (const paths of chunks(needs.paths, CHUNK.paths)) {
      const found = await host.check(gen, paths)
      for (const path of paths) known.disk.set(path, found[path] ?? null)
    }
  }

  return {
    touch() {
      if (!enabled || paused) return
      wantPass = true
      const now = Date.now()
      firstWait ??= now
      if (!running) schedule(Math.max(0, Math.min(delayMs, firstWait + maxWaitMs - now)))
    },
    reconcile(known) {
      const again = known !== undefined && known === reconciled && enabled && !paused
      enabled = true
      if (again) return
      paused = false
      wantFull = true
      askedFor = known ?? null
      if (!running) schedule(0)
    },
    wake() {
      if (enabled && paused && !running) schedule(0)
    },
    async stop() {
      enabled = false
      paused = false
      wantFull = false
      wantPass = false
      reconciled = null
      epoch += 1
      clearTimeout(timer)
      timer = undefined
      await running
    },
    async idle() {
      const busy = () => running ?? (timer === undefined ? undefined : wait(5))
      for (let next = busy(); next; next = busy()) await next
    },
  }
}

const STOPPED = 'E_MIRROR_STOPPED'

function stepping(host: MirrorHost, step: <T>(work: Promise<T>) => Promise<T>): MirrorHost {
  return {
    open: (known) => step(host.open(known)),
    bodies: (ids) => step(host.bodies(ids)),
    files: (ids) => step(host.files(ids)),
    hashes: (ids) => step(host.hashes(ids)),
    check: (generation, paths) => step(host.check(generation, paths)),
    apply: (generation, ops) => step(host.apply(generation, ops)),
  }
}

function forgetDisk(disk: Map<string, DiskState>, op: MirrorOp) {
  if ('path' in op && op.path !== null) disk.delete(op.path)
  if (op.kind === 'note' && op.from !== null) disk.delete(op.from)
}

export function observeWrites(storage: StorageAdapter, changed: () => void): StorageAdapter {
  const after =
    <A extends unknown[]>(write: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      await write(...args)
      changed()
    }
  return {
    listNotes: () => storage.listNotes(),
    getNote: (id, options) => storage.getNote(id, options),
    getBodies: (ids) => storage.getBodies(ids),
    searchNotes: (query, limit) => storage.searchNotes(query, limit),
    listTrash: () => storage.listTrash(),
    purgeNote: after((id: string, at: number, hlc: string) => storage.purgeNote(id, at, hlc)),
    putNote: after((note) => storage.putNote(note)),
    putFile: after((meta, data) => storage.putFile(meta, data)),
    copyFiles: after((noteId, copies) => storage.copyFiles(noteId, copies)),
    listBooks: () => storage.listBooks(),
    putBook: after((book) => storage.putBook(book)),
    listTags: () => storage.listTags(),
    putTag: after((tag) => storage.putTag(tag)),
    putNoteTag: after((link) => storage.putNoteTag(link)),
    getNoteTag: (noteId, tagId) => storage.getNoteTag(noteId, tagId),
    putRevision: (revision) => storage.putRevision(revision),
    listRevisions: (noteId) => storage.listRevisions(noteId),
    getRevision: (id) => storage.getRevision(id),
    deleteRevisions: (noteId, ids) => storage.deleteRevisions(noteId, ids),
    listCompactable: (from, to, page, limit) => storage.listCompactable(from, to, page, limit),
    compactRevisions: (ids, sweptAt) => storage.compactRevisions(ids, sweptAt),
    lastCompaction: () => storage.lastCompaction(),
    listActivity: (since) => storage.listActivity(since),
    listNoteActivity: (ids, since) => storage.listNoteActivity(ids, since),
    listAgentWrites: (limit) => storage.listAgentWrites(limit),
    markAgentWritesSeen: (noteId, writeIds) => storage.markAgentWritesSeen(noteId, writeIds),
  }
}
