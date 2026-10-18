// The formats a pasted URL can take in the paste chooser (pasteChooser.ts),
// in the order the list shows them, and the text each one writes. Pure: the
// page title and the GitHub file come in from outside, fetched only once a
// format that needs them is highlighted or picked.
import { parseGithubBlobUrl, type GithubBlob } from '../../../core/codeMeta'
import type { MessageKey } from '../i18n'
import { linkAddress } from './formats'

export type PasteFormatType = 'plain' | 'snippet' | 'title' | 'emptyText' | 'autolink'

/** What a format needs fetched before it can write its text. */
export type PasteFetch = 'title' | 'snippet'

export interface PasteFormat {
  type: PasteFormatType
  label: MessageKey
  /** The row's hint: what the text looks like. */
  detail: MessageKey
  fetch: PasteFetch | null
}

const FORMATS: readonly PasteFormat[] = [
  { type: 'plain', label: 'pasteFormat.plain', detail: 'pasteFormat.plainDetail', fetch: null },
  {
    type: 'snippet',
    label: 'pasteFormat.snippet',
    detail: 'pasteFormat.snippetDetail',
    fetch: 'snippet',
  },
  { type: 'title', label: 'pasteFormat.title', detail: 'pasteFormat.titleDetail', fetch: 'title' },
  {
    type: 'emptyText',
    label: 'pasteFormat.emptyText',
    detail: 'pasteFormat.emptyTextDetail',
    fetch: null,
  },
  {
    type: 'autolink',
    label: 'pasteFormat.autolink',
    detail: 'pasteFormat.autolinkDetail',
    fetch: null,
  },
]

/**
 * The formats `url` can take, in list order. A page title is fetched over
 * https only; a snippet needs a github.com file link (and no backtick, which
 * a fence's info string cannot hold); an autolink cannot hold `<` or `>`.
 */
export function pasteFormats(url: string): PasteFormat[] {
  const https = /^https:\/\//i.test(url)
  return FORMATS.filter((f) => {
    if (f.type === 'snippet') return parseGithubBlobUrl(url) !== null && !url.includes('`')
    if (f.type === 'title') return https
    if (f.type === 'autolink') return !/[<>]/.test(url)
    return true
  })
}

/** Text that goes between a link's brackets as it reads: Markdown punctuation escaped. */
export function escapeLinkText(text: string): string {
  return text.replace(/[\\`{}[\]()<>|*]/g, (c) => `\\${c}`)
}

/** Whether the line around the URL has text before it and after it. */
export interface LineAround {
  before: boolean
  after: boolean
}

/** A format's text, and where the selection goes in it (offsets into `insert`). */
export interface FormattedUrl {
  insert: string
  anchor: number
  head: number
}

const caretAtEnd = (insert: string): FormattedUrl => ({
  insert,
  anchor: insert.length,
  head: insert.length,
})

/**
 * What a format writes for `url`. `fetched` is the page title (`title`) or
 * the finished fence (`snippet`, from snippetFence). A snippet is a block:
 * it gets a line of its own when the line has other text.
 */
export function formatUrl(
  type: PasteFormatType,
  url: string,
  fetched: string | null,
  around: LineAround = { before: false, after: false },
): FormattedUrl {
  switch (type) {
    case 'plain':
      return caretAtEnd(url)
    case 'autolink':
      // `|` would end a table cell, inside an autolink too.
      return caretAtEnd(`<${url.replace(/\|/g, '%7C')}>`)
    case 'emptyText': {
      const insert = `[](${linkAddress(url)})`
      return { insert, anchor: 1, head: 1 }
    }
    case 'title': {
      const text = escapeLinkText(fetched ?? '')
      // The title comes out selected, ready to be retyped.
      return { insert: `[${text}](${linkAddress(url)})`, anchor: 1, head: 1 + text.length }
    }
    case 'snippet': {
      const before = around.before ? '\n' : ''
      const insert = `${before}${fetched ?? ''}${around.after ? '\n' : ''}`
      const end = before.length + (fetched ?? '').length
      return { insert, anchor: end, head: end }
    }
  }
}

/** Special file names, by their lower-cased name. */
const FILE_LANGUAGES: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.env': 'env',
}

/** A fence language for a file path: by its name, else its extension; '' for none. */
export function snippetLanguage(path: string): string {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  const known = FILE_LANGUAGES[name]
  if (known) return known
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  return /^[a-z0-9_+#-]{1,32}$/.test(ext) ? ext : ''
}

/** A commit hash shows short in a fence: the first seven characters. */
const SHORT_COMMIT = 7
/** What the code block preview reads as a ref (code.ts REF). */
const REF = /^[\w./-]{1,100}$/

/**
 * A fenced code block of a GitHub file, or of the lines the link's `#L5` or
 * `#L5-L9` names, with the source in its info string:
 * ```ts line=5-9 branch=main url=https://github.com/o/r/blob/main/a.ts#L5-L9
 */
export function snippetFence(code: string, blob: GithubBlob, url: string): string {
  let lines = code.replace(/\r\n?/g, '\n').split('\n')
  if (blob.lines) lines = lines.slice(blob.lines.start - 1, blob.lines.end ?? blob.lines.start)
  else if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const body = lines.join('\n')
  const info = [snippetLanguage(blob.path)]
  if (blob.lines)
    info.push(`line=${blob.lines.start}${blob.lines.end === null ? '' : `-${blob.lines.end}`}`)
  if (blob.isCommit) info.push(`commit=${blob.ref.slice(0, SHORT_COMMIT)}`)
  else if (REF.test(blob.ref)) info.push(`branch=${blob.ref}`)
  info.push(`url=${url}`)
  // A fence longer than any backtick run in the code, so the code cannot close it.
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  const head = `${fence}${info.filter(Boolean).join(' ')}`
  return body === '' ? `${head}\n${fence}` : `${head}\n${body}\n${fence}`
}
