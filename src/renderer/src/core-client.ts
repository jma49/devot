// Starts the core worker and connects it to storage.
import * as Comlink from 'comlink'
import type { SaveProblem, StorageAdapter } from '../../core'
import { newNodeId } from '../../core/hlc'
import { connectCore, type Core } from './coreConnect'
import { reportCode } from './crash'
import { invoke } from './ipc'
import type { LogEntry } from './log'
import { reportingNoteWrites } from './noteWrites'
import { memoryStorage } from './storage/memory'
import { tauriStorage, tauriWire } from './storage/tauri'
import { toWire, type WireStorage } from './storage/wire'

export type { Core } from './coreConnect'

/**
 * The storage this window uses: Tauri's, or in the UI tests' build alone
 * the in-memory one, which every build of the app leaves out.
 */
export const storage: StorageAdapter = DEVOT_UI_TEST ? memoryStorage : tauriStorage

/** The same storage as the core worker reaches it: Yjs states as base64 (see wire.ts). */
const wire: WireStorage = DEVOT_UI_TEST ? toWire(memoryStorage) : tauriWire

/** The workers in use, so a core that failed to start can be stopped (see `stopCore`). */
const workers = new WeakMap<Core, Worker>()

/** Stops the worker behind `core`. */
export function stopCore(core: Core) {
  workers.get(core)?.terminate()
}

/** A coded entry from the worker goes to the local log; an error also to crash reports. */
function logFromWorker(entry: LogEntry) {
  void invoke('log_write', { ...entry }).catch(() => {})
  if (entry.level === 'error') reportCode(entry.code)
}

/**
 * Starts the core worker. `onSaveProblems` hears of every note whose changes
 * could not be saved yet, each time that list changes, before the reply of
 * the call that changed it (see SaveProblemsMessage); `onNoteWrites` hears of
 * the note writes storage completes (see reportingNoteWrites), saves included.
 * Rejects with a code when the worker does not load or the core does not
 * start (see connectCore); `onFailure` hears of a worker that fails later.
 */
export async function startCore(
  onSaveProblems: (problems: SaveProblem[]) => void,
  onNoteWrites: (writes: ReadonlyMap<string, number>) => void = () => {},
  onFailure: (code: string) => void = () => {},
): Promise<Core> {
  const worker = new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module' })
  const core = await connectCore(worker, {
    // A node ID of this start's own, never kept in the web view's storage:
    // another build of the app shares that, and two processes must never
    // stamp a write alike.
    start: (c) => c.init(Comlink.proxy(reportingNoteWrites(wire, onNoteWrites)), newNodeId()),
    onSaveProblems,
    onLog: logFromWorker,
    onFailure,
  })
  workers.set(core, worker)
  return core
}
