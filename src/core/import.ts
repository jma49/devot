// Markdown folder import. Rust reads the folder the user picked (only that
// folder, see src-tauri/src/import.rs); this module turns what it finds into
// notebooks, notes, tags, statuses and attachments.
//
// Rules:
// - The folder becomes a top-level notebook named after it; every folder
//   below it that holds an imported note (at any depth) becomes a nested
//   notebook. Folders with no imported notes under them (image folders, or
//   folders whose files all failed) do not.
// - The title is the front matter `title`, else the first level-one
//   heading, else the file name without its extension. The body keeps the
//   heading.
// - Front matter `tags` and `status` become Devot tags and status. The front
//   matter itself stays in the note unchanged, including those keys.
// - Front matter that Markdown export added (its first line is the comment
//   EXPORT_HEADER, see export.ts) is Devot's own: its title (exactly, only
//   cut to the limit), tags (a leading `#` kept) and status become the
//   note's, its double-quoted values with their escapes read, and it is
//   left out of the note, so an exported note imports as it was. Elsewhere
//   a tag's leading `#`s are dropped (`#work` is the tag `work`).
// - Local images (`![](path)`, reference definitions that images use, and
//   the `src` of an `<img>` in raw HTML) become attachments, and only their
//   destinations are rewritten to `devot://file/<id>`, keeping a size preset
//   (`img.png#half` becomes `devot://file/<id>#half`; any other fragment or
//   query is dropped with the rest of the path). Everything else in the
//   source is kept as-is, including `[[...]]`, which stays plain text.
//   Remote images stay links. A local image whose link cannot be found in
//   the text (to rewrite) is listed as not imported.
// - Line breaks become `\n` (from `\r\n` or a lone `\r`): the editor counts
//   a CRLF as one character and the Yjs text as two, so a `\r` in a body
//   would make every edit after it land in the wrong place.
// - A file that fails part-way leaves no note behind (nor the notebooks
//   made only for it): it is listed as not imported instead.
// - Bodies reach the note as Yjs operations (`NoteService.setBody`), never
//   by writing the snapshot.

import { fromHtml } from 'hast-util-from-html'
import type { Root, Nodes } from 'mdast'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { MAX_BOOK_NAME_CHARS, type BookService } from './books'
import { errorCode } from './errors'
import { fileUri } from './files'
import { splitImageSize, withImageSize } from './images'
import { clipTitle, MAX_TITLE_CHARS } from './noteLimits'
import type { NoteService } from './notes'
import { statusFromName } from './search'
import type { NoteStatus } from './storage'
import type { TagService } from './tags'
import { MAX_TAG_NAME_CHARS } from './tags'
import { charCount, lineFeeds, replaceRanges, trimWhitespace, type TextEdit } from './text'

/** What Rust found in the picked folder. Paths are relative, with `/`. */
export interface ImportScan {
  /** The import session; Rust only reads files for a session it started. */
  id: number
  /** The folder's own name. */
  name: string
  /** Markdown files, sorted. */
  files: string[]
  /** Files Rust left out, with the reason's code. */
  skipped: ImportProblem[]
}

export interface ImportProblem {
  /** The Markdown file (relative to the folder). */
  path: string
  /** The image, when the problem is one of the note's images. */
  image?: string
  code: string
}

/** Reads from the picked folder (in the app: Tauri commands). */
export interface ImportSource {
  /** A Markdown file's text. */
  read(path: string): Promise<string>
  /** Stores the image at `path` as attachment `file.id` of note `file.noteId`. */
  attach(path: string, file: { id: string; noteId: string }): Promise<void>
}

export interface ImportReport {
  /** The notebook made for the folder; null when no note was imported. */
  bookId: string | null
  notes: number
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
  /** Called before the first file and after each one. */
  onProgress?: (done: number, total: number) => unknown
  /**
   * Asked before each file; once true, the import ends there (the file it
   * was on is finished first) and the rest are listed as not imported.
   */
  stopped?: () => boolean
}

export interface FrontMatterMeta {
  title: string | null
  /** A notebook's name or path (templates.ts); import ignores it. */
  notebook: string | null
  tags: string[]
  status: NoteStatus | null
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// --- Front matter -----------------------------------------------------------

// The same Markdown dialect, in the same plugin order, as the preview
// (preview/index.ts), so code, math and front matter are recognised alike.
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

/** The YAML front matter at the very start of a note, without its fences. */
export function frontMatter(markdown: string): string | null {
  return yamlOf(parse(markdown))
}

/**
 * A top-level key of YAML front matter, and the rest of its line (which may
 * hold a line or paragraph separator: front matter lines end at `\n`).
 */
const KEY = /^([A-Za-z_][\w-]*)[ \t]*:(.*)$/s

/**
 * The first line of the front matter Markdown export adds to a note (a YAML
 * comment, so other tools ignore it); import leaves that front matter out.
 */
export const EXPORT_HEADER = '# Devot metadata'

/** Whether front matter (without its fences) is the block Markdown export adds: its first line is EXPORT_HEADER. */
export const isExportBlock = (yaml: string) => yaml.split('\n')[0]?.trimEnd() === EXPORT_HEADER

/**
 * The front matter Markdown export added to `markdown`, if it starts with
 * one: what it says, and the note without it (and the line break after it).
 */
export function exportHeader(markdown: string): { meta: FrontMatterMeta; body: string } | null {
  const head = parse(markdown).children[0]
  const end = head?.position?.end.offset
  if (head?.type !== 'yaml' || end === undefined) return null
  if (!isExportBlock(head.value)) return null
  const rest = markdown.slice(end)
  return { meta: metaOf(head.value, true), body: rest.startsWith('\n') ? rest.slice(1) : rest }
}

/**
 * `markdown` with these top-level keys of its front matter set: each key's
 * lines (matched in any case, with the lines that follow it up to the next
 * key) are dropped, and the new `key: value` lines go at the end of the
 * front matter. Everything else is kept as written. Without front matter,
 * `markdown` comes back as it was.
 */
export function setFrontMatterKeys(
  markdown: string,
  entries: readonly (readonly [string, string])[],
): string {
  const head = parse(markdown).children[0]
  const start = head?.position?.start.offset
  const end = head?.position?.end.offset
  if (entries.length === 0 || head?.type !== 'yaml' || start === undefined || end === undefined) {
    return markdown
  }
  const drop = new Set(entries.map(([key]) => key.toLowerCase()))
  const lines = markdown.slice(start, end).split('\n')
  let dropping = false
  const kept = lines.slice(1, -1).filter((line) => {
    const match = KEY.exec(line.replace(/\r$/, ''))
    if (match) dropping = drop.has(match[1]!.toLowerCase())
    return !dropping
  })
  const added = entries.map(([key, value]) => `${key}: ${value}`)
  const block = [lines[0], ...kept, ...added, lines.at(-1)].join('\n')
  return markdown.slice(0, start) + block + markdown.slice(end)
}

/**
 * `markdown` without these top-level keys (matched in any case) in its
 * front matter, each with the lines that follow it up to the next key
 * (a block list, say). When no key is left, the front matter goes too,
 * with the blank lines after it. Everything else is kept as written.
 */
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

/** YAML's escapes of one character in double-quoted scalars, and what they stand for. */
const YAML_ESCAPES: Readonly<Record<string, string>> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  '\t': '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: String.fromCodePoint(0x85),
  _: String.fromCodePoint(0xa0),
  L: String.fromCodePoint(0x2028),
  P: String.fromCodePoint(0x2029),
}

/** A YAML double-quoted scalar's text with its escapes read; one it does not know stays as written. */
function unescapeYaml(text: string): string {
  return text.replace(
    /\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[^])/g,
    (all, escape: string) => {
      if (escape.length > 1) {
        const code = Number.parseInt(escape.slice(1), 16)
        return code <= 0x10ffff ? String.fromCodePoint(code) : all
      }
      return YAML_ESCAPES[escape] ?? all
    },
  )
}

/**
 * A YAML scalar without its quotes. `exact` (Devot's own block, see
 * `quoted` in export.ts) reads every escape of a double-quoted one;
 * elsewhere only `\"` and `\\` are read, and the rest stays as written.
 */
function scalar(raw: string, exact = false): string {
  const value = trimWhitespace(raw)
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const inner = value.slice(1, -1)
    return exact ? unescapeYaml(inner) : inner.replace(/\\(["\\])/g, '$1')
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

/** Splits on commas that are not inside quotes (a `\` in double quotes escapes the next character). */
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

/** Tag names from list items: unquoted, without a leading `#` (unless `exact`). */
function cleanTags(raw: string[], exact = false): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const item of raw) {
    const name = scalar(item, exact)
    // Trimmed as tag names are (and as Rust checks them).
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

function toStatus(raw: string): NoteStatus | null {
  return statusFromName(scalar(raw))
}

/**
 * The keys Devot reads from front matter: `title`, `notebook`, `tags` (a
 * flow list, a block list, or a comma-separated value) and `status`. Keys
 * match in any case; every other key is ignored. Import uses all but
 * `notebook`; a note made from a template uses all four (templates.ts).
 */
export function readFrontMatter(markdown: string): FrontMatterMeta {
  return metaOf(yamlOf(parse(markdown)))
}

/**
 * What front matter says (see `readFrontMatter`). `exact` (Devot's own, from
 * export) keeps a tag's leading `#`, since a tag may start with one.
 */
function metaOf(yaml: string | null, exact = false): FrontMatterMeta {
  const meta: FrontMatterMeta = { title: null, notebook: null, tags: [], status: null }
  if (yaml === null) return meta
  const lines = yaml.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const match = KEY.exec(lines[i] ?? '')
    if (!match) continue
    const key = match[1]!.toLowerCase()
    const value = trimWhitespace(match[2]!)
    if (key === 'title') {
      meta.title = scalar(value, exact)
    } else if (key === 'notebook') {
      meta.notebook = oneLine(scalar(value)) || null
    } else if (key === 'status') {
      meta.status = toStatus(value)
    } else if (key === 'tags') {
      if (value.startsWith('[') && value.endsWith(']')) {
        meta.tags = cleanTags(splitList(value.slice(1, -1)), exact)
      } else if (value) {
        meta.tags = cleanTags(splitList(value), exact)
      } else {
        // A block list: `- item` lines, indented or not.
        const items: string[] = []
        while (i + 1 < lines.length && /^[ \t]*-(?:[ \t]|$)/.test(lines[i + 1] ?? '')) {
          i += 1
          items.push((lines[i] ?? '').replace(/^[ \t]*-/, ''))
        }
        meta.tags = cleanTags(items, exact)
      }
    }
  }
  return meta
}

// --- Title ------------------------------------------------------------------

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

/** `text` as a note title: on one line, at most MAX_TITLE_CHARS characters. */
export const noteTitle = (text: string) => clip(oneLine(text), MAX_TITLE_CHARS)

/** A file's name without its folder and its extension. */
function baseName(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.replace(/\.[^.]+$/, '') || name
}

/** The title an imported note gets (see the rules at the top). */
export function importTitle(markdown: string, path: string): string {
  const tree = parse(markdown)
  return titleOf(tree, metaOf(yamlOf(tree)), path)
}

/**
 * A line a level-one heading may start on or end with: an ATX `#` (up to
 * three spaces in) followed by a space, a tab or the line's end, or a
 * setext `=` underline.
 */
const LEVEL_ONE_LINE = /^ {0,3}(?:#(?:[ \t]|$)|=+[ \t]*$)/m

/**
 * The start of an `<img>` tag in raw HTML: HTML reads a tag's name in any
 * ASCII case. Without the `u` flag, `i` never matches a character outside
 * ASCII to an ASCII letter.
 */
const HTML_IMG = /<img/i

/**
 * Whether Markdown may show an image: an image in Markdown starts with `![`
 * (inline or by reference), one in raw HTML with `<img`. Markdown without
 * either has none, whatever a parse would find.
 */
export const mayShowImages = (markdown: string) =>
  markdown.includes('![') || HTML_IMG.test(markdown)

/** What export reads from a note's Markdown (see `markdownFacts`). */
export interface MarkdownFacts {
  /** The image destinations, as `imageLinks` finds them. */
  links: ImageLink[]
  /** The URLs of images whose destination is not found in the text, as `unlocatedImages` lists them. */
  unlocated: string[]
  /** The front matter, as `frontMatter` finds it. */
  frontMatter: string | null
  /** What the front matter says, as `readFrontMatter` reads it. */
  meta: FrontMatterMeta
  /** The title import gives the note from a file at `path` (`importTitle`). */
  title(path: string): string
}

/**
 * The images, front matter and import title of a note, from one parse at
 * most: Markdown that cannot show an image (`mayShowImages`), does not
 * start with a front matter fence and has no line a level-one heading could
 * be on cannot have any of them, and is not parsed at all.
 */
export function markdownFacts(markdown: string): MarkdownFacts {
  const images = mayShowImages(markdown)
  if (!images && !markdown.startsWith('---') && !LEVEL_ONE_LINE.test(markdown)) {
    return {
      links: [],
      unlocated: [],
      frontMatter: null,
      meta: metaOf(null),
      title: (path) => clip(oneLine(baseName(path)), MAX_TITLE_CHARS),
    }
  }
  const tree = parse(markdown)
  const yaml = yamlOf(tree)
  const meta = metaOf(yaml)
  const found = images ? imagesOf(tree, markdown) : { links: [], unlocated: [] }
  return {
    links: found.links,
    unlocated: found.unlocated,
    frontMatter: yaml,
    meta,
    title: (path) => titleOf(tree, meta, path),
  }
}

function titleOf(tree: Root, meta: FrontMatterMeta, path: string): string {
  const fromYaml = noteTitle(meta.title ?? '')
  if (fromYaml) return fromYaml
  const heading = tree.children.find(
    (node) => node.type === 'heading' && node.depth === 1 && oneLine(plainText(node)) !== '',
  )
  if (heading) return clip(oneLine(plainText(heading)), MAX_TITLE_CHARS)
  return clip(oneLine(baseName(path)), MAX_TITLE_CHARS)
}

// --- Images -----------------------------------------------------------------

/** An image destination in a note: `start`/`end` cover its raw text. */
export interface ImageLink {
  start: number
  end: number
  /** The destination as Markdown reads it (escapes and brackets removed). */
  url: string
  /** The `src` of an `<img>` in raw HTML, rather than a Markdown destination. */
  html?: boolean
}

const TITLE = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))`
/** What may follow an inline image's destination: a title, then the closing parenthesis. */
const INLINE_TAIL = new RegExp(String.raw`^(?:[ \t\n]+${TITLE})?[ \t\n]*\)$`)
/** A link reference definition's label and the space before its destination. */
const DEFINITION_HEAD = /\[(?:[^[\]\\]|\\.)*\]:[ \t]*\n?[ \t]*/

/**
 * Where the raw link destination that starts at `at` in `text` ends, as
 * CommonMark reads one: in angle brackets (no line break, `<` or `>` inside
 * unless escaped), or a run with no ASCII space or control character whose
 * parentheses balance, at any depth (a `\` escapes the next character).
 * -1 when there is none.
 */
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

/** A raw destination as Markdown reads it, with escapes only. */
function unescapeDest(raw: string): string {
  const inner = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw
  return inner.replace(/\\([!-/:-@[-`{-~])/g, '$1')
}

/**
 * Whether Markdown reads `raw` as the destination `url`: escapes alone, or
 * (for character references such as `&amp;`) as the parser reads it.
 */
function readsAs(raw: string, url: string): boolean {
  if (unescapeDest(raw) === url) return true
  const paragraph = parse(`![](${raw})`).children[0]
  const image = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined
  return image?.type === 'image' && image.url === url
}

/** Locates the destination inside `![alt](dest "title")`. */
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

/** Locates the destination inside `[label]: dest "title"`. */
function definitionDest(source: string, start: number, end: number, url: string): ImageLink | null {
  const text = source.slice(start, end)
  const head = DEFINITION_HEAD.exec(text)
  if (!head) return null
  const at = head.index + head[0].length
  const stop = destinationEnd(text, at)
  if (stop === -1 || !readsAs(text.slice(at, stop), url)) return null
  return { start: start + at, end: start + stop, url }
}

// Raw HTML: `<img>` tags and their `src`.

/** Elements whose content is text, not tags. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noembed', 'noframes'])
const BLANK = /[\t\n\f\r ]/
// HTML compares tag and attribute names in ASCII case only, and they are
// compared in place: lowercasing all of `html` could make it longer (U+0130
// becomes two code units) and move every offset after it. Without the `u`
// flag, a regular expression's `i` never matches a character outside ASCII
// to an ASCII letter.
const SRC = /^src$/i

/**
 * Where the text of a raw-text element (`tag`, in lower case) that starts at
 * `from` ends: at the first end tag of that name, in any case, followed by a
 * blank, `/` or `>`. The end of `html` when there is none.
 */
function rawTextEnd(html: string, tag: string, from: number): number {
  const end = new RegExp(`</${tag}[\\t\\n\\f\\r />]`, 'gi')
  end.lastIndex = from
  return end.exec(html)?.index ?? html.length
}

/** The raw `src` value of an `<img>` in HTML: where it is, and how it is quoted. */
interface SrcValue {
  start: number
  end: number
  quote: string
}

/**
 * The `src` of each complete `<img>` tag in `html` (the first one a tag
 * has), in order. Comments, declarations and the text of script, style and
 * the like hold no tags.
 */
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

/** An attribute's raw value as HTML reads it (character references and all). */
function attributeValue(raw: string, quote: string): string {
  const img = fromHtml(`<img src=${quote}${raw}${quote}>`, { fragment: true }).children[0]
  const src = img?.type === 'element' ? img.properties['src'] : undefined
  return typeof src === 'string' ? src : raw
}

/**
 * Where each offset of raw HTML Markdown read (`value`) is in the note,
 * whose text from `start` to `end` it came from: the same text, line by
 * line, but for what containers put before a line (quote markers, list
 * indents; a tab may become spaces). Null when a line's text is not the end
 * of the note's line.
 */
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

/** The `<img>` sources in an html node (`value`, from `start` to `end`), and the URLs of those not found in the text. */
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

/**
 * The image destinations in a note, in order: inline images, reference
 * definitions used by an image, and the `src` of each `<img>` in raw HTML.
 * Code and math are left alone.
 */
export function imageLinks(markdown: string): ImageLink[] {
  return imagesOf(parse(markdown), markdown).links
}

/**
 * The URLs of a note's images whose destination cannot be found in its text
 * (to rewrite), in order: what imports and exports list rather than skip.
 */
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
    url.startsWith('?') ||
    url.includes('\\')
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

/**
 * An image destination as a path relative to the import folder, or null
 * when it is not a local file inside the folder. A leading `/` means the
 * import folder.
 */
export function resolveImagePath(notePath: string, url: string): string | null {
  const resolved = resolve(notePath, url)
  return resolved.kind === 'path' ? resolved.path : null
}

// --- Import -----------------------------------------------------------------

function bookName(name: string): string {
  return clip(oneLine(name.replace(/\p{Cc}/gu, ' ')), MAX_BOOK_NAME_CHARS) || '_'
}

const folderOf = (path: string) => path.split('/').slice(0, -1).join('/')

/** Imports a scanned folder (see the rules at the top of this file). */
export async function importMarkdown(options: ImportOptions): Promise<ImportReport> {
  const { notes, books, tags, newId, scan, source, onProgress, stopped } = options
  const problems: ImportProblem[] = [...scan.skipped]
  // Notebooks are made when their first note is imported; `made` collects
  // the ones a file needed, so a failed file can take them back.
  const folders = new Map<string, string>()
  const folder = async (path: string, made: string[]): Promise<string> => {
    const known = folders.get(path)
    if (known !== undefined) return known
    const parent = path === '' ? null : await folder(folderOf(path), made)
    const name = path === '' ? scan.name : (path.split('/').pop() ?? path)
    const id = await books.create(bookName(name), parent)
    folders.set(path, id)
    made.push(path)
    return id
  }

  let imported = 0
  let attachments = 0
  const total = scan.files.length
  await onProgress?.(0, total)
  for (const [index, path] of scan.files.entries()) {
    if (stopped?.()) {
      for (const rest of scan.files.slice(index))
        problems.push({ path: rest, code: 'E_IMPORT_STOPPED' })
      break
    }
    let id: string | undefined
    let stored = 0
    const made: string[] = []
    try {
      const read = lineFeeds(await source.read(path))
      // Front matter export added is not part of the note.
      const header = exportHeader(read)
      const text = header ? header.body : read
      const tree = parse(text)
      const meta = header ? header.meta : metaOf(yamlOf(tree))
      // Devot's own title is the note's exactly (only cut to the limit).
      const title =
        header && header.meta.title !== null
          ? clipTitle(header.meta.title)
          : titleOf(tree, meta, path)
      id = await notes.create(title, await folder(folderOf(path), made))
      const noteId = id

      // Each image once per note; its links all point at the one attachment.
      const files = new Map<string, string | null>()
      const edits: TextEdit[] = []
      const images = imagesOf(tree, text)
      // An image whose link cannot be found in the text cannot be pointed
      // at an attachment: it is listed, not skipped.
      for (const url of images.unlocated) {
        const target = resolve(path, url)
        if (target.kind === 'outside') {
          problems.push({ path, image: url, code: 'E_IMPORT_PATH_OUTSIDE' })
        } else if (target.kind === 'path') {
          problems.push({ path, image: target.path, code: 'E_IMPORT_IMAGE_UNLOCATED' })
        }
      }
      for (const link of images.links) {
        const target = resolve(path, link.url)
        if (target.kind === 'remote') continue
        if (target.kind === 'outside') {
          problems.push({ path, image: link.url, code: 'E_IMPORT_PATH_OUTSIDE' })
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
            problems.push({ path, image: target.path, code: errorCode(error, 'E_IMPORT_FAILED') })
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
      attachments += stored
    } catch (error) {
      problems.push({ path, code: errorCode(error, 'E_IMPORT_FAILED') })
      if (!(await discard(id, made))) problems.push({ path, code: 'E_IMPORT_INCOMPLETE' })
    }
    await onProgress?.(index + 1, total)
  }

  /**
   * Takes back what a failed file made: its note, if it got that far
   * (purging also deletes its attachments), and the notebooks made only for
   * it. False when that fails.
   */
  async function discard(noteId: string | undefined, made: string[]): Promise<boolean> {
    try {
      if (noteId !== undefined) {
        await notes.trash(noteId)
        await notes.purge(noteId)
      }
      for (const path of made.reverse()) {
        await books.remove(folders.get(path)!)
        folders.delete(path)
      }
      return true
    } catch {
      console.warn('W_IMPORT_CLEANUP_FAILED', noteId)
      return false
    }
  }

  return {
    bookId: folders.get('') ?? null,
    notes: imported,
    books: folders.size,
    attachments,
    problems,
  }
}
