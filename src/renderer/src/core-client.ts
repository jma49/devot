import * as Comlink from 'comlink'
import type { SaveProblem, StorageAdapter, TakenIn } from '../../core'
import { newNodeId } from '../../core/hlc'
import { connectCore, type Core } from './coreConnect'
import { reportCode } from './crash'
import { invoke } from './ipc'
import type { LogEntry } from './log'
import { reportingWrites } from './mainWindows'
import { reportingNoteWrites } from './noteWrites'
import type { WireRelay } from './noteRelayWire'
import { memoryStorage } from './storage/memory'
import { tauriStorage, tauriWire } from './storage/tauri'
import { toWire, type WireStorage } from './storage/wire'

export type { Core } from './coreConnect'

/**
 * The storage this window uses: Tauri's, or in the UI tests' build alone
 * the in-memory one, which every build of the app leaves out.
 */
export const storage: StorageAdapter = DEVOT_UI_TEST ? memoryStorage : tauriStorage

const wire: WireStorage = DEVOT_UI_TEST ? toWire(memoryStorage) : tauriWire

const workers = new WeakMap<Core, Worker>()

export function stopCore(core: Core) {
  workers.get(core)?.terminate()
}

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
 * `windowed` carries what the core says to the other windows and takes in
 * from them (noteRelay.ts); a lean core, a note window's or a second main
 * window's, does less (see init). `onWrote` hears of each write to the library,
 * for the other main windows' lists (mainWindows.ts).
 */
export async function startCore(
  onSaveProblems: (problems: SaveProblem[]) => void,
  onNoteWrites: (writes: ReadonlyMap<string, number>) => void = () => {},
  onFailure: (code: string) => void = () => {},
  windowed: {
    lean?: boolean
    onWrote?: () => void
    onRelay?: (message: WireRelay) => void
    onTakenIn?: (change: TakenIn) => void
  } = {},
): Promise<Core> {
  const worker = new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module' })
  const core = await connectCore(worker, {
    // A node ID of this start's own, never kept in the web view's storage:
    // another build of the app shares that, and two processes must never
    // stamp a write alike.
    start: (c) => {
      const noted = reportingNoteWrites(wire, onNoteWrites)
      const served = windowed.onWrote ? reportingWrites(noted, windowed.onWrote) : noted
      return c.init(Comlink.proxy(served), newNodeId(), { lean: windowed.lean ?? false })
    },
    onSaveProblems,
    ...(windowed.onRelay ? { onRelay: windowed.onRelay } : {}),
    ...(windowed.onTakenIn ? { onTakenIn: windowed.onTakenIn } : {}),
    onLog: logFromWorker,
    onFailure,
  })
  workers.set(core, worker)
  return core
}
