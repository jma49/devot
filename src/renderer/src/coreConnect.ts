// Connects the page to a core worker: waits for the core to start, and hears
// of everything that goes wrong with the worker, so a failure is seen and
// logged instead of leaving a window that looks empty.
import * as Comlink from 'comlink'
import type { SaveProblem } from '../../core'
import { errorCode } from '../../core/errors'
import type { CoreApi } from './core.worker'
import type { LogEntry } from './log'
import { saveProblemsIn } from './saving'
import { workerLogIn } from './workerLog'

export type Core = Comlink.Remote<CoreApi>

export const START_TIMEOUT_MS = 30_000

export const WORKER_FAILED = 'E_CORE_WORKER_FAILED'

export interface CoreWorker extends EventTarget {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
}

export interface CoreConnection {
  start: (core: Core) => Promise<unknown>
  onSaveProblems: (problems: SaveProblem[]) => void
  onLog: (entry: LogEntry) => void
  onFailure: (code: string) => void
  timeoutMs?: number
  wrap?: (worker: CoreWorker) => Core
}

/**
 * Resolves with the core once `start` has finished. Rejects, with a code, when
 * the worker fails to load or raises an error before then (`E_CORE_WORKER_FAILED`),
 * when `start` fails (its own code), or when it takes longer than the timeout
 * (`E_CORE_START_TIMEOUT`); the worker is stopped then. A failure after the
 * start goes to `onFailure`: the worker is kept, since a note's unsaved changes
 * may be in it.
 */
export function connectCore(worker: CoreWorker, connection: CoreConnection): Promise<Core> {
  const { timeoutMs = START_TIMEOUT_MS, wrap = (w) => Comlink.wrap<CoreApi>(w as never) } =
    connection
  return new Promise<Core>((resolve, reject) => {
    let state: 'starting' | 'running' | 'failed' = 'starting'
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (code: string) => {
      if (state === 'running') return connection.onFailure(code)
      if (state === 'failed') return
      state = 'failed'
      clearTimeout(timer)
      worker.terminate()
      reject(new Error(code))
    }
    worker.addEventListener('message', (event) => {
      const data = (event as MessageEvent<unknown>).data
      const problems = saveProblemsIn(data)
      if (problems) connection.onSaveProblems(problems)
      const entry = workerLogIn(data)
      if (entry) connection.onLog(entry)
    })
    // An error event carries the message of the failure, which may quote
    // content: only the fact of it is kept.
    worker.addEventListener('error', () => fail(WORKER_FAILED))
    worker.addEventListener('messageerror', () => fail(WORKER_FAILED))
    timer = setTimeout(() => fail('E_CORE_START_TIMEOUT'), timeoutMs)
    const core = wrap(worker)
    connection.start(core).then(
      () => {
        if (state !== 'starting') return
        state = 'running'
        clearTimeout(timer)
        resolve(core)
      },
      (e: unknown) => fail(errorCode(e)),
    )
  })
}
