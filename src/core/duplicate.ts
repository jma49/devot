// Duplicate: a copy of a note that is the note's own, not a bare clone. The
// rule: the copy has the original's body, notebook, status and tags, and the
// title "<title> copy" (an untitled note's copy stays untitled, since its
// list row shows its first line). It is not pinned: a pin is a place in the
// list, and two pinned twins would crowd it.

import { errorCode } from './errors'
import type { NoteService } from './notes'
import type { TagService } from './tags'

export interface DuplicateServices {
  notes: NoteService
  tags: TagService
}

/**
 * Copies the note `id` (see NoteService.duplicate) and puts `tagIds`, the
 * tags the note has, on the copy. A tag that cannot be put on it (it was
 * deleted meanwhile) is left off and logged by code; the copy is still made.
 * Resolves to the copy's ID.
 */
export async function duplicateNote(
  services: DuplicateServices,
  id: string,
  options: { suffix?: string; tagIds?: readonly string[] } = {},
): Promise<string> {
  const { suffix, tagIds = [] } = options
  const copy = await services.notes.duplicate(id, suffix === undefined ? undefined : { suffix })
  for (const tagId of tagIds) {
    await services.tags.putOnNote(copy, tagId).catch((e: unknown) => {
      console.warn('W_NOTE_COPY_TAG_FAILED', copy, errorCode(e))
    })
  }
  return copy
}
