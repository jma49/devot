// Links other apps open: `devot://note/<id>` opens a note,
// `devot://command/<id>` runs one of `URL_COMMANDS` and
// `devot://licence?key=<key>` offers a licence (`devot-dev://` in a debug
// build). Rust checks every URL and sends the main window only what it
// asks for, as a link (`src-tauri/src/deep_link.rs`); the window reads it
// again here and takes nothing else. Links run one at a time, each once the
// window has shown what the one before did, and wait while a sheet is up.
import { useEffect, useInsertionEffect, useRef } from 'react'
import type { ImportItem, ImportProblem, ImportScan } from '../../core'
import { UUID_V7 } from '../../core/ids'
import { sheetOpen } from './commands/dispatch'
import type { CommandId } from './commands/registry'
import { finishImport } from './importer'
import { invoke } from './ipc'
import { isLicenceId, isLicenceState } from './licence'
import type { LicenceOffer } from './licenceView'
import { listenHere } from './windowEvents'

/**
 * The commands a URL may run: each one only shows something; none makes,
 * changes or removes anything. Rust keeps the same list (a test compares them).
 */
export const URL_COMMANDS = [
  'palette.open',
  'view.allNotes',
  'view.trash',
  'view.focus',
  'view.togglePreview',
  'view.split',
  'view.edit',
  'view.preview',
  'app.backups',
  'app.checkForUpdates',
] as const satisfies readonly CommandId[]

export type UrlCommand = (typeof URL_COMMANDS)[number]

export type DeepLink =
  | { readonly kind: 'note'; readonly id: string }
  | { readonly kind: 'command'; readonly id: UrlCommand }
  /** Files from the `devot` command (src-tauri/src/cli.rs); no URL makes one. */
  | {
      readonly kind: 'import'
      readonly scan: ImportScan
      readonly notebook: string | null
      readonly first: string | null
    }
  /** Rust checked the key: one that verified comes with what it is, one that did not with its code alone. */
  | {
      readonly kind: 'licence'
      readonly key: string | null
      readonly offer: LicenceOffer | null
      readonly code: string | null
    }

/** As Rust caps it (src-tauri/src/licence/format.rs). */
const MAX_LICENCE_KEY = 1024

const isUrlCommand = (id: unknown): id is UrlCommand =>
  typeof id === 'string' && (URL_COMMANDS as readonly string[]).includes(id)

const isItem = (item: unknown): item is ImportItem =>
  typeof item === 'object' &&
  item !== null &&
  typeof (item as ImportItem).path === 'string' &&
  typeof (item as ImportItem).bytes === 'number'

const isProblem = (problem: unknown): problem is ImportProblem =>
  typeof problem === 'object' &&
  problem !== null &&
  typeof (problem as ImportProblem).path === 'string' &&
  typeof (problem as ImportProblem).code === 'string'

function readScan(value: unknown): ImportScan | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { id, name, kind, files, images, skipped } = value as Record<string, unknown>
  if (!Number.isSafeInteger(id) || typeof name !== 'string' || kind !== 'files') return undefined
  if (!Array.isArray(files) || !files.every(isItem)) return undefined
  if (!Array.isArray(images) || !images.every(isItem)) return undefined
  if (!Array.isArray(skipped) || !skipped.every(isProblem)) return undefined
  return { id: id as number, name, kind, files, images, skipped, destination: null }
}

const isNameOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === 'string'

const LICENCE_KEY = /^devot1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const CODE = /^E_[A-Z0-9_]+$/

function readOffer(value: unknown): LicenceOffer | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { id, licensee, state } = value as Record<string, unknown>
  if (!isLicenceId(id) || !isLicenceState(state)) return undefined
  if (typeof licensee !== 'string' || licensee === '') return undefined
  return { id, licensee, state }
}

function readLicenceLink(value: Record<string, unknown>): DeepLink | undefined {
  const { key, offer, code } = value
  if (typeof code === 'string' && CODE.test(code) && key === null && offer === null)
    return { kind: 'licence', key: null, offer: null, code }
  const read = readOffer(offer)
  if (code !== null || !read) return undefined
  if (typeof key !== 'string' || key.length > MAX_LICENCE_KEY || !LICENCE_KEY.test(key))
    return undefined
  return { kind: 'licence', key, offer: read, code: null }
}

export function readDeepLink(value: unknown): DeepLink | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { kind, id } = value as { kind?: unknown; id?: unknown }
  if (kind === 'note' && typeof id === 'string' && UUID_V7.test(id)) return { kind, id }
  if (kind === 'command' && isUrlCommand(id)) return { kind, id }
  if (kind === 'licence') return readLicenceLink(value as Record<string, unknown>)
  if (kind === 'import') {
    const { scan, notebook, first } = value as Record<string, unknown>
    const read = readScan(scan)
    if (read && isNameOrNull(notebook) && isNameOrNull(first))
      return { kind, scan: read, notebook, first }
  }
  return undefined
}

const linkKey = (link: DeepLink) =>
  link.kind === 'import'
    ? `import:${link.scan.id}`
    : link.kind === 'licence'
      ? `licence:${link.key ?? link.code ?? ''}`
      : `${link.kind}:${link.id}`

export type NoteTarget =
  | { readonly kind: 'listed' }
  | { readonly kind: 'library'; readonly library: 'all' | 'templates' }
  | { readonly kind: 'trash' }
  | { readonly kind: 'missing' }

interface Known {
  readonly listed: ReadonlySet<string>
  readonly notes: readonly { readonly id: string }[]
  readonly templates: readonly { readonly id: string }[]
  readonly trash: readonly { readonly id: string }[]
}

export function noteTarget(id: string, known: Known): NoteTarget {
  const has = (list: readonly { readonly id: string }[]) => list.some((n) => n.id === id)
  if (has(known.trash)) return { kind: 'trash' }
  if (known.listed.has(id)) return { kind: 'listed' }
  if (has(known.templates)) return { kind: 'library', library: 'templates' }
  if (has(known.notes)) return { kind: 'library', library: 'all' }
  return { kind: 'missing' }
}

const MAX_WAITING = 16
/** Files from the `devot` command wait apart from URLs, as many as Rust holds (`MAX_HELD_IMPORTS`). */
const MAX_WAITING_IMPORTS = 64
const REPEAT_MS = 1000

function hasRoom(waiting: readonly DeepLink[], link: DeepLink): boolean {
  const imports = waiting.filter((each) => each.kind === 'import').length
  return link.kind === 'import'
    ? imports < MAX_WAITING_IMPORTS
    : waiting.length - imports < MAX_WAITING
}

/** Nothing else would end the import session of files dropped here. */
function dropLink(link: DeepLink): void {
  console.warn('W_DEEP_LINK_DROPPED')
  if (link.kind === 'import') void finishImport(link.scan.id)
}

/**
 * Runs links in the order they came, one at a time: after running one it
 * waits until the window has rendered what that did (`settled`, called after
 * each render it commits, or `settleLater` for a link that changed nothing),
 * so the next sees the view and the sheets the last one left. Links wait
 * while `blocked()` (a sheet is up); `watch` calls back now and then until
 * the function it returns is called, and runs only while links wait.
 */
export class LinkQueue {
  private readonly waiting: DeepLink[] = []
  private last: { readonly key: string; readonly at: number } | undefined
  private busy = false
  private cancelSettle: (() => void) | undefined
  private unwatch: (() => void) | undefined
  private stopped = false

  constructor(
    private readonly run: (link: DeepLink) => void,
    private readonly blocked: () => boolean,
    private readonly watch: (changed: () => void) => () => void,
    private readonly settleLater: (done: () => void) => () => void,
    private readonly now: () => number = Date.now,
    private readonly dropped: (link: DeepLink) => void = dropLink,
  ) {}

  /**
   * Queues `link`, unless it is the one pushed last, again within
   * `REPEAT_MS`, or as many links of its kind wait already: a page that opens
   * a link over and over cannot flood the window.
   */
  push(link: DeepLink): void {
    if (this.stopped) return
    const key = linkKey(link)
    const at = this.now()
    const repeated = this.last?.key === key && at - this.last.at < REPEAT_MS
    this.last = { key, at }
    if (repeated) {
      console.warn('W_DEEP_LINK_DROPPED')
      return
    }
    if (!hasRoom(this.waiting, link)) {
      this.dropped(link)
      return
    }
    this.waiting.push(link)
    this.flush()
  }

  settled(): void {
    this.busy = false
    this.cancelSettle?.()
    this.cancelSettle = undefined
    this.flush()
  }

  flush(): void {
    if (this.stopped || this.busy) return
    if (this.waiting.length === 0 || !this.blocked()) this.stopWatching()
    const link = this.waiting[0]
    if (!link) return
    if (this.blocked()) {
      this.unwatch ??= this.watch(() => this.flush())
      return
    }
    this.waiting.shift()
    this.busy = true
    this.cancelSettle = this.settleLater(() => this.settled())
    this.run(link)
  }

  stop(): DeepLink[] {
    this.stopped = true
    const left = this.waiting.splice(0)
    this.cancelSettle?.()
    this.cancelSettle = undefined
    this.stopWatching()
    return left
  }

  private stopWatching(): void {
    this.unwatch?.()
    this.unwatch = undefined
  }
}

const SHEET_CHECK_MS = 200
const SETTLE_MS = 200

const every = (changed: () => void) => {
  const timer = setInterval(changed, SHEET_CHECK_MS)
  return () => clearInterval(timer)
}

const after = (done: () => void) => {
  const timer = setTimeout(done, SETTLE_MS)
  return () => clearTimeout(timer)
}

export const OPEN_URL = 'devot:open-url'
const TAURI_EVENT = 'devot://open-url'

/**
 * Runs `handle` for each link, from the moment `ready` is true (the window
 * has restored its view): first the links that came before (Rust held them;
 * `deep_link_take`), then each one as it comes. The page listens for as long
 * as it is up, so a link that comes while `ready` is false waits for it.
 */
export function useDeepLinks(ready: boolean, handle: (link: DeepLink) => void): void {
  const latest = useRef(handle)
  const queueRef = useRef<LinkQueue>(undefined)
  // Links that came while the window was not ready, oldest first.
  const early = useRef<DeepLink[]>([])
  // At commit, not after paint: a link landing in between would act on the
  // state of the render before (a trashed note still listed, say).
  useInsertionEffect(() => {
    latest.current = handle
  })
  useEffect(() => {
    queueRef.current?.settled()
  })
  useEffect(() => {
    const take = (value: unknown) => {
      const link = readDeepLink(value)
      if (!link) console.warn('W_DEEP_LINK_INVALID')
      else if (queueRef.current) queueRef.current.push(link)
      else if (hasRoom(early.current, link)) early.current.push(link)
      else dropLink(link)
    }
    const onEvent = (e: Event) => take(e instanceof CustomEvent ? e.detail : undefined)
    window.addEventListener(OPEN_URL, onEvent)
    let stopped = false
    let unlisten: (() => void) | undefined
    // Listening first, then asking for what waits: no link is lost between.
    const listening = DEVOT_UI_TEST
      ? Promise.resolve()
      : listenHere<unknown>(TAURI_EVENT, (event) =>
          window.dispatchEvent(new CustomEvent(OPEN_URL, { detail: event.payload })),
        ).then((stop) => {
          if (stopped) stop()
          else unlisten = stop
        })
    listening
      .catch(() => console.warn('W_DEEP_LINK_LISTEN_FAILED'))
      .then(() => (stopped ? [] : invoke<unknown>('deep_link_take')))
      .then(
        (held) => {
          if (!stopped && Array.isArray(held)) held.forEach(take)
        },
        () => console.warn('W_DEEP_LINK_TAKE_FAILED'),
      )
    return () => {
      stopped = true
      window.removeEventListener(OPEN_URL, onEvent)
      unlisten?.()
    }
  }, [])
  useEffect(() => {
    if (!ready) return
    const queue = new LinkQueue((link) => latest.current(link), sheetOpen, every, after)
    queueRef.current = queue
    for (const link of early.current.splice(0)) queue.push(link)
    return () => {
      // Not run yet: they run once the window is ready again.
      early.current = queue.stop()
      queueRef.current = undefined
    }
  }, [ready])
}
