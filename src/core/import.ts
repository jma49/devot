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
// - Local images become attachments and only their destinations are rewritten to `devot://file/<id>`, keeping a size preset (`img.png#half`). Everything else is
//   kept as-is, including `[[...]]`. Remote images stay links. A local image whose link cannot be found in the text is listed as not imported.
// - Line breaks become LF: the editor counts a CRLF as one character and the Yjs text as two, so a CR would make every later edit land in the wrong place.
// - A file that fails part-way leaves no note behind (nor notebooks made only for it): it is listed as not imported.
// - Nothing is written before `importMarkdown` runs. Bodies reach the note as Yjs operations (`NoteService.setBody`), never by writing the snapshot.

import { fromHtml } from 'hast-util-from-html'
import type { Root, Nodes } from 'mdast'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { htmlToMarkdown } from './htmlImport'
import { folderOf, isHtmlFile, noteFolder } from './importTree'
import { MAX_BOOK_NAME_CHARS, type BookService } from './books'
import { errorCode } from './errors'
import { checkUpload, fileUri } from './files'
import { splitImageSize, withImageSize } from './images'
import { clipTitle, MAX_TITLE_CHARS } from './noteLimits'
import type { NoteService } from './notes'
import { statusFromName } from './search'
import type { NoteStatus, StorageAdapter } from './storage'
import type { TagService } from './tags'
import { MAX_TAG_NAME_CHARS } from './tags'
import { charCount, lineFeeds, replaceRanges, trimWhitespace, type TextEdit } from './text'

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
  /** Once true, the import ends there (the file it was on is finished first) and the rest are listed as not imported. */
  stopped?: () => boolean
}

export interface FrontMatterMeta {
  title: string | null
  notebook: string | null
  tags: string[]
  status: NoteStatus | null
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const parser = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkMath)

const parse = (markdown: string) => parser.parse(markdown) as Root

const yamlOf = (tree: Root) => {
  const head = tree.children[0]
  return head?.type === 'yaml' ? head.value : null
}

export function frontMatter(markdown: string): string | null {
  return yamlOf(parse(markdown))
}

/** Front matter lines end at LF, though a value may hold a line or paragraph separator. */
const KEY = /^([A-Za-z_][\w-]*)[ \t]*:(.*)$/s

export const EXPORT_HEADER = '# Devot metadata'

export const isExportBlock = (yaml: string) => yaml.split('\n')[0]?.trimEnd() === EXPORT_HEADER

export function exportHeader(markdown: string): { meta: FrontMatterMeta; body: string } | null {
  const head = parse(markdown).children[0]
  const end = head?.position?.end.offset
  if (head?.type !== 'yaml' || end === undefined) return null
  if (!isExportBlock(head.value)) return null
  const rest = markdown.slice(end)
  return { meta: metaOf(head.value, true), body: rest.startsWith('\n') ? rest.slice(1) : rest }
}

export function withoutFrontMatterKeys(markdown: string, keys: readonly string[]): string {
  const head = parse(markdown).children[0]
  const start = head?.position?.start.offset
  const end = head?.position?.end.offset
  if (head?.type !== 'yaml' || start === undefined || end === undefined) return markdown
  const drop = new Set(keys.map((k) => k.toLowerCase()))
  const lines = markdown.slice(start, end).split('\n')
  const inner = lines.slice(1, -1)
  let dropping = false
  const kept = inner.filter((line) => {
    const match = KEY.exec(line.replace(/\r$/, ''))
    if (match) dropping = drop.has(match[1]!.toLowerCase())
    return !dropping
  })
  if (kept.length === inner.length) return markdown
  const rest = markdown.slice(end)
  if (kept.every((line) => line.trim() === '')) return rest.replace(/^(?:[ \t]*\r?\n)*/, '')
  const block = [lines[0], ...kept, lines.at(-1)].join('\n')
  return markdown.slice(0, start) + block + rest
}

/** Of a double-quoted scalar only `\"` and `\\` are read. */
function scalar(raw: string): string {
  const value = trimWhitespace(raw)
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function withoutComment(text: string): string {
  let quote: string | null = null
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!
    if (escaped) {
      escaped = false
    } else if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"') escaped = true
    } else if ((c === '"' || c === "'") && /^[\s,]?$/.test(text[i - 1] ?? '')) {
      quote = c
    } else if (c === '#' && /[ \t]/.test(text[i - 1] ?? '')) {
      return text.slice(0, i)
    }
  }
  return text
}

function splitList(raw: string): string[] {
  const items: string[] = []
  let current = ''
  let quote: string | null = null
  let escaped = false
  for (const c of raw) {
    if (escaped) {
      escaped = false
    } else if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"') escaped = true
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === ',') {
      items.push(current)
      current = ''
      continue
    }
    current += c
  }
  items.push(current)
  return items
}

/** Without a leading `#` (unless `exact`), trimmed, no empty or repeated names. */
function cleanTags(names: readonly string[], exact = false): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const name of names) {
    const tag = trimWhitespace(exact ? name : name.replace(/^#+/, ''))
    const key = tag.toLowerCase()
    if (!tag || /[\r\n]/.test(tag) || charCount(tag) > MAX_TAG_NAME_CHARS || seen.has(key)) {
      continue
    }
    seen.add(key)
    tags.push(tag)
  }
  return tags
}

type YamlValue =
  | { text: string | null; quoted: boolean }
  | { list: readonly (string | null)[] }
  | { other: true }

const NULL_WORDS = new Set(['', '~', 'null', 'Null', 'NULL'])

function textOf(node: unknown): { text: string | null; quoted: boolean } | undefined {
  if (!isScalar(node)) return undefined
  const value = typeof node.value === 'string' ? node.value : ''
  if (node.type === 'BLOCK_LITERAL' || node.type === 'BLOCK_FOLDED') {
    return { text: value.trim() === '' ? null : value.replace(/\n$/, ''), quoted: false }
  }
  if (node.type === 'QUOTE_DOUBLE' || node.type === 'QUOTE_SINGLE') {
    return { text: value, quoted: true }
  }
  return { text: NULL_WORDS.has(value) ? null : value, quoted: false }
}

/** Undefined when the YAML is not valid; everything is read as text (failsafe schema), so `2024` and `true` stay as written. */
function yamlValue(chunk: string): YamlValue | undefined {
  const doc = parseDocument(chunk, { schema: 'failsafe', uniqueKeys: false })
  if (doc.errors.length > 0 || !isMap(doc.contents) || doc.contents.items.length !== 1) {
    return undefined
  }
  const node = doc.contents.items[0]?.value ?? null
  if (node === null) return { text: null, quoted: false }
  if (isSeq(node)) return { list: node.items.map((item) => textOf(item)?.text ?? null) }
  return textOf(node) ?? { other: true }
}

function keyChunks(yaml: string): { key: string; rest: string; text: string }[] {
  const chunks: { key: string; rest: string; text: string }[] = []
  for (const line of yaml.split(/\r?\n/)) {
    const match = KEY.exec(line)
    if (match) chunks.push({ key: match[1]!.toLowerCase(), rest: match[2]!, text: line })
    else if (chunks.length > 0) chunks.at(-1)!.text += `\n${line}`
  }
  return chunks
}

const lineText = (rest: string) => scalar(withoutComment(rest))

function lineTags(rest: string): string[] {
  const value = trimWhitespace(rest)
  if (value.startsWith('[')) {
    const close = value.lastIndexOf(']')
    return splitList(value.slice(1, close < 0 ? undefined : close)).map(scalar)
  }
  return splitList(withoutComment(value)).map(scalar)
}

/** `notebook` is read for templates only (templates.ts); import uses the other keys. A key whose YAML is invalid is read from its line as it stands. Keys match in any case and the last of a repeated key counts. */
export function readFrontMatter(markdown: string): FrontMatterMeta {
  return metaOf(yamlOf(parse(markdown)))
}

function metaOf(yaml: string | null, exact = false): FrontMatterMeta {
  const meta: FrontMatterMeta = { title: null, notebook: null, tags: [], status: null }
  if (yaml === null) return meta
  for (const { key, rest, text } of keyChunks(yaml)) {
    if (key !== 'title' && key !== 'notebook' && key !== 'status' && key !== 'tags') continue
    const read = yamlValue(text)
    if (key === 'tags') {
      if (!read) meta.tags = cleanTags(lineTags(rest), exact)
      else if ('list' in read)
        meta.tags = cleanTags(
          read.list.filter((t) => t !== null),
          exact,
        )
      else if ('text' in read) {
        // A comma-separated value, unless it was quoted: that is one tag.
        const names = read.text === null ? [] : read.quoted ? [read.text] : read.text.split(',')
        meta.tags = cleanTags(names, exact)
      } else meta.tags = []
      continue
    }
    // The other keys take one text; a list or a map says none.
    const one = !read ? lineText(rest) : 'text' in read ? read.text : null
    if (key === 'title') meta.title = one
    else if (key === 'notebook') meta.notebook = oneLine(one ?? '') || null
    else meta.status = one === null ? null : statusFromName(one)
  }
  return meta
}

function plainText(node: Nodes): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'inlineMath') {
    return node.value
  }
  if (node.type === 'image') return node.alt ?? ''
  if (node.type === 'break') return ' '
  return 'children' in node ? node.children.map((child) => plainText(child as Nodes)).join('') : ''
}

const clip = (text: string, max: number) => {
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max).join('').trim() : text
}

/** On one line, at most MAX_TITLE_CHARS characters. */
export const noteTitle = (text: string) => clip(oneLine(text), MAX_TITLE_CHARS)

function baseName(path: string): string {
  const name = path.split('/').pop() ?? path
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
  return own.title ?? titleOf(parse(own.body), path)
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
  const tree = parse(markdown)
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
    return parse(rest.startsWith('\n') ? rest.slice(1) : rest)
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
  const paragraph = parse(`![](${raw})`).children[0]
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
  return imagesOf(parse(markdown), markdown).links
}

export function unlocatedImages(markdown: string): string[] {
  return imagesOf(parse(markdown), markdown).unlocated
}

function imagesOf(tree: Root, markdown: string): { links: ImageLink[]; unlocated: string[] } {
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
  return clip(oneLine(name.replace(/\p{Cc}/gu, ' ')), MAX_BOOK_NAME_CHARS) || '_'
}

export async function importMarkdown(options: ImportOptions): Promise<ImportReport> {
  const { notes, books, tags, newId, scan, source, onProgress, stopped, files: store } = options
  const destination = options.destination ?? null
  const problems: ImportProblem[] = [...scan.skipped]
  // Notebooks are made when their first note is imported; `made` collects them so a failed file can take them back.
  const folders = new Map<string, string | null>([['', destination]])
  const folder = async (path: string, made: string[]): Promise<string | null> => {
    const known = folders.get(path)
    if (known !== undefined) return known
    const parent = await folder(folderOf(path), made)
    const id = await books.create(bookName(path.split('/').pop() ?? path), parent)
    folders.set(path, id)
    made.push(path)
    return id
  }

  let imported = 0
  let attachments = 0
  const noteIds: Record<string, string> = {}
  const paths = scan.files.map((f) => f.path)
  const total = paths.length
  await onProgress?.(0, total)
  for (const [index, path] of paths.entries()) {
    if (stopped?.()) {
      for (const rest of paths.slice(index)) problems.push({ path: rest, code: 'E_IMPORT_STOPPED' })
      break
    }
    let id: string | undefined
    let stored = 0
    const made: string[] = []
    const found: ImportProblem[] = []
    try {
      const raw = lineFeeds(await source.read(path))
      const html = isHtmlFile(path) ? htmlToMarkdown(raw, store ? newId : undefined) : null
      const own = ownMeta(html ? html.markdown : raw)
      let text = own.body
      let tree = parse(text)
      const meta = own.meta
      const title = own.title ?? (html?.title ? clipTitle(html.title) : titleOf(tree, path))
      id = await notes.create(title, await folder(noteFolder(scan.kind, path), made))
      const noteId = id
      for (const dropped of html?.dropped ?? []) {
        found.push({ path, image: dropped, code: 'E_IMPORT_HTML_CONTENT_DROPPED' })
      }
      if (html && store) {
        let refused = false
        for (const image of html.images) {
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
        if (refused) tree = parse(text)
      }

      const files = new Map<string, string | null>()
      const edits: TextEdit[] = []
      const images = imagesOf(tree, text)
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
        if (!files.has(target.path)) {
          const fileId = newId()
          try {
            await source.attach(target.path, { id: fileId, noteId })
            files.set(target.path, fileId)
            stored += 1
          } catch (error) {
            files.set(target.path, null)
            found.push({ path, image: target.path, code: errorCode(error, 'E_IMPORT_FAILED') })
          }
        }
        const fileId = files.get(target.path)
        if (fileId) {
          // A size preset (`#half`) stays on the attachment's link.
          const dest = withImageSize(fileUri(fileId), splitImageSize(link.url).size)
          edits.push({ start: link.start, end: link.end, text: dest })
        }
      }
      await notes.setBody(noteId, replaceRanges(text, edits))
      if (meta.status !== null && meta.status !== 'none') await notes.setStatus(noteId, meta.status)
      // Tags last: a tag made for a note that then failed would stay unused.
      for (const tag of meta.tags) await tags.addToNote(noteId, tag)
      await notes.release(noteId)
      imported += 1
      noteIds[path] = noteId
      attachments += stored
      problems.push(...found)
    } catch (error) {
      problems.push({ path, code: errorCode(error, 'E_IMPORT_FAILED') })
      if (!(await discard(id, made))) problems.push({ path, code: 'E_IMPORT_INCOMPLETE' })
    }
    await onProgress?.(index + 1, total)
  }

  /** Takes back a failed file's note (purging also deletes its attachments) and the notebooks made only for it. False when that fails. */
  async function discard(noteId: string | undefined, made: string[]): Promise<boolean> {
    try {
      if (noteId !== undefined) {
        await notes.trash(noteId)
        await notes.purge(noteId)
      }
      for (const path of made.reverse()) {
        await books.remove(folders.get(path) as string)
        folders.delete(path)
      }
      return true
    } catch {
      console.warn('W_IMPORT_CLEANUP_FAILED', noteId)
      return false
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
    problems,
  }
}
