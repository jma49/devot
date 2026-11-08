import * as Y from 'yjs'
import { errorCode } from '../errors'
import { formatHlc, parseHlc, receiveStored } from '../hlc'
import { clipTitle } from '../noteLimits'
import type { NoteRelayMessage, TakenIn } from '../noteRelay'
import type { NoteRecord } from '../storage'
import type { Live, NoteContext } from './context'
import type { Kernel } from './kernel'
import { holdsMore, withNewer } from './records'
import type { NoteService } from './types'

/** How long a note another window changed stays watched for a stored write to relay (see relayStored). */
const HEARD_QUIET_MS = 10 * 60_000

/** The origin of a change another window's core relayed, which is not relayed again. */
const RELAYED = Symbol('relayed')

/** What this core tells the app's other windows, and the changes it takes in from them or from storage. */
export function createRelay(ctx: NoteContext) {
  const { options } = ctx
  const relay = (message: NoteRelayMessage) => {
    try {
      options.relay?.(message)
    } catch {
      console.warn('W_NOTE_RELAY_FAILED', message.noteId)
    }
  }

  const relayChanges = (id: string, doc: Y.Doc) => {
    if (!options.relay) return
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== RELAYED) relay({ kind: 'update', noteId: id, data: update })
    })
  }

  const tell = (change: TakenIn) => {
    try {
      options.onTakenIn?.(change)
    } catch {
      console.warn('W_NOTE_RELAY_FAILED', change.noteId)
    }
  }

  /** Applies a change this core did not make and tells the window what it changed; whether it changed anything. */
  const takeOutside = (note: Live, update: Uint8Array, origin?: typeof RELAYED): boolean => {
    const taken: Uint8Array[] = []
    const collect = (change: Uint8Array) => taken.push(change)
    note.doc.on('update', collect)
    try {
      Y.applyUpdate(note.doc, update, origin)
    } finally {
      note.doc.off('update', collect)
    }
    if (taken.length === 0) return false
    const noteId = note.record.id
    tell({
      kind: 'update',
      noteId,
      update: taken.length === 1 ? taken[0]! : Y.mergeUpdates(taken),
    })
    return true
  }

  /**
   * Merges the stored copy in: a Yjs merge, and the newer HLC of each metadata field.
   * Returns whether storage now lacks part of the document, which the next save then writes whole.
   */
  const takeIn = (note: Live, stored: NoteRecord): boolean => {
    const title = note.record.title
    note.record = {
      ...withNewer(note.record, stored),
      bodyVersion: stored.bodyVersion,
    }
    note.saved = {
      ...withNewer(note.saved, stored),
      bodyVersion: stored.bodyVersion,
    }
    takeOutside(note, stored.ydoc)
    // After the merge the document holds all of the stored copy, so either they match or storage falls short.
    const short = holdsMore(note.doc, stored)
    note.storedChanges = short ? -1 : note.changes
    if (note.record.title !== title) {
      const { id, title: taken, titleHlc } = note.record
      tell({ kind: 'title', noteId: id, title: taken })
      relay({ kind: 'title', noteId: id, title: taken, hlc: titleHlc })
    }
    return short
  }

  return { relay, relayChanges, tell, takeOutside, takeIn }
}

export function relayMethods(
  ctx: NoteContext,
  k: Kernel,
): Pick<NoteService, 'mergeStored' | 'receive'> {
  const { clock, now, live, heard } = ctx
  const { relay, tell, takeOutside, takeIn } = k.relay
  const { getStored, drop, inMemory, summaries } = k.memory
  const { exclusive, schedule } = k.saving
  // Empty when the versions cannot be read, so every note is read whole.
  const storedVersions = async (ids: readonly string[]) => {
    const listed = await summaries(ids).catch((e: unknown) => {
      console.warn('W_NOTE_MERGE_FAILED', errorCode(e))
      return []
    })
    return new Map(listed.map((n) => [n.id, n.bodyVersion]))
  }
  /** The stored state of the notes another window may hold and this core does not, when a write moved it since it was last relayed: the core holding the note is the one that takes it in. */
  const relayStored = async () => {
    const at = now()
    // Body versions are cheap: no note's Yjs state is read until its version moves.
    let versions: Map<string, number> | undefined
    const versionOf = async (id: string) => {
      versions ??= await storedVersions([...heard.keys()])
      return versions.get(id)
    }
    for (const [id, last] of heard) {
      // Quiet for a while: the window that changed it is not waiting on anything here.
      if (at - last.at > HEARD_QUIET_MS) {
        heard.delete(id)
        continue
      }
      if (live.has(id)) continue
      const version = await versionOf(id)
      if (version !== undefined && version === last.version) continue
      const stored = await getStored(id, { trashed: true }).catch((e: unknown) => {
        console.warn('W_NOTE_MERGE_FAILED', errorCode(e))
        return undefined
      })
      if (stored === null) heard.delete(id)
      if (!stored) continue
      const seen = `${stored.bodyVersion} ${stored.titleHlc}`
      // A trashed note is not in the list: it is read each time, until it is quiet.
      last.version = stored.bodyVersion
      if (seen === last.seen) continue
      last.seen = seen
      relay({ kind: 'update', noteId: id, data: stored.ydoc })
      relay({
        kind: 'title',
        noteId: id,
        title: clipTitle(stored.title),
        hlc: stored.titleHlc,
      })
    }
  }

  return {
    async mergeStored() {
      const retitled: { id: string; title: string }[] = []
      const unchanged: string[] = []
      const held = [...live.values()]
      const versions = await storedVersions(held.map((note) => note.record.id))
      // After any write of the note under way, so none lands in between.
      const merge = (note: Live) =>
        exclusive(note, async () => {
          const { id } = note.record
          if (live.get(id) !== note) return
          // Every write moves the stored body version: one that has not moved since this core read or wrote the note holds nothing new.
          if (versions.get(id) === note.record.bodyVersion) {
            if (note.retitled) retitled.push({ id, title: note.record.title })
            note.retitled = false
            unchanged.push(id)
            return
          }
          const stored = await getStored(id, { trashed: true })
          if (live.get(id) !== note) return
          if (!stored) {
            drop(note, 'purged')
            return
          }
          const title = note.record.title
          // Storage lacks part of the document: the save this schedules writes it whole.
          if (takeIn(note, stored)) {
            note.edits += 1
            schedule(note)
          }
          if (note.record.title !== title || note.retitled) {
            retitled.push({ id, title: note.record.title })
          }
          note.retitled = false
        })
      const merged = await Promise.allSettled(held.map(merge))
      for (const result of merged) {
        if (result.status === 'rejected') {
          console.warn('W_NOTE_MERGE_FAILED', errorCode(result.reason))
        }
      }
      await relayStored()
      return { retitled, unchanged }
    },

    async receive(message) {
      const { noteId: id } = message
      // The window may hold the note: its stored state is relayed when that write moves.
      const last = heard.get(id)
      if (last) last.at = now()
      else heard.set(id, { seen: undefined, version: undefined, at: now() })
      // The note window turns read-only on a `gone` itself (NoteWindow.tsx): nothing to take in here.
      if (message.kind === 'saved' || message.kind === 'gone') return
      const note = await inMemory(id)
      if (!note) return
      try {
        if (message.kind === 'want') {
          relay({
            kind: 'update',
            noteId: id,
            data: Y.encodeStateAsUpdate(note.doc, message.data),
          })
        } else if (message.kind === 'update') {
          // The window that made the change keeps the text from before it (see keepBaseline).
          if (takeOutside(note, message.data, RELAYED)) note.rev.checked = true
        } else if (formatHlc(parseHlc(message.hlc)) > note.record.titleHlc) {
          receiveStored(clock, [message.hlc])
          const title = clipTitle(message.title)
          const titled = { title, titleHlc: message.hlc }
          note.record = { ...note.record, ...titled }
          note.saved = { ...note.saved, ...titled }
          tell({ kind: 'title', noteId: id, title })
        }
      } catch {
        console.warn('W_NOTE_RELAY_INVALID', id)
      }
    },
  }
}
