// The core worker has a console and uncaught errors of its own, which the
// page's forwarding (log.ts) does not see: a failed autosave, a revision that
// could not be written, a rejected promise in the core would go nowhere. The
// worker posts each coded entry to the page, which writes it to the local
// log (and reports an uncaught error to Sentry). Only codes and IDs cross,
// as in log.ts.
import {
  forwardConsole,
  forwardUncaught,
  sanitizeEntry,
  type LogEntry,
  type UncaughtSource,
} from './log'

/** What the worker posts for each entry, on its own channel (like SaveProblemsMessage). */
export interface WorkerLogMessage {
  workerLog: LogEntry
}

/** The codes uncaught errors in the worker are logged under. */
export const WORKER_CODES = {
  uncaught: 'E_WORKER_UNCAUGHT',
  rejection: 'E_WORKER_UNHANDLED_REJECTION',
} as const

/** Wraps the worker's console and listens for its uncaught errors, posting what is coded. */
export function forwardWorkerLogs(
  scope: UncaughtSource & { console: Parameters<typeof forwardConsole>[0] },
  post: (message: WorkerLogMessage) => void,
) {
  const send = (workerLog: LogEntry) => {
    post({ workerLog })
    return Promise.resolve()
  }
  forwardConsole(scope.console, send)
  forwardUncaught(scope, send, WORKER_CODES)
}

/** The entry a message from the core worker carries; undefined for any other message. */
export function workerLogIn(data: unknown): LogEntry | undefined {
  if (typeof data !== 'object' || data === null || !('workerLog' in data)) return undefined
  return sanitizeEntry(data.workerLog)
}
