// Tags, note statuses and pinning: the list filters next to notebooks.
// A tag is found by name (case-insensitive) or created when first used; a
// rename never takes another tag's name. A tag picked from a list (a drop,
// the palette, a picker) is put on by ID, so it is the one picked even when
// sync brought two tags of one name.
// Membership is one row per note and tag, so adding and removing a tag are
// writes to the same row and the newer one wins.

import { notesInBook } from './books'
import { receiveStored, type Clock } from './hlc'
import {
  TAG_COLORS,
  type BookRecord,
  type NoteStatus,
  type NoteSummary,
  type StorageAdapter,
  type TagColor,
  type TagRecord,
} from './storage'
import { charCount, trimWhitespace } from './text'

export const MAX_TAG_NAME_CHARS = 100

export interface TagServiceOptions {
  storage: StorageAdapter
  clock: Clock
  newId: () => string
  now?: () => number
}

export interface TagService {
  /** Tags that are not deleted. */
  list(): Promise<TagRecord[]>
  /** Puts the tag named `name` on a note, creating the tag if needed. Returns its ID. */
  addToNote(noteId: string, name: string): Promise<string>
  /** The ID of the tag named `name`, creating the tag if needed. */
  ensure(name: string): Promise<string>
  /** Puts an existing tag on a note. */
  putOnNote(noteId: string, tagId: string): Promise<void>
  removeFromNote(noteId: string, tagId: string): Promise<void>
  /** Renames a tag; a name another tag has (in any case) is refused with `E_TAG_NAME_TAKEN`. */
  rename(id: string, name: string): Promise<void>
  /** Sets the tag's colour to a palette ID, or takes it off (null). */
  setColor(id: string, color: TagColor | null): Promise<void>
  /** Deletes a tag; it disappears from every note. */
  remove(id: string): Promise<void>
}

/** A tag name trimmed as Rust trims it (src-tauri/src/commands/tags.rs checks the same). */
function cleanName(name: string): string {
  const trimmed = trimWhitespace(name)
  if (!trimmed || /[\r\n]/.test(trimmed) || charCount(trimmed) > MAX_TAG_NAME_CHARS) {
    throw new Error('E_TAG_NAME_INVALID')
  }
  return trimmed
}

/** Whether `value` is a palette colour ID. */
export function isTagColor(value: unknown): value is TagColor {
  return (TAG_COLORS as readonly unknown[]).includes(value)
}

/** Whether two names are the same name: in any case, accents counting. */
export const sameName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0

/** The HLCs of a tag's fields. */
const tagStamps = (t: TagRecord) => [t.nameHlc, t.colorHlc, t.deletedHlc]

export function createTagService(options: TagServiceOptions): TagService {
  const { storage, clock, newId } = options
  const now = options.now ?? Date.now

  /**
   * Tags that are not deleted, their stamps taken in by the clock, so a
   * write based on them always wins over them (see receiveStored).
   */
  const listTags = async () => {
    const all = await storage.listTags()
    receiveStored(clock, all.flatMap(tagStamps))
    return all
  }

  /** A stamp for a note's membership row, later than the one stored. */
  const membershipHlc = async (noteId: string, tagId: string) => {
    receiveStored(clock, [(await storage.getNoteTag(noteId, tagId))?.hlc])
    return clock.tick()
  }

  const find = async (id: string) => {
    const tag = (await listTags()).find((t) => t.id === id)
    if (!tag) throw new Error('E_TAG_NOT_FOUND')
    return tag
  }
  const write = (tag: TagRecord) =>
    storage.putTag({ ...tag, updatedAt: Math.max(now(), tag.createdAt) })

  const service: TagService = {
    list: () => storage.listTags(),

    async addToNote(noteId, name) {
      const tagId = await service.ensure(name)
      await service.putOnNote(noteId, tagId)
      return tagId
    },

    async putOnNote(noteId, tagId) {
      const hlc = await membershipHlc(noteId, tagId)
      await storage.putNoteTag({ noteId, tagId, present: true, hlc })
    },

    async ensure(name) {
      const clean = cleanName(name)
      let tag = (await listTags()).find((t) => sameName(t.name, clean))
      if (!tag) {
        const at = now()
        tag = {
          id: newId(),
          name: clean,
          nameHlc: clock.tick(),
          createdAt: at,
          updatedAt: at,
          deletedAt: null,
          deletedHlc: null,
          color: null,
          colorHlc: '',
        }
        await storage.putTag(tag)
      }
      return tag.id
    },

    async removeFromNote(noteId, tagId) {
      const hlc = await membershipHlc(noteId, tagId)
      await storage.putNoteTag({ noteId, tagId, present: false, hlc })
    },

    async rename(id, name) {
      const clean = cleanName(name)
      const all = await listTags()
      const tag = all.find((t) => t.id === id)
      if (!tag) throw new Error('E_TAG_NOT_FOUND')
      // Names stay unique: a tag found by name must be the only one.
      if (all.some((t) => t.id !== id && sameName(t.name, clean))) {
        throw new Error('E_TAG_NAME_TAKEN')
      }
      await write({ ...tag, name: clean, nameHlc: clock.tick() })
    },

    async setColor(id, color) {
      if (color !== null && !isTagColor(color)) throw new Error('E_TAG_COLOR_INVALID')
      const tag = await find(id)
      await write({ ...tag, color, colorHlc: clock.tick() })
    },

    async remove(id) {
      const tag = await find(id)
      await write({ ...tag, deletedAt: now(), deletedHlc: clock.tick() })
    },
  }
  return service
}

/** One list filter next to the notebook: a status, a tag, or pinned notes. */
export type NoteFilter =
  | { kind: 'status'; status: NoteStatus }
  | { kind: 'tag'; tagId: string }
  | { kind: 'pinned' }

/** The notes in a notebook (null: all notes) that match the filter, if any. */
export function filterNotes<T extends NoteSummary>(
  notes: readonly T[],
  books: readonly BookRecord[],
  options: { bookId: string | null; by: NoteFilter | null },
): T[] {
  const inBook = options.bookId === null ? [...notes] : notesInBook(notes, books, options.bookId)
  const by = options.by
  if (!by) return inBook
  return inBook.filter((n) =>
    by.kind === 'status'
      ? n.status === by.status
      : by.kind === 'tag'
        ? n.tagIds.includes(by.tagId)
        : n.pinned,
  )
}

export function statusCounts(notes: readonly NoteSummary[]): Map<NoteStatus, number> {
  const counts = new Map<NoteStatus, number>()
  for (const n of notes) counts.set(n.status, (counts.get(n.status) ?? 0) + 1)
  return counts
}

export function tagCounts(notes: readonly NoteSummary[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const n of notes) for (const t of n.tagIds) counts.set(t, (counts.get(t) ?? 0) + 1)
  return counts
}

/** Pinned notes first, as their own group; each group keeps the list order. */
export function noteGroups<T extends Pick<NoteSummary, 'pinned'>>(notes: readonly T[]) {
  return { pinned: notes.filter((n) => n.pinned), others: notes.filter((n) => !n.pinned) }
}
