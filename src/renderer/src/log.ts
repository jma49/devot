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

// Authorship lines also carry write IDs (64 random bits in base64url), writer kinds and counts (ADR 0007). Only they
// may: under another code, a word that looks like one could be note content.
const AUTHORSHIP_CODE = /^[IW]_AUTHORSHIP_/
const AUTHORSHIP_ARG = /^(?:[A-Za-z0-9_-]{11}|mcp|http|aiEdit|\d{1,9})$/

function asId(arg: unknown, code: string): string | undefined {
  if (typeof arg === 'string' && ID.test(arg)) return arg
  if (typeof arg === 'string' && AUTHORSHIP_CODE.test(code) && AUTHORSHIP_ARG.test(arg)) return arg
  return errorCode(arg, '') || undefined
}

const LEVELS: readonly LogLevel[] = ['error', 'warn', 'info']

/**
 * The entry a message from another context carries (the core worker), checked
 * again here: a level and a code, and of the IDs only those that are IDs or
 * codes. Anything else is not an entry.
 */
export function sanitizeEntry(value: unknown): LogEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { level, code, ids } = value as Record<string, unknown>
  if (!LEVELS.includes(level as LogLevel)) return undefined
  if (typeof code !== 'string' || !CODE.test(code)) return undefined
  const kept = Array.isArray(ids)
    ? ids.map((id) => asId(id, code)).filter((id): id is string => id !== undefined)
    : []
  return { level: level as LogLevel, code, ids: kept.slice(0, MAX_IDS) }
}

export function logEntry(level: LogLevel, args: unknown[]): LogEntry | undefined {
  const [code, ...rest] = args
  if (typeof code !== 'string' || !CODE.test(code)) return undefined
  const ids = rest.map((id) => asId(id, code)).filter((id): id is string => id !== undefined)
  return { level, code, ids: ids.slice(0, MAX_IDS) }
}

type Printer = (...args: unknown[]) => void

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

export interface UncaughtSource {
  addEventListener(type: 'error', listener: (e: ErrorEvent) => void): void
  addEventListener(type: 'unhandledrejection', listener: (e: PromiseRejectionEvent) => void): void
}

export interface UncaughtCodes {
  uncaught: string
  rejection: string
}

const UI_CODES: UncaughtCodes = { uncaught: 'E_UI_UNCAUGHT', rejection: 'E_UI_UNHANDLED_REJECTION' }

/** Uncaught errors are logged by kind only; their messages may hold content. */
export function forwardUncaught(
  target: UncaughtSource,
  send: (entry: LogEntry) => Promise<unknown>,
  codes: UncaughtCodes = UI_CODES,
) {
  const report = (code: string, reason: unknown) => {
    const id = asId(reason, code)
    send({ level: 'error', code, ids: id ? [id] : [] }).catch(() => {})
  }
  target.addEventListener('error', (e) => report(codes.uncaught, e.error))
  target.addEventListener('unhandledrejection', (e) => report(codes.rejection, e.reason))
}
