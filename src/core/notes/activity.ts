import {
  activitySince,
  buildStrips,
  loadActivity,
  loadWriting,
  stripStart,
  systemOffset,
} from '../activity'
import { textLength } from '../revisions'
import { MAX_BODY_IDS, type ActivityRevision } from '../storage'
import { BODY } from './body'
import type { NoteContext } from './context'
import type { Kernel } from './kernel'
import type { NoteService } from './types'

export function activityMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<NoteService, 'activity' | 'writing' | 'noteActivity'> {
  const { storage, live } = ctx
  const { takeVersion, settled } = k.versions
  const { saveAll } = k.saving
  return {
    async activity(day, offsetAt) {
      await saveAll()
      for (const note of live.values()) takeVersion(note)
      await settled()
      return loadActivity(storage, day, offsetAt)
    },

    async writing(day, offsetAt) {
      await saveAll()
      for (const note of live.values()) takeVersion(note)
      await settled()
      return loadWriting(storage, day, offsetAt)
    },

    async noteActivity(ids, at, offsetAt = systemOffset) {
      const since = activitySince(stripStart(at, offsetAt))
      const revisions: ActivityRevision[] = []
      for (let from = 0; from < ids.length; from += MAX_BODY_IDS) {
        revisions.push(
          ...(await storage.listNoteActivity(ids.slice(from, from + MAX_BODY_IDS), since)),
        )
      }
      const pending = new Map<string, number>()
      for (const id of ids) {
        const note = live.get(id)
        if (!note?.rev.pending || note.rev.lastText === undefined) continue
        const length = textLength(note.doc.getText(BODY).toString())
        pending.set(id, Math.abs(length - textLength(note.rev.lastText)))
      }
      return buildStrips(ids, revisions, at, offsetAt, pending)
    },
  }
}
