// Markdown export: a note, or a notebook with its sub-notebooks, as Markdown
// files with their attachments. Rust shows the panels and writes the files
// (src-tauri/src/export.rs); this module decides what goes where.
//
// Rules:
// - A note is one `.md` file named after its title. A notebook becomes a
//   folder named after it, each sub-notebook a folder inside it (nested
//   like the sidebar), each note a file in its notebook's folder. Names are
//   made safe for the file system and numbered when two would be the same
//   (`Plan.md`, `Plan 2.md`): the same as macOS takes them, whatever their
//   case or the form of their accents, or (to be safe) a compatibility
//   form (`nameKey`).
// - The body is the note's Markdown as it is, apart from two things:
//   - attachments (`devot://file/<id>` image destinations with a UUIDv7,
//     the ones import makes, and the `src` of an `<img>` in raw HTML) are
//     copied into an `attachments` folder at the top of the export, once
//     each, and their links become relative paths to them (percent-encoded
//     where a character would end or change the link: `&`, `|`, spaces of
//     any kind, and in HTML quotes too; any other `devot://file/` link stays
//     as written); a size preset stays as the path's fragment
//     (`attachments/shot.png#half`), which other Markdown tools ignore when
//     they load the image and import reads back; an image whose link cannot
//     be found in the text keeps it and is listed as a problem;
//   - the note's title, tags and status go into front matter where import
//     would not read them back from the file: a note without front matter
//     of its own gets a block of Devot's (opened by the comment
//     EXPORT_HEADER, which import leaves out of the note again, reading
//     its values exactly); a note with front matter of its own gets the
//     keys that disagree set in it (tags compared exactly, case included),
//     unless its own front matter cannot say them exactly (an empty title,
//     which import would replace with the heading or file name; a title
//     import would tidy, with spaces at its ends, several in a row or of
//     another kind; a tag that starts with `#`, which import drops; a value
//     that needs escapes) or would itself read as Devot's block (its first
//     line is EXPORT_HEADER): then Devot's block goes before the note's own
//     front matter, which stays as it is. Values are single-quoted, or
//     double-quoted with escapes when they hold what cannot be written on
//     one line as it is (control characters, line or paragraph separators,
//     a byte order mark).
//   So export then import gives the same notes (title, body, tags, status,
//   notebooks and images); a note with front matter of its own comes back
//   with the keys export set in it.
// - Note links (`devot://note/<id>`) stay as they are.

import { bookOrder, type BookService } from './books'
import { errorCode } from './errors'
import {
  EXPORT_HEADER,
  isExportBlock,
  markdownFacts,
  mayShowImages,
  noteTitle,
  setFrontMatterKeys,
  type MarkdownFacts,
} from './import'
import { FILE_ID_SOURCE, fileUri } from './files'
import { splitImageSize, withImageSize, type ImageSize } from './images'
import type { NoteService } from './notes'
import type { BookRecord, NoteStatus } from './storage'
import type { TagService } from './tags'
import { replaceRanges, type TextEdit } from './text'

/** The folder at the top of an export that holds the attachments. */
export const ATTACHMENTS_FOLDER = 'attachments'

/** File and folder names, in UTF-8 bytes (a name may take 255; numbering adds a few). */
const MAX_NAME_BYTES = 200

export type ExportTarget = { kind: 'note'; noteId: string } | { kind: 'notebook'; bookId: string }

/** A note as it is exported. */
export interface ExportEntry {
  noteId: string
  title: string
  bodyMd: string
  /** Tag names. */
  tags: string[]
  status: NoteStatus
  /** The folders from the top of the export down to the note's file. */
  folder: string[]
  /** The file name without its extension. */
  stem: string
}

export interface ExportPlan {
  /** The note's file name or the notebook's folder name, without extension. */
  name: string
  entries: ExportEntry[]
}

export interface ExportProblem {
  noteId: string
  /** The attachment, when the problem is one of the note's images. */
  fileId?: string
  code: string
}

/** Where export writes (in the app: Tauri commands). */
export interface ExportSink {
  /**
   * Asks where the export goes; null when the user cancelled. A note's
   * export gets the file name the user chose.
   */
  begin(name: string): Promise<{ fileName?: string | null } | null>
  /** Copies attachment `fileId` into the export; resolves to its path from the top. */
  attach(fileId: string): Promise<string>
  /** Writes a file at `path` (from the top, `/`-separated). */
  write(path: string, text: string): Promise<void>
}

export interface ExportReport {
  notes: number
  attachments: number
  problems: ExportProblem[]
}

// --- Names -----------------------------------------------------------------

const encoder = new TextEncoder()

/** `text` cut to at most `max` UTF-8 bytes, never inside a character. */
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

/**
 * `text` as a file or folder name (without extension): on one line, without
 * path separators, colons or a leading dot, at most 200 bytes; `fallback`
 * when nothing is left.
 */
export function fileStem(text: string, fallback: string): string {
  const cleaned = text
    .replace(/[\p{Cc}\p{Cf}/\\:]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
  const clipped = clipBytes(cleaned, MAX_NAME_BYTES).trim()
  return clipped || fallback
}

/**
 * What a file or folder name is to macOS: two names with one key name one
 * file. APFS ignores case, folding it fully (the German sharp s is `ss`,
 * the fi ligature `fi`), and the form of accents (an accented letter
 * written as one code point or as a letter and a combining mark), but not
 * compatibility forms: `x²` and `x2`, or full-width letters and plain
 * ones, name two files.
 */
export function fileKey(name: string): string {
  return name.normalize('NFD').toLowerCase().toUpperCase().normalize('NFD')
}

/**
 * The key names are numbered by: `fileKey`, and compatibility forms folded
 * too, so two names macOS takes for one always clash, and at worst a name
 * is numbered that did not need it (`x2` after `x²`).
 */
export function nameKey(name: string): string {
  return name.normalize('NFKD').toLowerCase().toUpperCase().normalize('NFKD')
}

/** `stem`, or `stem 2`, `stem 3`, ...: the first whose `nameKey` is not in `taken`; takes it. */
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

// --- Planning ----------------------------------------------------------------

export interface PlanOptions {
  notes: NoteService
  books: BookService
  tags: TagService
  target: ExportTarget
  /** The name of a note without a title (the UI's "Untitled"). */
  untitled: string
}

/** What an export writes: the note, or the notebook's notes, and where. */
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

  const all = await books.list()
  const root = all.find((b) => b.id === target.bookId)
  if (!root) throw new Error('E_BOOK_NOT_FOUND')
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
  const walk = async (book: BookRecord, folder: string[]) => {
    // A parent cycle (from concurrent moves) is walked once.
    if (seen.has(book.id)) return
    seen.add(book.id)
    // Per folder: the notes' file names (without extension), and every
    // name taken there, so a sub-notebook's folder never takes a note's
    // file name (`Plan.md`) or the attachments folder.
    const files = new Set<string>()
    const taken = new Set<string>(folder.length === 0 ? [nameKey(ATTACHMENTS_FOLDER)] : [])
    const notesHere = [...(byBook.get(book.id) ?? [])].sort(
      (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
    )
    for (const note of notesHere) {
      const added = await entry(note.id, folder, (title) =>
        unique(fileStem(title, untitled), files),
      )
      for (const extension of ['md', 'html']) taken.add(nameKey(`${added.stem}.${extension}`))
      entries.push(added)
    }
    const subs = [...(children.get(book.id) ?? [])].sort((a, b) => bookOrder(a, b))
    for (const sub of subs) {
      await walk(sub, [...folder, unique(fileStem(sub.name, '_'), taken)])
    }
  }
  await walk(root, [])
  return { name: fileStem(root.name, '_'), entries }
}

// --- Markdown files ----------------------------------------------------------

/**
 * An attachment's URL (`devot://file/<id>`, without a size); the group is its
 * ID, a UUIDv7 as Rust accepts it. Any other ID names no attachment, so its
 * image stays as written (Rust would refuse it, and the whole page with it).
 */
export const FILE_URL = new RegExp(`^${fileUri(`(${FILE_ID_SOURCE})`)}$`)

/** The attachment an image URL shows, and the size it shows it at; null for other URLs. */
function attachmentOf(url: string): { id: string; size: ImageSize } | null {
  const sized = splitImageSize(url)
  const id = FILE_URL.exec(sized.url)?.[1]
  return id === undefined ? null : { id, size: sized.size }
}

/** The attachments `urls` show (at any size), each once, in order. */
const attachmentsOf = (urls: readonly string[]) => [
  ...new Set(urls.flatMap((url) => attachmentOf(url)?.id ?? [])),
]

/**
 * The attachments a note's images show (at any size), each once, in order:
 * Markdown images and `<img>` tags in raw HTML.
 */
export function attachmentIds(markdown: string): string[] {
  // Without a `![` or an `<img` there is no image: nothing to parse.
  if (!mayShowImages(markdown)) return []
  return attachmentsOf(markdownFacts(markdown).links.map((link) => link.url))
}

const percentEncoded = (c: string) =>
  Array.from(encoder.encode(c), (b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('')

/**
 * A relative path as a Markdown link destination: characters that would
 * end or change it (spaces of any kind, parentheses, angle brackets, `%`,
 * `#`, `?`, `&`, which starts a character reference, `|`, which ends a
 * table cell, backslashes, control characters) are percent-encoded; others
 * stay.
 */
export function linkPath(path: string): string {
  return path.replace(/[\s()<>%#?&|\\\p{Cc}]/gu, percentEncoded)
}

/**
 * A relative path as an HTML attribute value (an `<img>`'s `src`): as
 * `linkPath`, with quotes, `=` and backticks percent-encoded too, so it is
 * one value however the attribute is quoted, or not.
 */
export function attributePath(path: string): string {
  return linkPath(path).replace(/["'=`]/g, percentEncoded)
}

/**
 * A link from a page in `folder` to the file at `path` (both from the top of
 * the export): `..` for each folder to leave, then the rest of `path`, each
 * name percent-encoded.
 */
export function relativeHref(folder: readonly string[], path: readonly string[]): string {
  let shared = 0
  while (shared < folder.length && shared < path.length - 1 && folder[shared] === path[shared]) {
    shared += 1
  }
  const up = folder.slice(shared).map(() => '..')
  return [...up, ...path.slice(shared).map(encodeURIComponent)].join('/')
}

/**
 * What a value cannot hold as written on one line of front matter: control
 * characters (line breaks among them), the line and paragraph separators
 * (line breaks to some readers), a byte order mark and unpaired surrogates.
 */
const UNWRITABLE = /[\p{Cc}\p{Zl}\p{Zp}\uFEFF]|\p{Cs}/u
const ESCAPED = /[\\"\p{Cc}\p{Zl}\p{Zp}\uFEFF]|\p{Cs}/gu

/** YAML's short escapes; anything else that needs one is `\uXXXX`. */
const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
}

/**
 * A value as a YAML scalar on one line: single-quoted (a `'` doubled) when
 * it can be written as it is, else double-quoted with escapes, which import
 * reads back exactly in Devot's block.
 */
function quoted(value: string): string {
  if (!UNWRITABLE.test(value)) return `'${value.replace(/'/g, "''")}'`
  const escaped = value.replace(
    ESCAPED,
    (c) => SHORT_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
  )
  return `"${escaped}"`
}

/**
 * Whether a note's own front matter can say `title` so that import reads it
 * back exactly: import tidies the spaces of a title found there and puts the
 * heading or file name in place of an empty one.
 */
const sayableTitle = (title: string) =>
  title !== '' && noteTitle(title) === title && !UNWRITABLE.test(title)

/** Whether a note's own front matter can say `tag` (import drops a leading `#` there). */
const sayableTag = (tag: string) => !tag.startsWith('#') && !UNWRITABLE.test(tag)

const statusValue = (status: NoteStatus) => status.replace(/_/g, '-')

/** Whether two lists name the same tags, exactly (a tag's case is part of it). */
const sameTags = (a: readonly string[], b: readonly string[]) => {
  const key = (list: readonly string[]) => [...new Set(list)].sort().join('\n')
  return key(a) === key(b)
}

/**
 * The Markdown file for a note: its body with attachment links pointing at
 * `paths` (attachment ID to its path from the note's folder), and the front
 * matter import needs to read back its title, tags and status from a file
 * named `fileName` (see the rules at the top). `facts` are what
 * `markdownFacts` reads from the body, when the caller has them already.
 */
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

  if (facts.frontMatter === null) {
    if (titleKept && entry.tags.length === 0 && entry.status === 'none') return body
    return devotBlock()
  }
  // What the note's own front matter cannot say, or front matter import
  // would take for Devot's own (see the rules at the top). New image
  // destinations leave the front matter as it was.
  if (
    isExportBlock(facts.frontMatter) ||
    (!titleKept && !sayableTitle(entry.title)) ||
    !entry.tags.every(sayableTag)
  ) {
    return devotBlock()
  }

  // The note's own front matter says what import reads; set what disagrees.
  const meta = facts.meta
  const set: [string, string][] = []
  if (!titleKept) set.push(['title', quoted(entry.title)])
  if (!sameTags(meta.tags, entry.tags)) {
    set.push(['tags', `[${entry.tags.map(quoted).join(', ')}]`])
  }
  if ((meta.status ?? 'none') !== entry.status) set.push(['status', statusValue(entry.status)])
  return setFrontMatterKeys(body, set)
}

// --- Export ------------------------------------------------------------------

export interface ExportOptions extends PlanOptions {
  sink: ExportSink
}

/**
 * Exports a note or a notebook as Markdown files (see the rules at the top).
 * Null when the user cancelled. A note that cannot be written, or an image
 * that cannot be copied or whose link cannot be found (its link stays as it
 * was), is listed as a problem.
 */
export async function exportMarkdown(options: ExportOptions): Promise<ExportReport | null> {
  const plan = await planExport(options)
  const { sink } = options
  const begun = await sink.begin(plan.name)
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
