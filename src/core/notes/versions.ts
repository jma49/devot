import * as Y from 'yjs'
import { errorCode } from '../errors'
import {
  BASELINE,
  COMPACT_BATCH,
  COMPACT_EVERY_MS,
  COMPACT_PAGE,
  compactionWindows,
  REVISION_EVERY_MS,
  REVISION_PAUSE_MS,
  revisionsToDrop,
  textLength,
} from '../revisions'
import type { CompactableVersion, RevisionKind } from '../storage'
import { noteCounts } from '../noteCounts'
import { BODY, bodyText } from './body'
import type { HeldRecord, Live, NoteContext } from './context'

const asBody = (version: CompactableVersion) => ({
  ...version,
  kind: 'body' as const,
})

const byNote = (versions: readonly CompactableVersion[]) => {
  const notes = new Map<string, CompactableVersion[]>()
  for (const version of versions) {
    const listed = notes.get(version.noteId)
    if (listed) listed.push(version)
    else notes.set(version.noteId, [version])
  }
  return notes
}

const eventValue = (kind: Exclude<RevisionKind, 'body'>, record: HeldRecord): string | null => {
  if (kind === 'title') return record.title
  if (kind === 'book') return record.bookId
  if (kind === 'status') return record.status
  return record.pinned ? '1' : '0'
}
const EVENT_KINDS = ['title', 'book', 'status', 'pinned'] as const

/** The versions a note service keeps of the notes in memory, and the compaction sweeps that thin them. */
export function createVersions(ctx: NoteContext) {
  const { storage, newId, now, options } = ctx
  // Revision writes and sweeps run on separate queues so no user action waits for a sweep.
  const compacting = options.compact ?? true
  let held = false
  let sweptAt: number | undefined
  let sweeping: Promise<void> = Promise.resolve()
  // Revision writes, one after another; a failure is logged and skipped.
  let revisionWork: Promise<void> = Promise.resolve()
  const enqueue = (work: () => Promise<void>) => {
    revisionWork = revisionWork.then(work).catch((e: unknown) => {
      console.warn('W_REVISION_FAILED', errorCode(e))
    })
  }

  const stopTimers = (note: Live) => {
    clearTimeout(note.rev.pause)
    clearTimeout(note.rev.every)
    note.rev.pause = undefined
    note.rev.every = undefined
    note.rev.pending = false
  }

  /** Thins old versions of notes that may have some to drop (see revisionsToDrop). Resumes where the last sweep ended (recorded in storage); an interrupted sweep is done again. */
  const compactAll = async (at: number) => {
    const stored = await storage.lastCompaction()
    // A last sweep after `at`: the clock was set back since.
    const last = stored !== null && stored <= at ? stored : undefined
    const weighed = new Set<string>()
    const drop: string[] = []
    for (const [from, to] of compactionWindows(last, at)) {
      let after = ''
      let more = from < to
      while (more) {
        const page = byNote(await storage.listCompactable(from, to, after, COMPACT_PAGE))
        for (const [noteId, versions] of page) {
          if (!weighed.has(noteId)) drop.push(...revisionsToDrop(versions.map(asBody), at))
          weighed.add(noteId)
          after = noteId
        }
        more = page.size === COMPACT_PAGE
        while (drop.length >= COMPACT_BATCH) {
          await storage.compactRevisions(drop.splice(0, COMPACT_BATCH), null)
        }
      }
    }
    await storage.compactRevisions(drop, at)
  }

  /** After a save, at most once per COMPACT_EVERY_MS, on its own queue (see compactAll). */
  const sweep = () => {
    if (!compacting || held) return
    const at = now()
    if (sweptAt !== undefined && at - sweptAt < COMPACT_EVERY_MS) return
    sweptAt = at
    sweeping = sweeping
      .then(() => compactAll(at))
      .catch((e: unknown) => console.warn('W_REVISION_COMPACT_FAILED', errorCode(e)))
  }

  const takeVersion = (note: Live, value: string | null = null) => {
    if (!note.rev.pending) return
    stopTimers(note)
    const { id } = note.record
    const text = note.doc.getText(BODY).toString()
    const ydoc = Y.encodeStateAsUpdate(note.doc)
    const at = now()
    enqueue(async () => {
      if (text === note.rev.lastText) return
      await storage.putRevision({
        id: newId(),
        noteId: id,
        kind: 'body',
        at,
        ydoc,
        length: textLength(text),
        value,
        words: noteCounts(text).words,
      })
      note.rev.lastText = text
    })
  }

  /** Keeps the text from before this session's first change when the history does not end with it: a note's baseline (see BASELINE), or typing a version missed (a crash). */
  const keepBaseline = (
    id: string,
    before: { ydoc: Uint8Array; text: string; at: number },
    rev?: Live['rev'],
  ) => {
    enqueue(async () => {
      const latest = (await storage.listRevisions(id)).find((r) => r.kind === 'body')
      let same = latest === undefined && before.text === ''
      if (latest && latest.length === textLength(before.text)) {
        const stored = await storage.getRevision(latest.id)
        same = stored?.ydoc != null && bodyText(stored.ydoc) === before.text
      }
      if (!same) {
        await storage.putRevision({
          id: newId(),
          noteId: id,
          kind: 'body',
          at: before.at,
          ydoc: before.ydoc,
          length: textLength(before.text),
          value: latest === undefined ? BASELINE : null,
          words: noteCounts(before.text).words,
        })
      }
      // A version taken meanwhile is newer.
      if (rev) rev.lastText ??= before.text
    })
  }

  /** Body as stored before this session's first change; undefined once kept. */
  const unchecked = (note: Live) =>
    note.rev.checked
      ? undefined
      : {
          ydoc: Y.encodeStateAsUpdate(note.doc),
          text: note.doc.getText(BODY).toString(),
          at: note.saved.updatedAt,
        }

  /** The first change this session keeps the text it replaces (see keepBaseline). */
  const editBody = (note: Live, change: () => void): boolean => {
    const before = unchecked(note)
    let changed = false
    const seen = () => (changed = true)
    note.doc.on('update', seen)
    try {
      change()
    } finally {
      note.doc.off('update', seen)
    }
    if (!changed) return false
    note.edits += 1
    if (before) {
      note.rev.checked = true
      keepBaseline(note.record.id, before, note.rev)
    }
    if (!note.rev.pending) {
      note.rev.pending = true
      note.rev.every = setTimeout(() => takeVersion(note), REVISION_EVERY_MS)
    }
    clearTimeout(note.rev.pause)
    note.rev.pause = setTimeout(() => takeVersion(note), REVISION_PAUSE_MS)
    return true
  }

  const recordEvents = (rev: Live['rev'] | undefined, before: HeldRecord, after: HeldRecord) => {
    const at = now()
    for (const kind of EVENT_KINDS) {
      const value = eventValue(kind, after)
      if (eventValue(kind, before) === value) continue
      let id = newId()
      const noteId = after.id
      if (kind === 'title' && rev) {
        // Typing a title saves every few keys: one event per burst, and
        // none when the burst ends where it started.
        const last = rev.title
        const burst = last && at - last.at < REVISION_PAUSE_MS ? last : undefined
        const from = burst?.from ?? before.title
        if (burst) id = burst.id
        rev.title = { id, at, from }
        if (value === from) {
          enqueue(() => storage.deleteRevisions(noteId, [id]))
          continue
        }
      }
      enqueue(() =>
        storage.putRevision({
          id,
          noteId,
          kind,
          at,
          ydoc: null,
          length: null,
          value,
          words: null,
        }),
      )
    }
  }

  return {
    stopTimers,
    sweep,
    takeVersion,
    keepBaseline,
    unchecked,
    editBody,
    recordEvents,
    /** Resolves once the revision writes asked for so far are done. */
    settled: () => revisionWork,
    async holdCompaction() {
      held = true
      await sweeping
    },
    resumeCompaction() {
      held = false
    },
  }
}
