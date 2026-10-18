// Note links: a standard Markdown link to `devot://note/<id>`. Links resolve
// by ID, so renaming a note never breaks them. The link index (the `links`
// table) holds, for every note, the notes its Markdown links to: every
// `devot://note/<UUIDv7>` in the body, wherever it appears. Migration 0007
// backfills with the same rule.
import type { NoteQuery, NoteSummary, StorageAdapter } from './storage'

/** The most note links one note may hold; the app's note_put refuses more. */
export const MAX_NOTE_LINKS = 10_000

const NOTE_LINK =
  /devot:\/\/note\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f-])/g

/** The IDs of the notes a body links to, each once, sorted. */
export function noteLinks(markdown: string): string[] {
  const ids = new Set<string>()
  for (const match of markdown.matchAll(NOTE_LINK)) ids.add(match[1] as string)
  return [...ids].sort()
}

/** `devot://note/<id>`: the URI a note link points at. */
export function noteUri(id: string): string {
  return `devot://note/${id}`
}

/** `[title](devot://note/<id>)`, with the title escaped for link text. */
export function noteLink(title: string, id: string): string {
  const text = title.replace(/\s*\n\s*/g, ' ').replace(/[\\[\]]/g, (c) => `\\${c}`)
  return `[${text}](${noteUri(id)})`
}

/** The most notes the "Linked to this note" list shows. */
export const MAX_BACKLINKS = 200

/** The storage query for live notes whose body holds a link to note `id`. */
export function backlinkQuery(id: string): NoteQuery {
  return { text: [{ field: 'body', value: noteUri(id), negate: false }], sets: [], pinned: null }
}

/**
 * The notes that link to note `id`: live notes (never one in the Trash) whose
 * Markdown holds `devot://note/<id>`, the note itself left out.
 */
export async function findBacklinks(
  storage: Pick<StorageAdapter, 'searchNotes'>,
  id: string,
): Promise<NoteSummary[]> {
  const found = await storage.searchNotes(backlinkQuery(id), MAX_BACKLINKS + 1)
  return found.filter((note) => note.id !== id).slice(0, MAX_BACKLINKS)
}
