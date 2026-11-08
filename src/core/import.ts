// Markdown and HTML import. Rust reads what the user picked (src-tauri/src/import.rs); this module turns it into notebooks, notes, tags, statuses and attachments.
// `importTree` (importTree.ts) shows the same mapping before anything is written.
//
// Rules:
// - Notes go to the destination the user picked. One picked folder is not a notebook itself; every folder inside it that holds an imported note becomes a nested
//   notebook. With several picked folders each becomes a notebook. Picked files all go to the destination. Folders with no imported notes do not become notebooks.
// - Front matter that Markdown export added (first line EXPORT_HEADER, see export.ts) is Devot's own: title, tags (a leading `#` kept) and status become the note's
//   and it is left out of the body, so an exported note imports as it was. Other front matter stays in the body as written and is not read.
// - The title is the first level-one heading, else the file name without its extension (an HTML file's `<title>` comes first).
// - An HTML file is sanitized and converted to Markdown (htmlImport.ts) first. Embedded `data:` images become attachments; content the conversion dropped, or an
//   image that could not be stored, is listed as not imported.
// - Local images become attachments and only their destinations are rewritten to `devot://file/<id>`, keeping a size preset (`img.png#half`). Remote images
//   stay links. A local image whose link cannot be found in the text is listed as not imported.
// - Wiki-style links (wikiLinks.ts), unless turned off: once every note exists, `[[Title]]` becomes a note link to the imported note of that file name or
//   title, else to a library note of that title (case and diacritics aside, a folder prefix only choosing between notes of the same name), and `![[image.png]]`
//   an attachment of the import folder's image of that name. A link not found stays as written and is counted. Code and links' own text are left alone.
// - Everything else is kept as-is.
// - Line breaks become LF: the editor counts a CRLF as one character and the Yjs text as two, so a CR would make every later edit land in the wrong place.
// - A file that fails part-way leaves no note behind (nor notebooks made only for it): it is listed as not imported.
// - Nothing is written before `importMarkdown` runs. Bodies reach the note as Yjs operations (`NoteService.setBody`), never by writing the snapshot.

import { fromHtml } from 'hast-util-from-html'
import type { Root, Nodes } from 'mdast'
import {
  clip,
  exportHeader,
  isExportBlock,
  metaOf,
  oneLine,
  parseMarkdown,
  yamlOf,
  type FrontMatterMeta,
} from './frontMatter'
import { htmlToMarkdown, type HtmlImage } from './htmlImport'
import { folderOf, isHtmlFile, noteFolder } from './importTree'
import { MAX_BOOK_NAME_CHARS, type BookDraft, type BookService } from './books'
import { errorCode } from './errors'
import { checkUpload, fileUri } from './files'
import { splitImageSize, withImageSize } from './images'
import { clipTitle, MAX_TITLE_CHARS } from './noteLimits'
import type { NoteService } from './notes'
import type { StorageAdapter } from './storage'
import type { TagService } from './tags'
import { lineFeeds, replaceRanges, type TextEdit } from './text'
import { noteLink } from './links'
import {
  embeddedImage,
  parseWikiTarget,
  titleKey,
  wikiLinksOf,
  wikiShownText,
  type WikiLink,
  type WikiTarget,
} from './wikiLinks'

export {
  EXPORT_HEADER,
  exportHeader,
  frontMatter,
  isExportBlock,
  noteTitle,
  readFrontMatter,
  readFrontMatterYaml,
  withoutFrontMatterKeys,
  type FrontMatterMeta,
} from './frontMatter'

export type ImportKind = 'folder' | 'folders' | 'files'

export interface ImportItem {
  path: string
  bytes: number
}

/** Paths are relative, with `/`: to the folder for one folder; starting with each folder's name for several (and with the name of each file's folder for files). */
export interface ImportScan {
  /** The import session; Rust only reads files for a session it started. */
  id: number
  name: string
  kind: ImportKind
  files: ImportItem[]
  /** Attached only when a note shows one; sorted. */
  images: ImportItem[]
  skipped: ImportProblem[]
  /** The notebook to import into when the import started from its menu; null or missing from File > Import. */
  destination?: string | null
}

export interface ImportProblem {
  path: string
  image?: string
  code: string
}

export interface ImportSource {
  read(path: string): Promise<string>
  attach(path: string, file: { id: string; noteId: string }): Promise<void>
}

export interface ImportReport {
  /** The destination, else the one top-level notebook the import made; null when neither, or no note was imported. */
  bookId: string | null
  notes: number
  /** Note IDs by scan path. */
  noteIds: Record<string, string>
  books: number
  attachments: number
  /** Wiki-style links made into note links or attachments. */
  links: number
  /** Wiki-style links left as written: nothing of that name was found. */
  unresolvedLinks: number
  problems: ImportProblem[]
}

export interface ImportOptions {
  notes: NoteService
  books: BookService
  tags: TagService
  newId: () => string
  scan: ImportScan
  source: ImportSource
  /** Without it, embedded images are listed as not imported. */
  files?: Pick<StorageAdapter, 'putFile'> | undefined
  /** The notebook the notes (and notebooks made for folders) go into; null or left out for none. */
  destination?: string | null
  onProgress?: (done: number, total: number) => unknown
  /**
   * Once true, the import ends there (the file it was on is finished first) and the rest are listed
   * as not imported. A promise holds the import before its next file until it settles.
   */
  stopped?: () => boolean | Promise<boolean>
  /** Where files are converted and parsed; in this thread when left out. */
  prepare?: ImportPreparer
  /** False keeps wiki-style links as written; on when left out. */
  wikiLinks?: boolean
}

/** What a file becomes before anything is written: all the parsing an import does. */
export interface PreparedImport {
  title: string
  meta: FrontMatterMeta
  /** The body as stored, before its image links are rewritten. */
  text: string
  images: ImageLinks
  /** An HTML file's embedded images, as attachments to store (none without IDs to give them). */
  embedded: HtmlImage[]
  dropped: string[]
}

interface FoundImages {
  links: ImageLink[]
  unlocated: string[]
}

export interface ImageLinks extends FoundImages {
  wiki: WikiLink[]
}

export interface ImportPreparer {
  file(raw: string, path: string, withImages: boolean): Promise<PreparedImport>
  links(text: string): Promise<ImageLinks>
}

function plainText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'inlineMath') {
    return node.value
  }
  if (node.type === 'image') return node.alt ?? ''
  if (node.type === 'break') return ' '
  return 'children' in node ? node.children.map((child) => plainText(child as Nodes)).join('') : ''
}

/**
 * macOS may give file names decomposed (NFD), while typed text, and so a search, is composed (NFC).
 * CJK compatibility ideographs stay: NFC would turn each into another character.
 */
const composed = (name: string) =>
  name.replace(/[^\uf900-\ufaff\u{2f800}-\u{2fa1f}]+/gu, (run) => run.normalize('NFC'))

function baseName(path: string): string {
  const name = composed(path.split('/').pop() ?? path)
  return name.replace(/\.[^.]+$/, '') || name
}

const NO_META: FrontMatterMeta = { title: null, notebook: null, tags: [], status: null }

function ownMeta(markdown: string): { meta: FrontMatterMeta; body: string; title: string | null } {
  const header = exportHeader(markdown)
  if (!header) return { meta: NO_META, body: markdown, title: null }
  // Devot's own title is the note's exactly (only cut to the limit).
  const title = header.meta.title === null ? null : clipTitle(header.meta.title)
  return { meta: header.meta, body: header.body, title }
}

export function importTitle(markdown: string, path: string): string {
  const own = ownMeta(markdown)
  return own.title ?? titleOf(parseMarkdown(own.body), path)
}

const LEVEL_ONE_LINE = /^ {0,3}(?:#(?:[ \t]|$)|=+[ \t]*$)/m

/** HTML reads a tag name in any ASCII case; without the `u` flag, `i` never matches a non-ASCII character to an ASCII letter. */
const HTML_IMG = /<img/i

export const mayShowImages = (markdown: string) =>
  markdown.includes('![') || HTML_IMG.test(markdown)

export interface MarkdownFacts {
  links: ImageLink[]
  unlocated: string[]
  frontMatter: string | null
  title(path: string): string
}

export function markdownFacts(markdown: string): MarkdownFacts {
  const images = mayShowImages(markdown)
  if (!images && !markdown.startsWith('---') && !LEVEL_ONE_LINE.test(markdown)) {
    return {
      links: [],
      unlocated: [],
      frontMatter: null,
      title: (path) => clip(oneLine(baseName(path)), MAX_TITLE_CHARS),
    }
  }
  const tree = parseMarkdown(markdown)
  const yaml = yamlOf(tree)
  const found = images ? imagesOf(tree, markdown) : { links: [], unlocated: [] }
  // Only Devot's own front matter can give the title (exactly, only cut to
  // the limit); the tree's first heading is the body's, after that block.
  const exported = yaml !== null && isExportBlock(yaml)
  const own = exported ? metaOf(yaml, true).title : null
  // The import stores the body without Devot's block and reads it on its own,
  // so a body that opens with `---` is front matter there, not a rule.
  const bodyTree = () => {
    const end = tree.children[0]?.position?.end.offset ?? 0
    const rest = markdown.slice(end)
    return parseMarkdown(rest.startsWith('\n') ? rest.slice(1) : rest)
  }
  return {
    links: found.links,
    unlocated: found.unlocated,
    frontMatter: yaml,
    title: (path) => (own !== null ? clipTitle(own) : titleOf(exported ? bodyTree() : tree, path)),
  }
}

function titleOf(tree: Root, path: string): string {
  const heading = tree.children.find(
    (node) => node.type === 'heading' && node.depth === 1 && oneLine(plainText(node)) !== '',
  )
  if (heading) return clip(oneLine(plainText(heading)), MAX_TITLE_CHARS)
  return clip(oneLine(baseName(path)), MAX_TITLE_CHARS)
}

export interface ImageLink {
  start: number
  end: number
  url: string
  html?: boolean
}

const TITLE = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))`
const INLINE_TAIL = new RegExp(String.raw`^(?:[ \t\n]+${TITLE})?[ \t\n]*\)$`)
const DEFINITION_HEAD = /\[(?:[^[\]\\]|\\.)*\]:[ \t]*\n?[ \t]*/

function destinationEnd(text: string, at: number): number {
  if (text[at] === '<') {
    for (let i = at + 1; i < text.length; i += 1) {
      const c = text[i]
      if (c === '\\' && i + 1 < text.length && text[i + 1] !== '\n') i += 1
      else if (c === '>') return i + 1
      else if (c === '<' || c === '\n') return -1
    }
    return -1
  }
  const stops = (i: number) => {
    const code = text.charCodeAt(i)
    return code <= 0x20 || code === 0x7f
  }
  let depth = 0
  let i = at
  for (; i < text.length && !stops(i); i += 1) {
    const c = text[i]
    if (c === '\\' && i + 1 < text.length && !stops(i + 1)) i += 1
    else if (c === '(') depth += 1
    else if (c === ')') {
      if (depth === 0) break
      depth -= 1
    }
  }
  return depth === 0 ? i : -1
}

function unescapeDest(raw: string): string {
  const inner = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
  return inner.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

function readsAs(raw: string, url: string): boolean {
  if (unescapeDest(raw) === url) return true
  const paragraph = parseMarkdown(`![](${raw})`).children[0]
  const image = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined
  return image?.type === 'image' && image.url === url
}

function inlineDest(source: string, start: number, end: number, url: string): ImageLink | null {
  const text = source.slice(start, end)
  for (let i = text.indexOf(']('); i !== -1; i = text.indexOf('](', i + 1)) {
    const at = i + 2 + /^[ \t]*\n?[ \t]*/.exec(text.slice(i + 2))![0].length
    const stop = destinationEnd(text, at)
    if (stop === -1 || !INLINE_TAIL.test(text.slice(stop))) continue
    if (!readsAs(text.slice(at, stop), url)) continue
    return { start: start + at, end: start + stop, url }
  }
  return null
}

function definitionDest(source: string, start: number, end: number, url: string): ImageLink | null {
  const text = source.slice(start, end)
  const head = DEFINITION_HEAD.exec(text)
  if (!head) return null
  const at = head.index + head[0].length
  const stop = destinationEnd(text, at)
  if (stop === -1 || !readsAs(text.slice(at, stop), url)) return null
  return { start: start + at, end: start + stop, url }
}

const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes'])
const BLANK = /[\t\n\f\r ]/
// HTML compares tag and attribute names in ASCII case only, and they are compared in place: lowercasing all of `html` could make it longer (U+0130 becomes two
// code units) and move every offset after it.
const SRC = /^src$/i

function rawTextEnd(html: string, tag: string, from: number): number {
  const end = new RegExp(`</${tag}[\\t\\n\\f\\r />]`, 'gi')
  end.lastIndex = from
  return end.exec(html)?.index ?? html.length
}

interface SrcValue {
  start: number
  end: number
  quote: string
}

function imgSources(html: string): SrcValue[] {
  const found: SrcValue[] = []
  let i = 0
  while (i < html.length) {
    const open = html.indexOf('<', i)
    if (open === -1) break
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4)
      i = close === -1 ? html.length : close + 3
      continue
    }
    if (html[open + 1] === '!' || html[open + 1] === '?') {
      const close = html.indexOf('>', open)
      i = close === -1 ? html.length : close + 1
      continue
    }
    const name = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(html.slice(open, open + 40))
    if (!name) {
      i = open + 1
      continue
    }
    const tag = name[1]!.toLowerCase()
    let j = open + name[0].length
    let src: SrcValue | null = null
    let closed = false
    while (j < html.length) {
      while (j < html.length && BLANK.test(html[j]!)) j += 1
      if (html[j] === '>') {
        closed = true
        j += 1
        break
      }
      if (html[j] === '/') {
        j += 1
        continue
      }
      const from = j
      while (j < html.length && !BLANK.test(html[j]!) && !'/>='.includes(html[j]!)) j += 1
      if (j === from) {
        j += 1
        continue
      }
      const attribute = html.slice(from, j)
      let k = j
      while (k < html.length && BLANK.test(html[k]!)) k += 1
      if (html[k] !== '=') continue
      k += 1
      while (k < html.length && BLANK.test(html[k]!)) k += 1
      let value: SrcValue
      const quote = html[k]
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, k + 1)
        if (close === -1) break
        value = { start: k + 1, end: close, quote }
        j = close + 1
      } else {
        j = k
        while (j < html.length && !BLANK.test(html[j]!) && html[j] !== '>') j += 1
        value = { start: k, end: j, quote: '' }
      }
      if (tag === 'img' && SRC.test(attribute) && src === null) src = value
    }
    if (closed && src) found.push(src)
    i = closed && RAW_TEXT.has(tag) ? rawTextEnd(html, tag, j) : j
  }
  return found
}

function attributeValue(raw: string, quote: string): string {
  const img = fromHtml(`<img src=${quote}${raw}${quote}>`, { fragment: true }).children[0]
  const src = img?.type === 'element' ? img.properties['src'] : undefined
  return typeof src === 'string' ? src : raw
}

/** Null when a line's text is not the end of the note's line. */
function sourceOffsets(markdown: string, start: number, end: number, value: string) {
  const source = markdown.slice(start, end)
  if (source === value) return (offset: number) => start + offset
  const valueLines = value.split('\n')
  const sourceLines = source.split('\n')
  if (valueLines.length !== sourceLines.length) return null
  // For each line: where its text starts in `value`, how much of it is
  // leading blanks, and where that text starts in the note.
  const lines: { from: number; blank: number; at: number }[] = []
  let from = 0
  let at = start
  for (const [n, line] of valueLines.entries()) {
    const text = line.replace(/^[ \t]+/, '')
    const original = sourceLines[n]!
    if (!original.endsWith(text)) return null
    lines.push({ from, blank: line.length - text.length, at: at + original.length - text.length })
    from += line.length + 1
    at += original.length + 1
  }
  return (offset: number) => {
    const line = lines.findLast((l) => l.from <= offset)!
    const within = offset - line.from - line.blank
    return within < 0 ? null : line.at + within
  }
}

function htmlImages(markdown: string, start: number, end: number, value: string) {
  const links: ImageLink[] = []
  const unlocated: string[] = []
  const offsets = sourceOffsets(markdown, start, end, value)
  for (const src of imgSources(value)) {
    const raw = value.slice(src.start, src.end)
    const url = attributeValue(raw, src.quote)
    const from = offsets?.(src.start) ?? null
    const to = offsets?.(src.end) ?? null
    if (from === null || to === null || markdown.slice(from, to) !== raw) {
      unlocated.push(url)
      continue
    }
    links.push({ start: from, end: to, url, html: true })
  }
  return { links, unlocated }
}

export function imageLinks(markdown: string): ImageLink[] {
  return imagesOf(parseMarkdown(markdown), markdown).links
}

/** Embedded images take their IDs from `newId`; without it they are left out. */
export function prepareImportFile(raw: string, path: string, newId?: () => string): PreparedImport {
  const source = lineFeeds(raw)
  const html = isHtmlFile(path) ? htmlToMarkdown(source, newId) : null
  const own = ownMeta(html ? html.markdown : source)
  const tree = parseMarkdown(own.body)
  return {
    title: own.title ?? (html?.title ? clipTitle(html.title) : titleOf(tree, path)),
    meta: own.meta,
    text: own.body,
    images: { ...imagesOf(tree, own.body), wiki: wikiLinksOf(tree, own.body) },
    embedded: html?.images ?? [],
    dropped: html?.dropped ?? [],
  }
}

export function imagesIn(text: string): ImageLinks {
  const tree = parseMarkdown(text)
  return { ...imagesOf(tree, text), wiki: wikiLinksOf(tree, text) }
}

export const preparerHere = (newId: () => string): ImportPreparer => ({
  file: async (raw, path, withImages) =>
    prepareImportFile(raw, path, withImages ? newId : undefined),
  links: async (text) => imagesIn(text),
})

export function unlocatedImages(markdown: string): string[] {
  return imagesOf(parseMarkdown(markdown), markdown).unlocated
}

function imagesOf(tree: Root, markdown: string): FoundImages {
  const inline: ImageLink[] = []
  const unlocated: string[] = []
  const used = new Set<string>()
  const definitions: { identifier: string; url: string; start: number; end: number }[] = []
  const walk = (node: Nodes) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (node.type === 'image' && start !== undefined && end !== undefined) {
      const link = inlineDest(markdown, start, end, node.url)
      if (link) inline.push(link)
      else unlocated.push(node.url)
    } else if (node.type === 'imageReference') {
      used.add(node.identifier)
    } else if (node.type === 'definition' && start !== undefined && end !== undefined) {
      definitions.push({ identifier: node.identifier, url: node.url, start, end })
    } else if (node.type === 'html' && start !== undefined && end !== undefined) {
      const found = htmlImages(markdown, start, end, node.value)
      inline.push(...found.links)
      unlocated.push(...found.unlocated)
    }
    if ('children' in node) for (const child of node.children) walk(child as Nodes)
  }
  walk(tree)
  for (const definition of definitions) {
    if (!used.has(definition.identifier)) continue
    const link = definitionDest(markdown, definition.start, definition.end, definition.url)
    if (link) inline.push(link)
    else unlocated.push(definition.url)
  }
  return { links: inline.sort((a, b) => a.start - b.start), unlocated }
}

type Resolved = { kind: 'remote' } | { kind: 'outside' } | { kind: 'path'; path: string }

function resolve(notePath: string, url: string): Resolved {
  if (
    !url ||
    /^[a-z][a-z0-9+.-]*:/i.test(url) ||
    url.startsWith('//') ||
    url.startsWith('#') ||
    url.startsWith('?')
  ) {
    return { kind: 'remote' }
  }
  let path = url.replace(/[?#].*$/, '')
  try {
    path = decodeURIComponent(path)
  } catch {
    // Not percent-encoded after all; use it as written.
  }
  const segments = path.startsWith('/') ? [] : notePath.split('/').slice(0, -1)
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return { kind: 'outside' }
      segments.pop()
    } else {
      segments.push(segment)
    }
  }
  return segments.length === 0 ? { kind: 'outside' } : { kind: 'path', path: segments.join('/') }
}

/** Null when the destination is not a local file inside the import folder; a leading `/` means the import folder. */
export function resolveImagePath(notePath: string, url: string): string | null {
  const resolved = resolve(notePath, url)
  return resolved.kind === 'path' ? resolved.path : null
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
}

function bookName(name: string): string {
  return clip(oneLine(composed(name).replace(/\p{Cc}/gu, ' ')), MAX_BOOK_NAME_CHARS) || '_'
}

export async function importMarkdown(options: ImportOptions): Promise<ImportReport> {
  const { notes, books, tags, newId, scan, source, onProgress, stopped, files: store } = options
  const prepare = options.prepare ?? preparerHere(newId)
  const destination = options.destination ?? null
  const problems: ImportProblem[] = [...scan.skipped]
  // The notebooks of every folder with files are made in one write before the first note, in the
  // order the files first need them; those no imported note ends up in are deleted at the end.
  const folders = new Map<string, string | null>([['', destination]])
  const drafts: BookDraft[] = []
  const draftPaths: string[] = []
  const draftIndex = new Map<string, number>()
  const plan = (path: string) => {
    if (path === '' || draftIndex.has(path)) return
    const parent = folderOf(path)
    plan(parent)
    const under = draftIndex.get(parent)
    const name = bookName(path.split('/').pop() ?? path)
    draftIndex.set(path, drafts.length)
    draftPaths.push(path)
    drafts.push(
      under === undefined
        ? { name, parentId: destination }
        : { name, parentId: null, parentIndex: under },
    )
  }
  for (const file of scan.files) plan(noteFolder(scan.kind, file.path))
  let booksRefused = 'E_IMPORT_FAILED'
  const folder = (path: string): string | null => {
    const id = folders.get(path)
    if (id === undefined) throw new Error(booksRefused)
    return id
  }

  let imported = 0
  let attachments = 0
  const noteIds: Record<string, string> = {}
  const convertLinks = options.wikiLinks !== false
  const findImage = imageFinder(scan)
  const importedNotes: ImportedNote[] = []
  const linked: LinkedNote[] = []
  let converted = 0
  let unresolved = 0
  const paths = scan.files.map((f) => f.path)
  const total = paths.length
  await onProgress?.(0, total)
  if (drafts.length > 0 && !(await stopped?.())) {
    try {
      const ids = await books.createMany(drafts)
      ids.forEach((id, i) => folders.set(draftPaths[i]!, id))
    } catch (error) {
      booksRefused = errorCode(error, 'E_IMPORT_FAILED')
    }
  }
  for (const [index, path] of paths.entries()) {
    if (await stopped?.()) {
      for (const rest of paths.slice(index)) problems.push({ path: rest, code: 'E_IMPORT_STOPPED' })
      break
    }
    let id: string | undefined
    let stored = 0
    const found: ImportProblem[] = []
    try {
      const prepared = await prepare.file(await source.read(path), path, store !== undefined)
      const { meta } = prepared
      let { text, images } = prepared
      id = await notes.create(prepared.title, folder(noteFolder(scan.kind, path)))
      const noteId = id
      for (const dropped of prepared.dropped) {
        found.push({ path, image: dropped, code: 'E_IMPORT_HTML_CONTENT_DROPPED' })
      }
      if (store) {
        let refused = false
        for (const image of prepared.embedded) {
          const file = { id: image.id, noteId, name: `image.${EXTENSIONS[image.mime] ?? 'png'}` }
          try {
            checkUpload(file, image.data)
            await store.putFile(file, image.data)
            stored += 1
          } catch (error) {
            // The link would show nothing: it is left empty, and listed.
            text = text.replaceAll(fileUri(image.id), '')
            refused = true
            found.push({
              path,
              image: `data:${image.mime}`,
              code: errorCode(error, 'E_IMPORT_FAILED'),
            })
          }
        }
        if (refused) images = await prepare.links(text)
      }

      const files = new Map<string, string | null>()
      const attach = async (target: string): Promise<string | null> => {
        if (!files.has(target)) {
          const fileId = newId()
          try {
            await source.attach(target, { id: fileId, noteId })
            files.set(target, fileId)
            stored += 1
          } catch (error) {
            files.set(target, null)
            found.push({ path, image: target, code: errorCode(error, 'E_IMPORT_FAILED') })
          }
        }
        return files.get(target) ?? null
      }
      const edits: TextEdit[] = []
      for (const url of images.unlocated) {
        const target = resolve(path, url)
        if (target.kind === 'outside') {
          found.push({ path, image: url, code: 'E_IMPORT_PATH_OUTSIDE' })
        } else if (target.kind === 'path') {
          found.push({ path, image: target.path, code: 'E_IMPORT_IMAGE_UNLOCATED' })
        }
      }
      for (const link of images.links) {
        const target = resolve(path, link.url)
        if (target.kind === 'remote') continue
        if (target.kind === 'outside') {
          found.push({ path, image: link.url, code: 'E_IMPORT_PATH_OUTSIDE' })
          continue
        }
        const fileId = await attach(target.path)
        if (fileId) {
          // A size preset (`#half`) stays on the attachment's link.
          const dest = withImageSize(fileUri(fileId), splitImageSize(link.url).size)
          edits.push({ start: link.start, end: link.end, text: dest })
        }
      }
      const pending: PendingLink[] = []
      let embeds = 0
      let missing = 0
      for (const link of convertLinks ? images.wiki : []) {
        const target = parseWikiTarget(link.inner, link.embed)
        const image = link.embed ? findImage(path, target.path) : null
        if (image) {
          const fileId = await attach(image)
          if (!fileId) continue
          edits.push({
            start: link.start,
            end: link.end,
            text: embeddedImage(target, fileUri(fileId)),
          })
          embeds += 1
        } else if (link.embed && LOOKS_LIKE_IMAGE.test(target.path)) {
          missing += 1
        } else {
          pending.push({ start: link.start, end: link.end, target })
        }
      }
      const body = replaceRanges(text, edits)
      await notes.setBody(noteId, body)
      if (meta.status !== null && meta.status !== 'none') await notes.setStatus(noteId, meta.status)
      // Tags last: a tag made for a note that then failed would stay unused.
      for (const tag of meta.tags) await tags.addToNote(noteId, tag)
      await notes.release(noteId)
      imported += 1
      noteIds[path] = noteId
      attachments += stored
      converted += embeds
      unresolved += missing
      importedNotes.push({ path, id: noteId, title: prepared.title })
      if (pending.length > 0)
        linked.push({ path, id: noteId, text: body, links: shifted(pending, edits) })
      problems.push(...found)
    } catch (error) {
      problems.push({ path, code: errorCode(error, 'E_IMPORT_FAILED') })
      if (!(await discard(id))) problems.push({ path, code: 'E_IMPORT_INCOMPLETE' })
    }
    await onProgress?.(index + 1, total)
  }

  // Second pass: every imported note now has its ID.
  const findNote = noteFinder(importedNotes, scan.kind, notes)
  const relinked: LinkedNote[] = []
  for (const note of linked) {
    try {
      const edits: TextEdit[] = []
      for (const link of note.links) {
        const shown = wikiShownText(link.target)
        const id = link.target.path === '' ? note.id : await findNote(note.path, link.target)
        if (id !== null && shown !== '') {
          edits.push({ start: link.start, end: link.end, text: noteLink(shown, id) })
        }
      }
      // A note opened and changed meanwhile keeps its links as written rather than lose that change.
      const changed =
        edits.length > 0 &&
        (await notes.setBodyFrom(note.id, note.text, replaceRanges(note.text, edits)))
      if (changed) {
        converted += edits.length
        unresolved += note.links.length - edits.length
        relinked.push(note)
      } else {
        unresolved += note.links.length
      }
    } catch (error) {
      unresolved += note.links.length
      problems.push({ path: note.path, code: errorCode(error, 'E_IMPORT_FAILED') })
    }
  }
  // Saved by a flush, not `release`: the user may have opened one of these notes by now, and releasing would drop it from under the editor.
  if (relinked.length > 0) {
    try {
      await notes.flush()
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      for (const note of relinked.filter((n) => message.includes(n.id))) {
        problems.push({ path: note.path, code: errorCode(error, 'E_IMPORT_FAILED') })
      }
    }
  }

  /** Takes back a failed file's note (purging also deletes its attachments) and the notebooks made only for it. False when that fails. */
  async function discard(noteId: string | undefined): Promise<boolean> {
    if (noteId === undefined) return true
    try {
      await notes.trash(noteId)
      await notes.purge(noteId)
      return true
    } catch {
      console.warn('W_IMPORT_CLEANUP_FAILED', noteId)
      return false
    }
  }

  const used = new Set<string>()
  for (const path of Object.keys(noteIds)) {
    for (let at = noteFolder(scan.kind, path); at !== '' && !used.has(at); at = folderOf(at)) {
      used.add(at)
    }
  }
  const unused = draftPaths.filter((path) => folders.has(path) && !used.has(path))
  if (unused.length > 0) {
    const tops = unused.filter(
      (path) => used.has(folderOf(path)) || !draftIndex.has(folderOf(path)),
    )
    try {
      await books.removeMany(tops.map((path) => folders.get(path) as string))
      for (const path of unused) folders.delete(path)
    } catch (error) {
      console.warn('W_IMPORT_CLEANUP_FAILED', errorCode(error, 'E_IMPORT_FAILED'))
      problems.push({ path: tops[0]!, code: 'E_IMPORT_INCOMPLETE' })
    }
  }
  const madeBooks = [...folders.entries()].filter(([path]) => path !== '')
  const tops = madeBooks.filter(([path]) => !path.includes('/'))
  return {
    bookId: imported === 0 ? null : (destination ?? (tops.length === 1 ? tops[0]![1] : null)),
    notes: imported,
    noteIds,
    books: madeBooks.length,
    attachments,
    links: converted,
    unresolvedLinks: unresolved,
    problems,
  }
}

const LOOKS_LIKE_IMAGE = /\.(?:png|jpe?g|gif|webp|avif|hei[cf]|svg|bmp|tiff?)$/i

interface PendingLink {
  start: number
  end: number
  target: WikiTarget
}

interface ImportedNote {
  path: string
  id: string
  title: string
}

interface LinkedNote {
  path: string
  id: string
  /** The body as the first pass stored it. */
  text: string
  links: PendingLink[]
}

/** The links' places once `edits` (which never overlap them) are made. */
function shifted(links: PendingLink[], edits: readonly TextEdit[]): PendingLink[] {
  return links.map((link) => {
    let delta = 0
    for (const edit of edits) {
      if (edit.end <= link.start) delta += edit.text.length - (edit.end - edit.start)
    }
    return { ...link, start: link.start + delta, end: link.end + delta }
  })
}

/** For several folders or files each path starts with its own folder, the top a link's `/` and a name are read from. */
const rootOf = (kind: ImportKind, path: string) => (kind === 'folder' ? '' : path.split('/')[0]!)

const fileKey = (path: string) => composed(path).toLowerCase()

/** The import's image a wiki embed names: by its path from the note's folder, then from the top, then the nearest of that file name. */
function imageFinder(scan: ImportScan) {
  const byPath = new Map<string, string>()
  const byName = new Map<string, string[]>()
  for (const { path } of scan.images) {
    byPath.set(fileKey(path), path)
    const name = fileKey(path.split('/').pop()!)
    byName.set(name, [...(byName.get(name) ?? []), path])
  }
  return (from: string, written: string): string | null => {
    // Picked files come without a list of images: one next to the file is tried as named.
    if (scan.kind === 'files' && LOOKS_LIKE_IMAGE.test(written)) {
      return resolveImagePath(from, written)
    }
    const root = rootOf(scan.kind, from)
    for (const base of [from, root === '' ? '_' : `${root}/_`]) {
      const near = resolveImagePath(base, written)
      const found = near === null ? undefined : byPath.get(fileKey(near))
      if (found) return found
    }
    const named = (byName.get(fileKey(written.split('/').pop()!)) ?? []).filter(
      (path) => rootOf(scan.kind, path) === root,
    )
    const folder = folderOf(from)
    return (
      named.find((path) => folderOf(path) === folder) ??
      named.toSorted((a, b) => a.split('/').length - b.split('/').length)[0] ??
      null
    )
  }
}

/** The note a wiki link names: an imported note of that file name, else of that title, else a library note of that title. */
function noteFinder(imported: ImportedNote[], kind: ImportKind, notes: NoteService) {
  const byFile = new Map<string, ImportedNote[]>()
  const byTitle = new Map<string, ImportedNote[]>()
  const add = (map: Map<string, ImportedNote[]>, key: string, note: ImportedNote) => {
    if (key !== '') map.set(key, [...(map.get(key) ?? []), note])
  }
  for (const note of imported) {
    add(byFile, titleKey(baseName(note.path)), note)
    add(byTitle, titleKey(note.title), note)
  }
  let library: Promise<Map<string, string>> | undefined
  const libraryTitles = async () => {
    const titles = new Map<string, string>()
    for (const note of await notes.list()) {
      const key = titleKey(note.title)
      if (key !== '' && !titles.has(key)) titles.set(key, note.id)
    }
    return titles
  }
  return async (from: string, target: WikiTarget): Promise<string | null> => {
    const name = titleKey(target.name)
    const named = byFile.get(name) ?? byTitle.get(name)
    if (named) return nearest(named, from, target, kind).id
    library ??= libraryTitles()
    return (await library).get(name) ?? null
  }
}

function nearest(named: ImportedNote[], from: string, target: WikiTarget, kind: ImportKind) {
  const written = titleKey(target.path)
  const inFolder = target.path.includes('/')
    ? named.filter((note) => {
        const key = titleKey(note.path.replace(/\.[^./]+$/, ''))
        return key === written || key.endsWith(`/${written}`)
      })
    : []
  const pool = inFolder.length > 0 ? inFolder : named
  return (
    pool.find((note) => folderOf(note.path) === folderOf(from)) ??
    pool.find((note) => rootOf(kind, note.path) === rootOf(kind, from)) ??
    pool[0]!
  )
}
