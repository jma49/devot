// Bring Back Outside Edits: a mirror file changed by another app goes back into its note when the note has not changed in
// Devot since the file was written. A note changed on both sides keeps Devot's version and the file is kept aside, as before.
//
// A file reads back as import reads it (Devot's block for the title, tags and status; else the first heading or the file
// name), and its links to the mirror's attachments become attachment links again, so a file Devot wrote reads back as
// the very note it was written from.

import { errorCode } from './errors'
import { fileUri } from './files'
import { prepareImportFile, resolveImagePath } from './import'
import { splitImageSize, withImageSize } from './images'
import type { DiskState, MirrorManifest } from './mirror'
import { MAX_BODY_BYTES, overBytes } from './noteLimits'
import type { NoteService } from './notes'
import { MAX_BODY_IDS, type NoteStatus, type NoteSummary, type StorageAdapter } from './storage'
import { sameName, type TagService } from './tags'
import { replaceRanges, type TextEdit } from './text'

export interface MirrorFileNote {
  title: string
  bodyMd: string
  tags: string[]
  status: NoteStatus
}

/** `attachments`: each attachment file's path in the folder (`attachments/board.png`) and its ID. */
export function readMirrorFile(
  text: string,
  path: string,
  attachments: ReadonlyMap<string, string>,
): MirrorFileNote {
  const file = prepareImportFile(text, path)
  const edits: TextEdit[] = file.images.links.flatMap((link) => {
    const at = resolveImagePath(path, link.url)
    const id = at === null ? undefined : attachments.get(at)
    if (id === undefined) return []
    return [
      {
        start: link.start,
        end: link.end,
        text: withImageSize(fileUri(id), splitImageSize(link.url).size),
      },
    ]
  })
  return {
    title: file.title,
    bodyMd: replaceRanges(file.text, edits),
    tags: [...new Set(file.meta.tags)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    status: file.meta.status ?? 'none',
  }
}

export const attachmentPaths = (manifest: MirrorManifest): Map<string, string> =>
  new Map(Object.entries(manifest.files).map(([id, entry]) => [entry.path, id]))

const isFile = (state: DiskState | undefined): state is string =>
  typeof state === 'string' && state !== 'dir' && state !== 'other'

/**
 * The notes whose file now holds something else than Devot wrote while the note itself is as it was then (`unchanged`
 * compares the note with what its manifest entry was written from). `changed` is what a full check found: each manifest
 * path whose file does not hold what the manifest says.
 */
export function readBackCandidates(
  manifest: MirrorManifest,
  changed: ReadonlyMap<string, DiskState>,
  unchanged: (id: string) => boolean,
): string[] {
  return Object.entries(manifest.notes).flatMap(([id, entry]) => {
    const state = changed.get(entry.path)
    return isFile(state) && state !== entry.sha256 && unchanged(id) ? [id] : []
  })
}

export interface MirrorTakeBack extends MirrorFileNote {
  id: string
  /** The note as the pass saw it: a note that has changed since is not written. */
  updatedAt: number
  bodyVersion: number
}

/** `taken`: the note now holds the file; `changed`: the note changed meanwhile and was left as it is. */
export type MirrorTakenBack =
  | { id: string; outcome: 'taken' | 'changed' }
  | { id: string; code: string }

export const tooLargeToReadBack = (text: string) => overBytes(text, MAX_BODY_BYTES)

export interface MirrorTakeBackOptions {
  /** A note service of its own: what it writes reaches the notes the window holds as a change from outside. */
  notes: Pick<NoteService, 'read' | 'setBodyFrom' | 'setTitle' | 'setStatus' | 'release'>
  tags: Pick<TagService, 'list' | 'addToNote' | 'removeFromNote'>
  storage: Pick<StorageAdapter, 'getSummaries'>
  /** Runs first: the window's unsaved edits are saved, so a note being typed in counts as changed. */
  before?: () => Promise<void>
  /** The notes written, once they are saved. */
  after?: (ids: readonly string[]) => void
}

export function createMirrorTakeBack(
  options: MirrorTakeBackOptions,
): (changes: readonly MirrorTakeBack[]) => Promise<MirrorTakenBack[]> {
  const { notes, tags, storage } = options
  return async (changes) => {
    await options.before?.()
    const ids = changes.map((change) => change.id)
    const summaries = new Map<string, NoteSummary>()
    for (let i = 0; i < ids.length; i += MAX_BODY_IDS) {
      for (const s of await storage.getSummaries(ids.slice(i, i + MAX_BODY_IDS)))
        summaries.set(s.id, s)
    }
    const names = new Map((await tags.list()).map((t) => [t.id, t.name]))
    const outcomes: MirrorTakenBack[] = []
    const taken: string[] = []
    for (const change of changes) {
      const { id } = change
      const now = summaries.get(id)
      if (!now || now.updatedAt !== change.updatedAt || now.bodyVersion !== change.bodyVersion) {
        outcomes.push({ id, outcome: 'changed' })
        continue
      }
      try {
        const { bodyMd } = await notes.read(id)
        if (bodyMd !== change.bodyMd && !(await notes.setBodyFrom(id, bodyMd, change.bodyMd))) {
          await notes.release(id)
          outcomes.push({ id, outcome: 'changed' })
          continue
        }
        if (now.title !== change.title) await notes.setTitle(id, change.title)
        if (now.status !== change.status) await notes.setStatus(id, change.status)
        for (const tagId of now.tagIds) {
          const name = names.get(tagId)
          if (name !== undefined && !change.tags.some((wanted) => sameName(wanted, name))) {
            await tags.removeFromNote(id, tagId)
          }
        }
        for (const wanted of change.tags) {
          const has = now.tagIds.some((tagId) => {
            const name = names.get(tagId)
            return name !== undefined && sameName(wanted, name)
          })
          if (!has) await tags.addToNote(id, wanted)
        }
        // Saved before the manifest takes the file as Devot's.
        await notes.release(id)
        outcomes.push({ id, outcome: 'taken' })
        taken.push(id)
      } catch (error) {
        outcomes.push({
          id,
          code: errorCode(error, 'E_MIRROR_READ_BACK_FAILED'),
        })
        await notes.release(id).catch(() => {})
      }
    }
    if (taken.length > 0) options.after?.(taken)
    return outcomes
  }
}
