// Note links: a standard Markdown link to `devot://note/<id>`. Links resolve
// by ID, so renaming a note never breaks them. The link index (the `links`
// table) holds, for every note, the notes its Markdown links to: every
// `devot://note/<UUIDv7>` in the body, wherever it appears. Migration 0007
// backfills with the same rule. Backlinks are read from it.
import type { NoteSummary, StorageAdapter } from './storage'
import { TEMPLATES_BOOK_ID } from './templatesBook'

export const MAX_NOTE_LINKS = 10_000

const NOTE_LINK =
  /devot:\/\/note\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/g

export function noteLinks(markdown: string): string[] {
  const ids = new Set<string>()
  for (const match of markdown.matchAll(NOTE_LINK)) ids.add(match[1] as string)
  return [...ids].sort()
}

export function noteUri(id: string): string {
  return `devot://note/${id}`
}

/** Undefined for any other address. */
export function noteIdOf(href: string): string | undefined {
  return /^devot:\/\/note\/([0-9a-f-]{36})$/.exec(href)?.[1]
}

/** On one line, with the punctuation that would read as formatting, a table divider or HTML escaped, so a link's text shows as typed. */
export const linkText = (text: string) =>
  text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[\\[\]|*`<~]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])|&(?=#?\w+;)/gu, (c) => `\\${c}`)

export const noteLink = (title: string, id: string): string =>
  `[${linkText(title)}](${noteUri(id)})`

export const MAX_BACKLINKS = 200

/** Live notes only (never the Trash or Templates), the note itself left out, most recently updated first. */
export function findBacklinks(
  storage: Pick<StorageAdapter, 'listBacklinks'>,
  id: string,
): Promise<NoteSummary[]> {
  return storage.listBacklinks(id, TEMPLATES_BOOK_ID, MAX_BACKLINKS)
}
