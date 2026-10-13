// Crash reporting for the UI: uncaught errors go to Sentry, only in builds
// made with DEVOT_SENTRY_DSN set. Every event passes `scrubEvent`, which
// builds a new event from a fixed list of fields and keeps each value only in
// the shape its field must have (a code, an error type, a code location, a
// source map debug ID, release and system details); everything else is left
// out, so note titles, bodies, attachments and user names never leave the
// machine. The Rust side does the same (src-tauri/src/crash_scrub.rs).
import type { ErrorEvent, Exception, StackFrame } from '@sentry/browser'

const REDACTED = '<redacted>'
const CODE_PREFIX = /^[EWI]_[A-Z0-9_]{1,62}(?![A-Za-z0-9_])/
/**
 * What the SDK writes before a thrown or rejected value that is not an Error,
 * such as the code a command rejects with.
 */
const WRAPPERS = ['Non-Error promise rejection captured with value: ', 'Uncaught ']
/** An error type: `TypeError`, `UnhandledRejection`. */
const ERROR_TYPE = /^[A-Za-z_$][\w$]{0,63}$/
/** A mechanism: `generic`, `auto.browser.global_handlers.onerror`, `chained`. */
const MECHANISM = /^[a-z][a-z0-9_.]{0,63}$/
/** Where a linked error was found: `cause`, `errors[0]`. */
const SOURCE = /^[A-Za-z_$][\w$.[\]]{0,63}$/
const PRINTABLE = /^[\x20-\x7e]{1,512}$/
/** The files a code location may name: scripts, never a document or data. */
const SCRIPT = /\.(?:[cm]?js|jsx|tsx?|mts)$/
const EVENT_ID = /^[0-9a-f]{32}$/
const DEBUG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RELEASE = /^[a-z-]{1,32}@[0-9A-Za-z.+-]{1,64}$/
const VERSION = /^\d[0-9A-Za-z.+-]{0,31}$/
const SDK_NAME = /^[a-z][a-z0-9._-]{0,63}$/
const LEVELS = ['fatal', 'error', 'warning', 'log', 'info', 'debug']

/** The code a text starts with, after any wrapper the SDK put in front, or a placeholder. */
function redact(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const wrapper = WRAPPERS.find((w) => text.startsWith(w))
  const rest = wrapper ? text.slice(wrapper.length) : text
  return CODE_PREFIX.exec(rest)?.[0] ?? REDACTED
}

/** Replaces the user name in home folder paths (`/Users/<name>/...`). */
function scrubPath(path: string): string {
  return path.replace(/\/Users\/[^/\s"':]+/g, '/Users/<user>')
}

/** A script a frame is in, without its query or fragment and the user name. */
function scriptPath(path: string | undefined): string | undefined {
  const file = path?.split(/[?#]/)[0]
  if (file === undefined || !SCRIPT.test(file)) return undefined
  const scrubbed = scrubPath(file)
  return PRINTABLE.test(scrubbed) ? scrubbed : undefined
}

const matching = (value: unknown, shape: RegExp): value is string =>
  typeof value === 'string' && shape.test(value)

/** The parts of a frame that locate code; context lines, variables and data go. */
function scrubFrame(frame: StackFrame): StackFrame[] {
  const out: StackFrame = {}
  if (matching(frame.function, PRINTABLE)) out.function = frame.function
  const filename = scriptPath(frame.filename)
  const absPath = scriptPath(frame.abs_path)
  if (filename !== undefined) out.filename = filename
  if (absPath !== undefined) out.abs_path = absPath
  if (typeof frame.lineno === 'number') out.lineno = frame.lineno
  if (typeof frame.colno === 'number') out.colno = frame.colno
  if (typeof frame.in_app === 'boolean') out.in_app = frame.in_app
  const locates = out.function ?? out.filename ?? out.abs_path
  return locates === undefined ? [] : [out]
}

type Mechanism = NonNullable<Exception['mechanism']>

function scrubMechanism(mechanism: Mechanism): Mechanism {
  const out: Mechanism = { type: matching(mechanism.type, MECHANISM) ? mechanism.type : 'generic' }
  if (typeof mechanism.handled === 'boolean') out.handled = mechanism.handled
  if (typeof mechanism.synthetic === 'boolean') out.synthetic = mechanism.synthetic
  if (matching(mechanism.source, SOURCE)) out.source = mechanism.source
  if (typeof mechanism.exception_id === 'number') out.exception_id = mechanism.exception_id
  if (typeof mechanism.parent_id === 'number') out.parent_id = mechanism.parent_id
  if (typeof mechanism.is_exception_group === 'boolean') {
    out.is_exception_group = mechanism.is_exception_group
  }
  return out
}

function scrubException(ex: Exception): Exception {
  const out: Exception = {}
  if (ex.type !== undefined) out.type = matching(ex.type, ERROR_TYPE) ? ex.type : REDACTED
  const value = redact(ex.value)
  if (value !== undefined) out.value = value
  if (ex.mechanism) out.mechanism = scrubMechanism(ex.mechanism)
  const frames = ex.stacktrace?.frames?.flatMap(scrubFrame) ?? []
  if (frames.length > 0) out.stacktrace = { frames }
  return out
}

type DebugImage = NonNullable<NonNullable<ErrorEvent['debug_meta']>['images']>[number]

/**
 * The source map debug IDs the SDK moved off the frames (the build injects one
 * per script), so Sentry can match each frame to its uploaded source map.
 * Other image types and fields go; the script path loses the user name.
 */
function scrubDebugImages(images: readonly DebugImage[]): DebugImage[] {
  const kept: DebugImage[] = []
  for (const image of images) {
    if (image.type !== 'sourcemap' || !matching(image.debug_id, DEBUG_ID)) continue
    const codeFile = scriptPath(image.code_file)
    if (codeFile !== undefined) {
      kept.push({ type: 'sourcemap', debug_id: image.debug_id, code_file: codeFile })
    }
  }
  return kept
}

type Contexts = NonNullable<ErrorEvent['contexts']>

/** The listed fields of a context that have the shape given for each. */
function context(source: unknown, shapes: Record<string, RegExp>): Record<string, string> | null {
  if (typeof source !== 'object' || source === null) return null
  const out: Record<string, string> = {}
  for (const [key, shape] of Object.entries(shapes)) {
    const value = (source as Record<string, unknown>)[key]
    if (matching(value, shape)) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

/** The system: OS and browser name and version; CPU, model and family, never the device's name. */
function scrubContexts(contexts: Contexts): Contexts {
  const kept: Contexts = {}
  const os = context(contexts['os'], { name: /^[A-Za-z]{1,32}$/, version: VERSION })
  const browser = context(contexts['browser'], { name: /^[A-Za-z]{1,32}$/, version: VERSION })
  const device = context(contexts['device'], {
    arch: /^[a-z0-9_]{1,16}$/,
    model: /^[A-Za-z]{1,32}\d{1,4},\d{1,4}$/,
    family: /^[A-Za-z]{1,32}$/,
  })
  if (os) kept['os'] = os
  if (browser) kept['browser'] = browser
  if (device) kept['device'] = device
  return kept
}

/**
 * Builds the event that may leave the device from `event`: codes, error types,
 * code locations, source map debug IDs, release and system details. Every
 * other field is dropped, and so is a value of another shape than its field's.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const scrubbed: ErrorEvent = { type: undefined }
  if (matching(event.event_id, EVENT_ID)) scrubbed.event_id = event.event_id
  if (typeof event.timestamp === 'number') scrubbed.timestamp = event.timestamp
  if (event.level !== undefined && LEVELS.includes(event.level)) scrubbed.level = event.level
  if (event.platform !== undefined) scrubbed.platform = 'javascript'
  if (matching(event.release, RELEASE)) scrubbed.release = event.release
  if (event.environment === 'production' || event.environment === 'development') {
    scrubbed.environment = event.environment
  }
  if (event.sdk && matching(event.sdk.name, SDK_NAME) && matching(event.sdk.version, VERSION)) {
    scrubbed.sdk = { name: event.sdk.name, version: event.sdk.version }
  }
  const message = redact(event.message)
  if (message !== undefined) scrubbed.message = message
  if (event.exception?.values) {
    scrubbed.exception = { values: event.exception.values.map(scrubException) }
  }
  const images = scrubDebugImages(event.debug_meta?.images ?? [])
  if (images.length > 0) scrubbed.debug_meta = { images }
  if (event.contexts) {
    const contexts = scrubContexts(event.contexts)
    if (Object.keys(contexts).length > 0) scrubbed.contexts = contexts
  }
  return scrubbed
}

/**
 * The environment events report, named as Rust names it (`crash.rs`): Tauri
 * sets TAURI_ENV_DEBUG to "true" for `tauri dev` and `tauri build --debug`,
 * whose app has debug assertions, and to "false" for `tauri build`. A UI built
 * outside Tauri's CLI is not a release.
 */
export function crashEnvironment(tauriDebug: string | undefined): 'production' | 'development' {
  return tauriDebug === 'false' ? 'production' : 'development'
}

type SentryBrowser = typeof import('@sentry/browser')
let started: SentryBrowser | undefined

/**
 * Reports a failure that happened elsewhere (the core worker's uncaught
 * errors) by its code alone. Nothing happens in a build without a DSN.
 */
export function reportCode(code: string) {
  started?.captureException(new Error(code))
}

/** Starts Sentry when this build has a DSN; the SDK loads only then. */
export async function startCrashReporting(dsn: string | undefined, release: string) {
  if (!dsn) return
  const Sentry = await import('@sentry/browser')
  started = Sentry
  Sentry.init({
    dsn,
    release,
    environment: crashEnvironment(import.meta.env['TAURI_ENV_DEBUG'] as string | undefined),
    // Collect nothing about the user, requests or local variables.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    // Only uncaught errors; no breadcrumbs, tracing, replay or request data.
    defaultIntegrations: false,
    integrations: [
      Sentry.globalHandlersIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
    ],
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend: scrubEvent,
  })
}
