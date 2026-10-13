// The Markdown mirror: Devot keeps a folder the user picked up to date with
// every note as a Markdown file, so other tools (editors, grep, Git,
// Spotlight, agents) read the notes without an export. SQLite stays the
// source of truth: the folder is written by Devot and never read back.
//
// The folder looks like an export of every notebook at once (export.ts):
// one folder per notebook (sub-notebooks nested), one `.md` file per note
// named after its title, one `attachments` folder at the top, and Devot's
// front matter where import would not read a note's title, tags or status
// back, so importing the folder gives the same notes. Notes in no notebook
// sit at the top. Templates and the Trash are left out.
//
// Rust holds the folder and its manifest (`.devot-mirror.json` in it; see
// src-tauri/src/mirror.rs) and runs the operations planned here, one by
// one, checking each against the manifest and the disk again before it
// acts. The manifest maps note and attachment IDs to the paths Devot wrote
// and the SHA-256 of each file. Devot moves or deletes only those paths,
// and only while they hold what it wrote: a file changed outside Devot is
// kept under a new name (`Plan (edited outside Devot).md`; Rust names it),
// dropped from the manifest so it is never touched again, and Devot writes
// its own version.
//
// Rules of the plan (`planMirror`, a pure function of the database, the
// manifest and what is known about the disk):
// - Names stay: a note keeps its file, and a notebook its folder, while the
//   name still fits its title (its file-safe stem, or the stem numbered), so
//   a change touches only the files it affects. A new name is the first of
//   `Plan.md`, `Plan 2.md`, ... free in its folder: not held by a file or
//   folder of the manifest (a moving one keeps its old name until the next
//   pass), nor given in this pass, nor anything else on disk (a folder Devot
//   did not make may be shared, a file never). Names are compared as export
//   numbers them (`nameKey`): two names macOS takes for one file, whatever
//   their case or the form of their accents, are one name (as, to be safe,
//   are two apart only by a compatibility form, `x²` and `x2`). A folder
//   keeps its name only across what macOS itself folds (`fileKey`).
// - A file the manifest does not list that holds exactly what Devot would
//   write there is taken back (Rust adopts it), not written again under
//   another name: a batch's files reach the disk before its manifest does,
//   so a crash or a quit in between leaves them unlisted, as does a folder
//   chosen again after its manifest was lost. An attachment's copy likewise,
//   by the hash of its bytes (asked only for a file in the way of a copy).
// - A path that reads `other` is a link or lies under something that is
//   not a real folder: the folders on the way are asked. A notebook's
//   folder that is no longer a real folder is lost, and the notebook gets a
//   new one; `attachments` cannot be replaced, so while it is not a real
//   folder only names are kept there, as with Include Attachments off.
// - A note's file is written only when what it is written from (`source`:
//   the note's update time, title, status, tags, path and the paths of the
//   attachments it shows) changed, or its file is missing or was changed.
// - Attachments: one copy for each attachment a mirrored note shows (with
//   Include Attachments), copied once and removed when no mirrored note
//   shows it any more. Without it, links still point at `attachments/<name>`
//   as in export and the manifest keeps the name, but no bytes are copied.
// - Work comes in slices (`limit`): a first mirror of many notes reads,
//   renders and writes a few hundred notes at a time.

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

// --- The manifest --------------------------------------------------------------

/** A note's file in the mirror, as the manifest records it. */
export interface MirrorNoteEntry {
  path: string
  /** The SHA-256 (hex) of the file Devot wrote. */
  sha256: string
  /** Its size in bytes. */
  size: number
  /** What it was written from (see `noteSource`). */
  source: string
  /** The attachments its Markdown shows. */
  files: string[]
}

/** An attachment in the mirror, as the manifest records it. */
export interface MirrorFileEntry {
  /** `attachments/<name>`. */
  path: string
  /** The SHA-256 of the copy Devot wrote; null: no copy, only the name (Include Attachments off). */
  sha256: string | null
  size: number
}

/** Everything Devot wrote in the folder, by note, attachment and notebook ID. */
export interface MirrorManifest {
  notes: Record<string, MirrorNoteEntry>
  files: Record<string, MirrorFileEntry>
  /** The folder of each notebook that holds mirrored notes (at any depth). */
  books: Record<string, string>
}

export const emptyManifest = (): MirrorManifest => ({ notes: {}, files: {}, books: {} })

/**
 * What is at a path in the folder: a regular file's SHA-256 (hex), a folder
 * (`dir`), anything else (`other`: a link, say), or nothing (null).
 */
export type DiskState = string | 'dir' | 'other' | null

const DIR = 'dir'
const OTHER = 'other'

/** Whether a disk state is a regular file (its hash). */
const isFile = (state: DiskState | undefined): state is string =>
  typeof state === 'string' && state !== DIR && state !== OTHER

// --- Operations ------------------------------------------------------------------

export type MirrorEntryKind = 'note' | 'file'

/** What Rust does in the folder, one operation at a time (src-tauri/src/mirror.rs). */
export type MirrorOp =
  /**
   * The file at `path` was changed outside Devot: it stays, renamed to a free
   * "edited outside Devot" name, and leaves the manifest.
   */
  | { kind: 'keep'; entry: MirrorEntryKind; id: string; path: string }
  /** The entry leaves the manifest; nothing on disk changes (its file is gone, or not Devot's). */
  | { kind: 'forget'; entry: MirrorEntryKind; id: string }
  /** Deletes Devot's file at `path`, which must still hold `sha256`, and drops the entry. */
  | { kind: 'remove'; entry: MirrorEntryKind; id: string; path: string; sha256: string }
  /**
   * Note `id` at `path` with the content whose SHA-256 is `sha256`: `text`,
   * left out when its file at `path` holds it already. `from`: its file now
   * (it must still hold what the manifest says, or `sha256`), moved there;
   * null when it has none (any old entry's file must be gone). A file
   * already at `path` that is not Devot's is never replaced, unless it holds
   * exactly `text`: then Devot takes it as its own.
   */
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
  /** Attachment `id` at `path`: copied from the database (`copy`), or only its name kept. */
  | { kind: 'file'; id: string; path: string; copy: boolean }
  /** Records the folder of notebook `id` (null: forgets it). */
  | { kind: 'book'; id: string; path: string | null }

/** What Rust did with one operation. */
export interface MirrorResult {
  /** The error code, when the operation was not done. */
  code?: string
  /** E_MIRROR_EXISTS and E_MIRROR_CHANGED: the path in the way, and what is there now. */
  path?: string
  state?: DiskState
  /** note and file operations: the size of the file (0 for a name only). */
  size?: number
  /** file operations that copied: the copy's SHA-256. */
  sha256?: string | null
  /** keep: the path the file was kept under. */
  kept?: string
}

/** The manifest after `op` succeeded with `result`. */
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

// --- Note files ------------------------------------------------------------------

/** What a note's file is rendered from (see `renderMirrorText`). */
export interface MirrorTextSpec {
  id: string
  /** Identifies the inputs: a text rendered under another key is stale. */
  key: string
  title: string
  bodyMd: string
  tags: string[]
  status: NoteStatus
  /** The file's path in the folder (its rendering is kept by note and path). */
  path: string
  fileName: string
  /** Each attachment the note shows, with its path from the note's folder. */
  paths: [string, string][]
}

/** A note's file: its Markdown and the SHA-256 the manifest records. */
export interface MirrorText {
  key: string
  text: string
  sha256: string
}

/** Renders a note's file (export's Markdown file for it, see export.ts). */
export function renderMirrorText(spec: MirrorTextSpec): MirrorText {
  const text = markdownFile(
    { title: spec.title, bodyMd: spec.bodyMd, tags: spec.tags, status: spec.status },
    spec.fileName,
    new Map(spec.paths),
  )
  return { key: spec.key, text, sha256: sha256Hex(text) }
}

/** A short hash of `text` (64 bits, hex); it tells whether a note's inputs changed. */
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

/**
 * What a note's file is written from: its update time (any body change
 * moves it), title, status, tags, path, and the path of each attachment it
 * shows (`-` for one that is not in the database).
 */
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

// --- Paths -----------------------------------------------------------------------

const joinPath = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0))
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
/**
 * A path's key: its names' keys (`nameKey`), joined by a character no name
 * holds, so two paths with one key name one file.
 */
const pathKey = (path: string) => path.split('/').map(nameKey).join('\u0000')

/** Whether `name` is `stem` + `ext`, or `stem N` + `ext` with N of 2 or more. */
function fits(name: string, stem: string, ext: string): boolean {
  if (!name.endsWith(ext)) return false
  const base = name.slice(0, name.length - ext.length)
  if (base === stem) return true
  return base.startsWith(`${stem} `) && /^(?:[2-9]|[1-9]\d+)$/.test(base.slice(stem.length + 1))
}

/** `name` with ` n` before its extension (`board 2.png`), as Rust numbers attachments. */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} ${n}${name.slice(dot)}` : `${name} ${n}`
}

/** Child names of folders, by their keys (`nameKey`, `pathKey`). */
class Names {
  private readonly byFolder = new Map<string, Set<string>>()

  /** Marks every folder on `path` and its last name as taken. */
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

// --- The plan ----------------------------------------------------------------------

export interface MirrorPlanInput {
  /** Live notes, as `StorageAdapter.listNotes` lists them (templates are left out here). */
  notes: readonly NoteSummary[]
  books: readonly BookRecord[]
  tags: readonly TagRecord[]
  manifest: MirrorManifest
  includeAttachments: boolean
  /** The name of a note without a title (the UI's "Untitled"). */
  untitled: string
  /** Note bodies (Markdown snapshots) by ID, as far as known. */
  bodies: ReadonlyMap<string, string>
  /** Attachments by ID: their file name (Rust's, see `mirror_files`), or null when not in the database. */
  files: ReadonlyMap<string, string | null>
  /**
   * Attachments by ID: the SHA-256 of their bytes (Rust's, see
   * `mirror_hashes`), or null when not in the database; asked only for one
   * whose copy has a file in the way.
   */
  hashes: ReadonlyMap<string, string | null>
  /**
   * Rendered note files by note ID, then by the path each was rendered for
   * (see `needs.texts`): a note may be rendered for a place it does not take
   * in the end, to tell whether a file there is its own.
   */
  texts: ReadonlyMap<string, ReadonlyMap<string, MirrorText>>
  /** What is on disk at paths in the folder, as far as known. */
  disk: ReadonlyMap<string, DiskState>
  /** Notes to leave as they are in this pass (their work failed). */
  skip?: ReadonlySet<string>
  /** At most this many notes get new files in one plan; the rest wait (`deferred`). */
  limit?: number
  /** Results of pure steps kept between plans of one pass (see `createMirrorMemo`). */
  memo?: MirrorMemo
}

/**
 * What one pass's plans compute again and again for the same inputs (file
 * stems of titles, note sources), kept so a plan over many notes stays
 * short. Only a cache: a plan gives the same result with or without it.
 */
export interface MirrorMemo {
  stems: Map<string, string>
  sources: Map<string, string>
  /** The attachments each body shows, by body. */
  links: Map<string, string[]>
}

export const createMirrorMemo = (): MirrorMemo => ({
  stems: new Map(),
  sources: new Map(),
  links: new Map(),
})

export interface MirrorPlan {
  /**
   * What the plan still needs: note bodies, attachment names and hashes,
   * rendered files and disk states. The operations are final only when all
   * five are empty.
   */
  needs: {
    bodies: string[]
    files: string[]
    hashes: string[]
    texts: MirrorTextSpec[]
    paths: string[]
  }
  /** The operations, in the order to run them. */
  ops: MirrorOp[]
  /** Notes left for a later plan by `limit`. */
  deferred: number
}

interface Place {
  folder: string
  name: string
  depth: number
}

/** The mirror's operations for the database as it is (see the rules at the top). */
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
  // Tag names (sorted) by tag set, and file stems by title, worked out once.
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
  /** A file Devot's entry no longer holds (replaced by a folder or a link). */
  const lost = (path: string) => {
    const state = known(path)
    return state === DIR || state === OTHER
  }
  /** A notebook's folder, or `attachments`, that is no longer a real folder (a link or a file). */
  const folderLost = (path: string) => {
    const state = known(path)
    return state !== undefined && state !== null && state !== DIR
  }

  // --- Attachments every mirrored note shows, and the path of each.
  const links = input.memo?.links ?? new Map<string, string[]>()
  const linksOf = (body: string) => {
    let ids = links.get(body)
    if (!ids) {
      ids = attachmentIds(body)
      links.set(body, ids)
    }
    return ids
  }
  // A note's body, once read (it is rendered from it), else what it showed
  // when last written.
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
  // The attachments of notes left as they are this pass stay as they are.
  const held = new Set<string>()
  for (const id of skip) for (const fileId of manifest.notes[id]?.files ?? []) held.add(fileId)
  // While `attachments` is not a real folder, no copy can go there.
  const attachmentsLost = folderLost(ATTACHMENTS_FOLDER)
  const copies = input.includeAttachments && !attachmentsLost
  /**
   * Whether a file is the copy of attachment `id` (one a batch wrote before
   * the manifest listing it was saved), by its bytes' hash: asked when not
   * known, and until then the file is taken to be the copy (the notes that
   * show it wait for the answer).
   */
  const isCopy = (id: string, state: DiskState | undefined) => {
    if (!copies || !isFile(state)) return false
    const hash = input.hashes.get(id)
    if (hash === undefined) needHashes.add(id)
    return hash === undefined || hash === state
  }
  // Each wanted attachment's path: its manifest path while it still fits,
  // else the first free numbered name in `attachments`.
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
  /** Whether `path` is free for attachment `id`: no other has it, and nothing else is there but its copy. */
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

  // --- What a note's file at a place is rendered from.
  /**
   * The attachments `note` shows, with their paths from a file `depth`
   * folders down, and the key of its file at `path`; undefined while one of
   * them is not decided (its name or its hash not known yet).
   */
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
  /**
   * Whether a file the manifest does not list, at `path`, holds exactly
   * what Devot would write there for `note`: by the note rendered for that
   * very place, so whatever the note was rendered for before, it finds its
   * own file. Until that is rendered the file is taken to be its own.
   */
  const holdsText = (note: NoteSummary, path: string, depth: number, state: DiskState) => {
    if (!isFile(state)) return false
    const layout = layoutAt(note, path, depth)
    const text = input.texts.get(note.id)?.get(path)
    return layout === undefined || text?.key !== layout.key || text.sha256 === state
  }

  // --- Layout: a folder for each notebook that holds notes, a name for each note.
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
    /**
     * Whether `name` is free here for a notebook's folder, or for the file
     * of `note`, whose own path now is `own` (see `ownPath`).
     */
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
      // A folder Devot did not make may be shared; a file is the note's only
      // when it holds exactly what Devot would write there for it.
      return note === undefined ? state === DIR : holdsText(note, path, depth, state)
    }
    /** The note's or notebook's own path when it is in this folder, a name it may take again (a case change). */
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

  // --- Which notes need a new file.
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
  // Recently changed notes first; the rest of a large first mirror waits.
  candidates.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
  const limit = input.limit ?? Infinity
  const active = candidates.slice(0, limit)
  for (const note of active) if (!input.bodies.has(note.id)) needBodies.add(note.id)

  // --- Operations.
  const keeps: MirrorOp[] = []
  const forgets: MirrorOp[] = []
  const removes: MirrorOp[] = []
  const fileOps: MirrorOp[] = []
  const noteOps: MirrorOp[] = []
  const bookOps: MirrorOp[] = []
  /** Takes an entry's file out of the mirror: removed while it is Devot's, kept when changed. */
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
      // Unchanged in place: only what the manifest records may change.
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
      // A new place (its own name in another case too): what is there, and
      // every folder on the way, must be known.
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

  // Which attachments stay is known once every one a note shows is known.
  const filesKnown = needFiles.size === 0
  for (const [id, entry] of filesKnown ? Object.entries(manifest.files) : []) {
    // Shown by a note left as it is this pass: it is left as it is too.
    if (held.has(id) && !wanted.has(id)) continue
    const keepName = wanted.has(id) && filePath.get(id) === entry.path
    if (entry.sha256 === null) {
      if (!keepName) forgets.push({ kind: 'forget', entry: 'file', id })
      continue
    }
    // A copy goes when no mirrored note shows it, when copies are off, or
    // when it moved; one changed outside Devot stays under a new name.
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

// --- Running it ----------------------------------------------------------------

/** What a pass learns when it starts (Rust's `mirror_open`). */
export interface MirrorOpened {
  /** Changes whenever the folder or Include Attachments changes. */
  generation: number
  includeAttachments: boolean
  /** The folder's manifest; null when the caller already holds this generation's. */
  manifest: MirrorManifest | null
}

/** The folder side of the mirror (in the app: Rust, see src-tauri/src/mirror.rs). */
export interface MirrorHost {
  /**
   * Starts a pass: checks the folder (and resumes a paused mirror) and hands
   * over the manifest unless `known` is its generation. Throws E_MIRROR_OFF,
   * or the code the mirror paused with.
   */
  open(known: number | null): Promise<MirrorOpened>
  /** The Markdown snapshots of these notes (live ones only). */
  bodies(ids: readonly string[]): Promise<{ id: string; bodyMd: string }[]>
  /** The attachments among `ids` that are in the database, with their file names. */
  files(ids: readonly string[]): Promise<{ id: string; name: string }[]>
  /** The attachments among `ids` that are in the database, with the SHA-256 of their bytes. */
  hashes(ids: readonly string[]): Promise<{ id: string; sha256: string }[]>
  /**
   * What is on disk at `paths`; for null, at every manifest path whose file
   * does not hold what the manifest says (the others are left out).
   */
  check(generation: number, paths: readonly string[] | null): Promise<Record<string, DiskState>>
  /** Runs the operations in order: one result each, up to a failure that stops them all. */
  apply(generation: number, ops: readonly MirrorOp[]): Promise<MirrorResult[]>
}

export interface MirrorRunnerOptions {
  storage: Pick<StorageAdapter, 'listNotes' | 'listBooks' | 'listTags'>
  host: MirrorHost
  /** The name of a note without a title. */
  untitled: string
  /** A pass runs this long after the last change... */
  delayMs?: number
  /** ...but no later than this after the first one it waits for. */
  maxWaitMs?: number
  /** A paused mirror checks its folder again this often (and on `wake`). */
  retryMs?: number
  /** Notes rendered and written per slice. */
  slice?: number
  /** Reports a pass that ended with an error code (logs). */
  onError?: (code: string) => void
  /** Hands the event loop back between steps (the worker answers the UI meanwhile). */
  yieldNow?: () => Promise<void>
}

export interface MirrorRunner {
  /** Something the mirror follows changed: a pass runs soon (coalesced). */
  touch(): void
  /**
   * The mirror is on (turned on, launched, restored, settings changed): a
   * full pass runs soon, unless one for `generation` (Rust's, when known)
   * runs or ran already (a resume starts one itself).
   */
  reconcile(generation?: number): void
  /** A paused mirror checks its folder now (the window came to the front). */
  wake(): void
  /**
   * The mirror is off (or the app quits): nothing more runs until
   * `reconcile`. A pass running ends after the call it is in (a batch of
   * operations finishes, so the manifest records it); settles then.
   */
  stop(): Promise<void>
  /** Settles once no pass runs or waits (tests). */
  idle(): Promise<void>
}

/** Codes after which the mirror waits for its folder (Rust shows it paused). */
const PAUSED = /^E_MIRROR_(FOLDER|MANIFEST)_/
/** Codes for something in the way: the plan learns what is there and tries again. */
const RETRYABLE = new Set(['E_MIRROR_EXISTS', 'E_MIRROR_CHANGED'])
/** An operation was planned from a manifest Rust has moved past. */
const STALE = 'E_MIRROR_STALE'
/** A safety net: a pass never plans more often than this. */
const MAX_PLANS = 10_000
/** Times an entry's operation may meet something in the way in one pass. */
const MAX_TRIES = 3
/**
 * Times a note's file may be rendered in one pass: one whose place keeps
 * changing (something new in its way every time) is then left as it is, so
 * it never holds up the others.
 */
const MAX_RENDERS = 10
/** The code for a note left as it is because its place never settled. */
const UNSETTLED = 'E_MIRROR_UNSETTLED'
const CHUNK = { bodies: 200, files: 1000, hashes: 20, paths: 2000, ops: 200 }

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const chunks = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** One key per manifest entry an operation acts on. */
const entryKey = (op: MirrorOp) =>
  op.kind === 'book'
    ? `book:${op.id}`
    : `${op.kind === 'note' ? 'note' : op.kind === 'file' ? 'file' : op.entry}:${op.id}`

/**
 * Runs mirror passes: one soon after changes (coalesced), a full one (every
 * manifest file checked on disk) when the mirror starts, and checks of a
 * paused mirror's folder until it can go on. Passes run one at a time and
 * hand the event loop back between steps.
 */
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
  // Counts stops: a pass ends at its next step once the count moved on.
  let epoch = 0
  // The manifest as Rust holds it, and the generation it belongs to.
  let manifest: MirrorManifest | null = null
  let generation: number | null = null
  // The generation of the full pass running or done last, and the one a
  // reconcile asked for while a pass ran (null: not known).
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
    /** What a step resolves to, unless the mirror stopped meanwhile. */
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
    // Entries whose operation failed for good in this pass, and how often
    // something was in the way of each (a few tries, then it waits).
    const failed = new Set<string>()
    const tries = new Map<string, number>()
    // How often each note's file was rendered in this pass.
    const renders = new Map<string, number>()
    let stale = false
    if (full) {
      // Every manifest file holds what it should, except those Rust lists.
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
          // Read the manifest again next time.
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

  /** Learns what a plan needs: bodies, attachment names and hashes, rendered files and disk states. */
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

/** The code a pass ends with when the mirror stopped while it ran (not a failure). */
const STOPPED = 'E_MIRROR_STOPPED'

/** `host` with each call's result passed through `step`. */
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

/** Forgets what the disk held at the paths an operation changed (they are the manifest's now). */
function forgetDisk(disk: Map<string, DiskState>, op: MirrorOp) {
  if ('path' in op && op.path !== null) disk.delete(op.path)
  if (op.kind === 'note' && op.from !== null) disk.delete(op.from)
}

// --- Following the database --------------------------------------------------

/**
 * `storage` calling `changed` after each write the mirror follows: notes,
 * their tags, notebooks, tags and attachments (not revisions).
 */
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
  }
}
