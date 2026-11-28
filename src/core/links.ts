// Note links: a standard Markdown link to `devot://note/<id>`. Links resolve
// by ID, so renaming a note never breaks them. The link index (the `links`
// table) holds, for every note, the notes its Markdown links to: every
// `devot://note/<UUIDv7>` in the body, wherever it appears. Migration 0007
// backfills with the same rule. Backlinks are read from it.
import { UUID_SOURCE, UUID_V7_SOURCE } from './ids'
import type { NoteSummary, StorageAdapter } from './storage'
import { TEMPLATES_BOOK_ID } from './templatesBook'

export const MAX_NOTE_LINKS = 10_000

const NOTE_LINK = new RegExp(`devot://note/(${UUID_V7_SOURCE})(?![0-9a-f-])`, 'g')

export function noteLinks(markdown: string): string[] {
  const ids = new Set<string>()
  for (const match of markdown.matchAll(NOTE_LINK)) ids.add(match[1] as string)
  return [...ids].sort()
}

export function noteUri(id: string): string {
  return `devot://note/${id}`
}

const NOTE_EMBED = new RegExp(
  `!\\[(?:[^\\]\\\\\\n]|\\\\.)*\\]\\(devot://note/(${UUID_V7_SOURCE})\\)`,
  'g',
)

/** Notes past this many embedded in one note show as links. */
export const MAX_NOTE_EMBEDS = 20

/** The notes `markdown` embeds (`![title](devot://note/<id>)`), sorted, at most MAX_NOTE_EMBEDS. */
export function noteEmbeds(markdown: string): string[] {
  const ids = new Set<string>()
  for (const match of markdown.matchAll(NOTE_EMBED)) {
    ids.add(match[1] as string)
    if (ids.size === MAX_NOTE_EMBEDS) break
  }
  return [...ids].sort()
}

const NOTE_URI = new RegExp(`^devot://note/(${UUID_SOURCE})$`)

/** Undefined for any other address. */
export function noteIdOf(href: string): string | undefined {
  return NOTE_URI.exec(href)?.[1]
}

/** On one line, with the punctuation that would read as formatting, a table divider or HTML escaped, so a link's text shows as typed. */
export const linkText = (text: string) =>
  text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[\\[\]|*`<~]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])|&(?=#?\w+;)/gu, (c) => `\\${c}`)

export const noteLink = (title: string, id: string): string =>
  `[${linkText(title)}](${noteUri(id)})`

export const noteEmbed = (title: string, id: string): string => `!${noteLink(title, id)}`

export const MAX_BACKLINKS = 200

/** Live notes only (never the Trash or Templates), the note itself left out, most recently updated first. */
export function findBacklinks(
  storage: Pick<StorageAdapter, 'listBacklinks'>,
  id: string,
): Promise<NoteSummary[]> {
  return storage.listBacklinks(id, TEMPLATES_BOOK_ID, MAX_BACKLINKS)
}
