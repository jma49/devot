// Note links: a standard Markdown link to `devot://note/<id>`. Links resolve
// by ID, so renaming a note never breaks them. The link index (the `links`
// table) holds, for every note, the notes its Markdown links to: every
// `devot://note/<UUIDv7>` in the body, wherever it appears. Migration 0007
// backfills with the same rule.
import type { NoteQuery, NoteSummary, StorageAdapter } from './storage'

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

export function noteLink(title: string, id: string): string {
  const text = title.replace(/\s*\n\s*/g, ' ').replace(/[\\[\]]/g, (c) => `\\${c}`)
  return `[${text}](${noteUri(id)})`
}

export const MAX_BACKLINKS = 200

export function backlinkQuery(id: string): NoteQuery {
  return { text: [{ field: 'body', value: noteUri(id), negate: false }], sets: [], pinned: null }
}

/** Live notes only (never the Trash), the note itself left out. */
export async function findBacklinks(
  storage: Pick<StorageAdapter, 'searchNotes'>,
  id: string,
): Promise<NoteSummary[]> {
  const found = await storage.searchNotes(backlinkQuery(id), MAX_BACKLINKS + 1)
  return found.filter((note) => note.id !== id).slice(0, MAX_BACKLINKS)
}
