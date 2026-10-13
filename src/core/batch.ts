// Batch changes: one change applied to several notes at once (the note
// list's multiple selection). Each note gets its own write through the note
// and tag services, so each carries its own HLC and its own history event,
// exactly as if it had been changed alone; nothing is written as one SQL
// update. A note that fails (it went away meanwhile, its write failed) does
// not stop the rest: the result says which notes changed and which did not.

import { errorCode } from './errors'
import type { NoteService } from './notes'
import { NOTE_STATUSES, type NoteStatus } from './storage'
import type { TagService } from './tags'

export type BatchChange =
  | { kind: 'book'; bookId: string | null }
  | { kind: 'status'; status: NoteStatus }
  | { kind: 'pinned'; pinned: boolean }
  /** Puts the tag with this name on each note (made once when missing): a name typed. */
  | { kind: 'addTag'; name: string }
  /** Puts this tag on each note: a tag picked (dropped on, chosen in a list). */
  | { kind: 'putTag'; tagId: string }
  | { kind: 'removeTag'; tagId: string }
  | { kind: 'trash' }
  /** Notes in the Trash: back where they were. */
  | { kind: 'restore' }
  /** Notes in the Trash: deleted permanently. */
  | { kind: 'purge' }

export interface BatchResult {
  /** The notes changed, in the order given. */
  changed: string[]
  /** The notes not changed, with the error code of each. */
  failed: { id: string; code: string }[]
}

export interface BatchServices {
  notes: NoteService
  tags: TagService
}

const BATCH_KINDS: ReadonlySet<string> = new Set([
  'book',
  'status',
  'pinned',
  'addTag',
  'putTag',
  'removeTag',
  'trash',
  'restore',
  'purge',
])

/**
 * Applies `change` to each note in `ids` (each once, in order), one note at
 * a time. A change that is invalid for every note (an unknown kind or
 * status, a notebook that is not live, a tag name that cannot be one, a tag
 * ID that names no live tag) is refused before any note changes; the
 * notebook is checked and a tag added by name is found or made once, up
 * front.
 */
export async function applyBatch(
  services: BatchServices,
  ids: readonly string[],
  change: BatchChange,
): Promise<BatchResult> {
  if (!BATCH_KINDS.has(change.kind)) throw new Error('E_BATCH_INVALID')
  if (change.kind === 'status' && !NOTE_STATUSES.includes(change.status)) {
    throw new Error('E_NOTE_STATUS_INVALID')
  }
  const { notes, tags } = services
  const unique = [...new Set(ids)]
  let tagId: string | undefined
  if (change.kind === 'book' && unique.length > 0) await notes.checkBook(change.bookId)
  if (change.kind === 'addTag' && unique.length > 0) tagId = await tags.ensure(change.name)
  if (change.kind === 'putTag') {
    if (!(await tags.list()).some((tag) => tag.id === change.tagId)) {
      throw new Error('E_TAG_NOT_FOUND')
    }
    tagId = change.tagId
  }
  /** One note's change, written before the next note's starts. */
  const one = async (id: string) => {
    switch (change.kind) {
      case 'book':
        return notes.writeMeta(id, { bookId: change.bookId }, { bookChecked: true })
      case 'status':
        return notes.writeMeta(id, { status: change.status })
      case 'pinned':
        return notes.writeMeta(id, { pinned: change.pinned })
      case 'addTag':
      case 'putTag':
        // Only a live note takes a tag.
        await notes.read(id)
        return tags.putOnNote(id, tagId!)
      case 'removeTag':
        await notes.read(id)
        return tags.removeFromNote(id, change.tagId)
      case 'trash':
        return notes.trash(id)
      case 'restore':
        return notes.restore(id)
      case 'purge':
        return notes.purge(id)
    }
  }
  const result: BatchResult = { changed: [], failed: [] }
  for (const id of unique) {
    try {
      await one(id)
      result.changed.push(id)
    } catch (error) {
      result.failed.push({ id, code: errorCode(error, 'E_BATCH_NOTE') })
    }
  }
  return result
}
