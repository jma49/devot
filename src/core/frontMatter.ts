// Front matter as notes, templates, import and Note Info read it, apart from import.ts so they
// read it without the import pipeline (HTML conversion, images, wiki links).
import type { Root } from 'mdast'
import remarkFrontmatter from 'remark-frontmatter'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { MAX_TITLE_CHARS } from './noteLimits'
import { statusFromName } from './search'
import type { NoteStatus } from './storage'
import { MAX_TAG_NAME_CHARS } from './tagNames'
import { charCount, trimWhitespace } from './text'

export interface FrontMatterMeta {
  title: string | null
  notebook: string | null
  tags: string[]
  status: NoteStatus | null
}

export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

const parser = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml'])
  .use(remarkGfm)
  .use(remarkMath)

export const parseMarkdown = (markdown: string) => parser.parse(markdown) as Root

export const yamlOf = (tree: Root) => {
  const head = tree.children[0]
  return head?.type === 'yaml' ? head.value : null
}

export function frontMatter(markdown: string): string | null {
  return yamlOf(parseMarkdown(markdown))
}

/** Front matter lines end at LF, though a value may hold a line or paragraph separator. */
const KEY = /^([A-Za-z_][\w-]*)[ \t]*:(.*)$/s

export const EXPORT_HEADER = '# Devot metadata'

export const isExportBlock = (yaml: string) => yaml.split('\n')[0]?.trimEnd() === EXPORT_HEADER

export function exportHeader(markdown: string): { meta: FrontMatterMeta; body: string } | null {
  // Front matter opens the first line (import reads files without a byte order mark): a file without it is parsed once, not twice.
  if (!markdown.startsWith('---')) return null
  const head = parseMarkdown(markdown).children[0]
  const end = head?.position?.end.offset
  if (head?.type !== 'yaml' || end === undefined) return null
  if (!isExportBlock(head.value)) return null
  const rest = markdown.slice(end)
  return { meta: metaOf(head.value, true), body: rest.startsWith('\n') ? rest.slice(1) : rest }
}

export function withoutFrontMatterKeys(markdown: string, keys: readonly string[]): string {
  const head = parseMarkdown(markdown).children[0]
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
  return metaOf(yamlOf(parseMarkdown(markdown)))
}

/** `readFrontMatter` for front matter already taken out of its note (the preview's). */
export const readFrontMatterYaml = (yaml: string): FrontMatterMeta => metaOf(yaml)

export function metaOf(yaml: string | null, exact = false): FrontMatterMeta {
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

export const clip = (text: string, max: number) => {
  const chars = [...text]
  return chars.length > max ? chars.slice(0, max).join('').trim() : text
}

/** On one line, at most MAX_TITLE_CHARS characters. */
export const noteTitle = (text: string) => clip(oneLine(text), MAX_TITLE_CHARS)
