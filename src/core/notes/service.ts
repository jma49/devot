// Note service: owns each open note's Yjs document and persists whole records through the storage adapter.
//
// Writes of one note run one at a time, in order. A failed write keeps its changes in memory, is retried and reported (onSaveProblems).
// Every write is based on the stored body version (NoteRecord.bodyVersion); when another process wrote first, the note merges the stored copy in
// (Yjs merge, newer HLC per metadata field) and writes again (see put in saving.ts).
// Only the NOTES_IN_MEMORY most recently used notes stay loaded, and only when nothing would be lost (see trim in memory.ts).
// Writes of one note are serialised, each taken from the note as it is when it starts, so an older snapshot never lands after a newer one.
// Revision history lives in ../revisions.ts and versions.ts; compaction sweeps run on their own queue so no user action waits for them (see sweep).
// The calls are grouped by concern (creating.ts, editing.ts, meta.ts, …) over the parts in kernel.ts, which share one NoteContext (context.ts).

import { activityMethods } from './activity'
import { authorshipMethods } from './authorship'
import { createContext } from './context'
import { creatingMethods } from './creating'
import { editingMethods } from './editing'
import { historyMethods } from './history'
import { createKernel } from './kernel'
import { linkMethods } from './links'
import { metaMethods } from './meta'
import { readingMethods } from './reading'
import { relayMethods } from './relay'
import { savingMethods } from './saving'
import { searchMethods } from './search'
import { trashMethods } from './trash'
import type { NoteService, NoteServiceOptions } from './types'

export function createNoteService(options: NoteServiceOptions): NoteService {
  const ctx = createContext(options)
  const k = createKernel(ctx)
  return {
    ...creatingMethods(ctx, k),
    ...readingMethods(ctx, k),
    ...editingMethods(ctx, k),
    ...savingMethods(ctx, k),
    ...metaMethods(ctx, k),
    ...searchMethods(ctx, k),
    ...trashMethods(ctx, k),
    ...linkMethods(ctx, k),
    ...historyMethods(ctx, k),
    ...authorshipMethods(ctx, k),
    ...activityMethods(ctx, k),
    ...relayMethods(ctx, k),
  }
}
