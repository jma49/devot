// Starts the core worker and connects it to storage.
import * as Comlink from 'comlink'
import type { SaveProblem, StorageAdapter } from '../../core'
import { newNodeId } from '../../core/hlc'
import type { CoreApi } from './core.worker'
import { saveProblemsIn } from './saving'
import { reportingNoteWrites } from './noteWrites'
import { memoryStorage } from './storage/memory'
import { tauriStorage, tauriWire } from './storage/tauri'
import { toWire, type WireStorage } from './storage/wire'

export type Core = Comlink.Remote<CoreApi>

/**
 * The storage this window uses: Tauri's, or in the UI tests' build alone
 * the in-memory one, which every build of the app leaves out.
 */
export const storage: StorageAdapter = DEVOT_UI_TEST ? memoryStorage : tauriStorage

/** The same storage as the core worker reaches it: Yjs states as base64 (see wire.ts). */
const wire: WireStorage = DEVOT_UI_TEST ? toWire(memoryStorage) : tauriWire

/**
 * Starts the core worker. `onSaveProblems` hears of every note whose changes
 * could not be saved yet, each time that list changes, before the reply of
 * the call that changed it (see SaveProblemsMessage); `onNoteWrites` hears of
 * the note writes storage completes (see reportingNoteWrites), saves included.
 */
export async function startCore(
  onSaveProblems: (problems: SaveProblem[]) => void,
  onNoteWrites: (writes: ReadonlyMap<string, number>) => void = () => {},
): Promise<Core> {
  const worker = new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    const problems = saveProblemsIn(event.data)
    if (problems) onSaveProblems(problems)
  })
  const core = Comlink.wrap<CoreApi>(worker)
  // A node ID of this start's own, never kept in the web view's storage:
  // another build of the app shares that, and two processes must never
  // stamp a write alike.
  await core.init(Comlink.proxy(reportingNoteWrites(wire, onNoteWrites)), newNodeId())
  return core
}
