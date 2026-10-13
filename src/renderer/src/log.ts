// UI warnings and errors reach the local log through `log_write`. Only the
// code (the first argument) and arguments that are IDs or codes are sent (of
// an error or a text that starts with a code, the code alone); anything else
// could be note content and stays in the console.
import { errorCode } from '../../core/errors'

export type LogLevel = 'error' | 'warn' | 'info'
export interface LogEntry {
  level: LogLevel
  code: string
  ids: string[]
}

const CODE = /^[EWI]_[A-Z0-9_]{1,62}$/
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MAX_IDS = 4

function asId(arg: unknown): string | undefined {
  if (typeof arg === 'string' && ID.test(arg)) return arg
  return errorCode(arg, '') || undefined
}

/** The entry for a console call, or nothing when it does not start with a code. */
export function logEntry(level: LogLevel, args: unknown[]): LogEntry | undefined {
  const [code, ...rest] = args
  if (typeof code !== 'string' || !CODE.test(code)) return undefined
  const ids = rest.map(asId).filter((id): id is string => id !== undefined)
  return { level, code, ids: ids.slice(0, MAX_IDS) }
}

type Printer = (...args: unknown[]) => void

/** Wraps `warn` and `error` so coded entries also go to `send`. */
export function forwardConsole(
  target: { warn: Printer; error: Printer },
  send: (entry: LogEntry) => Promise<unknown>,
) {
  for (const level of ['warn', 'error'] as const) {
    const print = target[level]
    target[level] = (...args: unknown[]) => {
      print(...args)
      const entry = logEntry(level, args)
      // A failed send is dropped: reporting it would loop.
      if (entry) send(entry).catch(() => {})
    }
  }
}

/** Uncaught errors are logged by kind only; their messages may hold content. */
export function forwardUncaught(
  target: Pick<Window, 'addEventListener'>,
  send: (entry: LogEntry) => Promise<unknown>,
) {
  const report = (code: string, reason: unknown) => {
    const id = asId(reason)
    send({ level: 'error', code, ids: id ? [id] : [] }).catch(() => {})
  }
  target.addEventListener('error', (e) => report('E_UI_UNCAUGHT', e.error))
  target.addEventListener('unhandledrejection', (e) => report('E_UI_UNHANDLED_REJECTION', e.reason))
}
