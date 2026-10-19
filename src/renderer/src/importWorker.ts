// An import converts and parses each file in a worker of its own (import.worker.ts), so the core
// worker stays free for the saves queued meanwhile however long a large page takes (#290). A
// worker that cannot start, or fails, hands its files back to the core worker.
import type { ImportPreparer } from '../../core'

export type ImportRequest =
  | { id: number; kind: 'file'; raw: string; path: string; withImages: boolean }
  | { id: number; kind: 'links'; text: string }

export type ImportReply = { id: number; value: unknown } | { id: number; code: string }

type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never

export interface ImportWorker {
  postMessage(message: ImportRequest): void
  addEventListener(type: 'message', listener: (event: { data: ImportReply }) => void): void
  addEventListener(type: 'error' | 'messageerror', listener: () => void): void
  terminate(): void
}

export interface ClosingPreparer extends ImportPreparer {
  /** Ends the worker; a call still waiting runs here instead. */
  close(): void
}

interface Waiting {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  here: () => Promise<unknown>
}

export function preparerOffThread(
  spawn: () => ImportWorker,
  here: ImportPreparer,
  onFailure: () => void,
): ClosingPreparer {
  let worker: ImportWorker | undefined
  let usable = true
  let next = 0
  const waiting = new Map<number, Waiting>()

  const stop = () => {
    usable = false
    worker?.terminate()
    worker = undefined
    const calls = [...waiting.values()]
    waiting.clear()
    for (const call of calls) call.here().then(call.resolve, call.reject)
  }
  const fail = () => {
    if (!usable) return
    onFailure()
    stop()
  }
  const started = (): ImportWorker | undefined => {
    if (!usable) return undefined
    if (worker) return worker
    try {
      worker = spawn()
    } catch {
      fail()
      return undefined
    }
    worker.addEventListener('message', ({ data }) => {
      const call = waiting.get(data.id)
      if (!call) return
      waiting.delete(data.id)
      if ('code' in data) call.reject(new Error(data.code))
      else call.resolve(data.value)
    })
    worker.addEventListener('error', fail)
    worker.addEventListener('messageerror', fail)
    return worker
  }
  const call = <T>(request: Unsent<ImportRequest>, local: () => Promise<T>): Promise<T> => {
    const target = started()
    if (!target) return local()
    const id = (next += 1)
    return new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: (value) => resolve(value as T), reject, here: local })
      target.postMessage({ ...request, id })
    })
  }

  return {
    file: (raw, path, withImages) =>
      call({ kind: 'file', raw, path, withImages }, () => here.file(raw, path, withImages)),
    links: (text) => call({ kind: 'links', text }, () => here.links(text)),
    close: stop,
  }
}
