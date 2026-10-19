// Markdown export: a note, or a notebook with its sub-notebooks, as Markdown files with their attachments. Rust shows the panels and writes the files
// (src-tauri/src/export.rs); this module decides what goes where.
//
// Rules:
// - A note is one `.md` file named after its title; a notebook is a folder (sub-notebooks nested like the sidebar). "All notes" is every top-level notebook in sidebar
//   order, with notes in no notebook at the top (never Templates or the Trash); chosen notes are files side by side. Names are made safe for the file system and
//   numbered when two would be the same (`Plan.md`, `Plan 2.md`) as macOS takes them (`nameKey`).
// - The body is the note's Markdown as it is, apart from two things:
//   - attachments (`devot://file/<id>` image destinations with a UUIDv7, and the `src` of a raw HTML `<img>`) are copied once each into an `attachments` folder at the
//     top, and their links become relative paths, percent-encoded where a character would end or change the link (`&`, `|`, spaces, quotes in HTML). A size preset
//     stays as the path's fragment (`attachments/shot.png#half`), which other tools ignore and import reads back. An image whose link cannot be found keeps it and is
//     listed as a problem;
//   - title, tags and status go into front matter where import would not read them back from the file: import reads them only from Devot's own block (opened by the
//     comment EXPORT_HEADER), so a note whose title is not its first heading or file name, or that has tags or a status, gets that block first. A note's own front
//     matter is never changed; if its first line is EXPORT_HEADER the note always gets the block, so import leaves out only the one export added. Values are
//     single-quoted, or double-quoted with escapes when they cannot be written on one line as they are.
//   So export then import gives the same notes (title, body, tags, status, notebooks and images).
// - Note links (`devot://note/<id>`) stay as they are.

import { bookOrder, buildBookTree, type BookService } from './books'
import { errorCode } from './errors'
import {
  EXPORT_HEADER,
  isExportBlock,
  markdownFacts,
  mayShowImages,
  type MarkdownFacts,
} from './import'
import { FILE_ID_SOURCE, fileUri } from './files'
import { splitImageSize, withImageSize, type ImageSize } from './images'
import type { NoteService } from './notes'
import type { BookRecord, NoteStatus } from './storage'
import type { TagService } from './tags'
import { replaceRanges, type TextEdit } from './text'

export const ATTACHMENTS_FOLDER = 'attachments'

const MAX_NAME_BYTES = 200

export type ExportTarget =
  | { kind: 'note'; noteId: string }
  | { kind: 'notebook'; bookId: string }
  | { kind: 'all'; name: string }
  | { kind: 'notes'; noteIds: readonly string[]; name: string }

export interface ExportEntry {
  noteId: string
  title: string
  bodyMd: string
  tags: string[]
  status: NoteStatus
  folder: string[]
  stem: string
}

export interface ExportPlan {
  name: string
  entries: ExportEntry[]
}

export interface ExportProblem {
  noteId: string
  fileId?: string
  code: string
}

export interface ExportSink {
  /** Null when the user cancelled. A note's export gets the file name the user chose. */
  begin(name: string): Promise<{ fileName?: string | null } | null>
  attach(fileId: string): Promise<string>
  write(path: string, text: string): Promise<void>
}

export interface ExportReport {
  notes: number
  attachments: number
  problems: ExportProblem[]
}

const encoder = new TextEncoder()

function clipBytes(text: string, max: number): string {
  // A UTF-16 code unit is at most three UTF-8 bytes: short text fits as it is.
  if (text.length * 3 <= max) return text
  let out = ''
  let bytes = 0
  for (const char of text) {
    bytes += encoder.encode(char).length
    if (bytes > max) break
    out += char
  }
  return out
}

export function fileStem(text: string, fallback: string): string {
  const cleaned = text
    .replace(/[\p{Cc}\p{Cf}/\\:]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
  const clipped = clipBytes(cleaned, MAX_NAME_BYTES).trim()
  return clipped || fallback
}

/** What a file or folder name is to macOS: two names with one key name one file. APFS ignores case (fully folded: ss, fi) and the form of accents, but not compatibility forms (`x²` and `x2`). */
export function fileKey(name: string): string {
  return name.normalize('NFD').toLowerCase().toUpperCase().normalize('NFD')
}

/** `fileKey` plus compatibility forms folded, so two names macOS takes for one always clash; at worst a name is numbered that did not need it (`x2` after `x²`). */
export function nameKey(name: string): string {
  return name.normalize('NFKD').toLowerCase().toUpperCase().normalize('NFKD')
}

function unique(stem: string, taken: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? stem : `${stem} ${n}`
    const key = nameKey(name)
    if (!taken.has(key)) {
      taken.add(key)
      return name
    }
  }
}

export interface PlanOptions {
  notes: NoteService
  books: BookService
  tags: TagService
  target: ExportTarget
  untitled: string
}

export function exportName(target: ExportTarget): string | null {
  return target.kind === 'all' || target.kind === 'notes' ? fileStem(target.name, '_') : null
}

export async function planExport(options: PlanOptions): Promise<ExportPlan> {
  const { notes, books, tags, target, untitled } = options
  const [summaries, tagRecords] = await Promise.all([notes.list(), tags.list()])
  const tagNames = new Map(tagRecords.map((t) => [t.id, t.name]))
  const byId = new Map(summaries.map((n) => [n.id, n]))
  const entry = async (
    id: string,
    folder: string[],
    stem: (title: string) => string,
  ): Promise<ExportEntry> => {
    const summary = byId.get(id)
    const note = await notes.read(id)
    return {
      noteId: id,
      title: note.title,
      bodyMd: note.bodyMd,
      tags: (summary?.tagIds ?? []).flatMap((t) => tagNames.get(t) ?? []).sort(),
      status: summary?.status ?? 'none',
      folder,
      stem: stem(note.title),
    }
  }

  if (target.kind === 'note') {
    const only = await entry(target.noteId, [], (title) => fileStem(title, untitled))
    return { name: only.stem, entries: [only] }
  }

  if (target.kind === 'notes') {
    const files = new Set<string>()
    const entries: ExportEntry[] = []
    for (const id of new Set(target.noteIds)) {
      // A chosen note deleted since is left out; the others still export.
      const read = await entry(id, [], (title) => unique(fileStem(title, untitled), files)).catch(
        (error: unknown) => {
          if (errorCode(error) === 'E_NOTE_NOT_FOUND') return null
          throw error
        },
      )
      if (read) entries.push(read)
    }
    return { name: fileStem(target.name, '_'), entries }
  }

  const all = await books.list()
  const children = new Map<string, BookRecord[]>()
  for (const book of all) {
    if (book.parentId === null || book.id === book.parentId) continue
    const list = children.get(book.parentId) ?? []
    list.push(book)
    children.set(book.parentId, list)
  }
  const byBook = new Map<string, typeof summaries>()
  for (const note of summaries) {
    if (note.bookId === null) continue
    const list = byBook.get(note.bookId) ?? []
    list.push(note)
    byBook.set(note.bookId, list)
  }
  const entries: ExportEntry[] = []
  const seen = new Set<string>()
  /** Returns every name taken there (including the attachments folder at the top), so a sub-notebook's folder never takes a note's file name or the attachments folder. */
  const fill = async (notesHere: typeof summaries, folder: string[]) => {
    const files = new Set<string>()
    const taken = new Set<string>(folder.length === 0 ? [nameKey(ATTACHMENTS_FOLDER)] : [])
    const ordered = [...notesHere].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    )
    for (const note of ordered) {
      const added = await entry(note.id, folder, (title) =>
        unique(fileStem(title, untitled), files),
      )
      for (const extension of ['md', 'html']) taken.add(nameKey(`${added.stem}.${extension}`))
      entries.push(added)
    }
    return taken
  }
  const walk = async (book: BookRecord, folder: string[]) => {
    // A parent cycle (from concurrent moves) is walked once.
    if (seen.has(book.id)) return
    seen.add(book.id)
    const taken = await fill(byBook.get(book.id) ?? [], folder)
    const subs = [...(children.get(book.id) ?? [])].sort((a, b) => bookOrder(a, b))
    for (const sub of subs) {
      await walk(sub, [...folder, unique(fileStem(sub.name, '_'), taken)])
    }
  }

  if (target.kind === 'notebook') {
    const root = all.find((b) => b.id === target.bookId)
    if (!root) throw new Error('E_BOOK_NOT_FOUND')
    await walk(root, [])
    return { name: fileStem(root.name, '_'), entries }
  }

  // Notes in no notebook (or in one that is gone) at the top, then each top-level notebook as the sidebar shows it, a parent cycle's notebooks among them.
  const known = new Map(all.map((b) => [b.id, b]))
  const loose = summaries.filter((n) => n.bookId === null || !known.has(n.bookId))
  const taken = await fill(loose, [])
  for (const node of buildBookTree(all)) {
    const book = known.get(node.id)!
    await walk(book, [unique(fileStem(book.name, '_'), taken)])
  }
  return { name: fileStem(target.name, '_'), entries }
}

/** Any other ID names no attachment, so its image stays as written (Rust would refuse it, and the whole page with it). */
export const FILE_URL = new RegExp(`^${fileUri(`(${FILE_ID_SOURCE})`)}$`)

function attachmentOf(url: string): { id: string; size: ImageSize } | null {
  const sized = splitImageSize(url)
  const id = FILE_URL.exec(sized.url)?.[1]
  return id === undefined ? null : { id, size: sized.size }
}

const attachmentsOf = (urls: readonly string[]) => [
  ...new Set(urls.flatMap((url) => attachmentOf(url)?.id ?? [])),
]

export function attachmentIds(markdown: string): string[] {
  // Without a `![` or an `<img` there is no image: nothing to parse.
  if (!mayShowImages(markdown)) return []
  return attachmentsOf(markdownFacts(markdown).links.map((link) => link.url))
}

const percentEncoded = (c: string) =>
  Array.from(encoder.encode(c), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')

/** Percent-encodes characters that would end or change a link destination: spaces, parentheses, angle brackets, `%`, `#`, `?`, `&` (starts a character reference), `|` (ends a table cell), backslashes, control characters. */
export function linkPath(path: string): string {
  return path.replace(/[\s()<>%#?&|\\\p{Cc}]/gu, percentEncoded)
}

/** As `linkPath`, plus quotes, `=` and backticks, so it is one value however the attribute is quoted. */
export function attributePath(path: string): string {
  return linkPath(path).replace(/["'=`]/g, percentEncoded)
}

export function relativeHref(folder: readonly string[], path: readonly string[]): string {
  let shared = 0
  while (shared < folder.length && shared < path.length - 1 && folder[shared] === path[shared]) {
    shared += 1
  }
  const up = folder.slice(shared).map(() => '..')
  return [...up, ...path.slice(shared).map(encodeURIComponent)].join('/')
}

/** Control characters, the line and paragraph separators (line breaks to some readers), a byte order mark and unpaired surrogates. */
const UNWRITABLE = /[\p{Cc}\p{Zl}\p{Zp}\uFEFF]|\p{Cs}/u
const ESCAPED = /[\\"\p{Cc}\p{Zl}\p{Zp}\uFEFF]|\p{Cs}/gu

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
}

/** Single-quoted when it can be written as it is, else double-quoted with escapes, which import reads back exactly in Devot's block. */
function quoted(value: string): string {
  if (!UNWRITABLE.test(value)) return `'${value.replace(/'/g, "''")}'`
  const escaped = value.replace(
    ESCAPED,
    (c) => SHORT_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
  )
  return `"${escaped}"`
}

const statusValue = (status: NoteStatus) => status.replace(/_/g, '-')

/** `facts` are what `markdownFacts` reads from the body, when the caller has them already. */
export function markdownFile(
  entry: Pick<ExportEntry, 'title' | 'bodyMd' | 'tags' | 'status'>,
  fileName: string,
  paths: ReadonlyMap<string, string>,
  facts: MarkdownFacts = markdownFacts(entry.bodyMd),
): string {
  // One parse of the note: new image destinations change neither its title
  // nor its front matter.
  const edits: TextEdit[] = facts.links.flatMap((link) => {
    const file = attachmentOf(link.url)
    const path = file ? paths.get(file.id) : undefined
    if (!file || path === undefined) return []
    const dest = link.html ? attributePath(path) : linkPath(path)
    return [{ start: link.start, end: link.end, text: withImageSize(dest, file.size) }]
  })
  const body = replaceRanges(entry.bodyMd, edits)
  const titleKept = facts.title(fileName) === entry.title
  const devotBlock = () => {
    const lines = ['---', EXPORT_HEADER, `title: ${quoted(entry.title)}`]
    if (entry.tags.length > 0) lines.push(`tags: [${entry.tags.map(quoted).join(', ')}]`)
    if (entry.status !== 'none') lines.push(`status: ${statusValue(entry.status)}`)
    lines.push('---', '')
    return lines.join('\n') + body
  }

  // Import reads only Devot's block, and leaves out only the first one.
  const ownBlock = facts.frontMatter !== null && isExportBlock(facts.frontMatter)
  if (!ownBlock && titleKept && entry.tags.length === 0 && entry.status === 'none') return body
  return devotBlock()
}

export interface ExportOptions extends PlanOptions {
  sink: ExportSink
}

export async function exportMarkdown(options: ExportOptions): Promise<ExportReport | null> {
  const { sink } = options
  // A folder whose name is known asks first: every note is read only once
  // the user has chosen where they go.
  const known = exportName(options.target)
  const asked = known === null ? undefined : await sink.begin(known)
  if (asked === null) return null
  const plan = await planExport(options)
  const begun = asked ?? (await sink.begin(plan.name))
  if (!begun) return null
  const problems: ExportProblem[] = []
  const copied = new Set<string>()
  let written = 0
  for (const entry of plan.entries) {
    const fileName =
      options.target.kind === 'note' && begun.fileName ? begun.fileName : `${entry.stem}.md`
    const up = '../'.repeat(entry.folder.length)
    const paths = new Map<string, string>()
    // The note is read once: its images, then its file.
    const facts = markdownFacts(entry.bodyMd)
    for (const fileId of attachmentsOf(facts.links.map((link) => link.url))) {
      try {
        paths.set(fileId, up + (await sink.attach(fileId)))
        copied.add(fileId)
      } catch (error) {
        problems.push({ noteId: entry.noteId, fileId, code: errorCode(error, 'E_EXPORT_FAILED') })
      }
    }
    for (const fileId of attachmentsOf(facts.unlocated)) {
      problems.push({ noteId: entry.noteId, fileId, code: 'E_EXPORT_IMAGE_UNLOCATED' })
    }
    try {
      const text = markdownFile(entry, fileName, paths, facts)
      await sink.write([...entry.folder, fileName].join('/'), text)
      written += 1
    } catch (error) {
      problems.push({ noteId: entry.noteId, code: errorCode(error, 'E_EXPORT_FAILED') })
    }
  }
  return { notes: written, attachments: copied.size, problems }
}
