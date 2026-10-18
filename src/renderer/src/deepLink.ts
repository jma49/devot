// Links other apps open: `devot://note/<id>` opens a note and
// `devot://command/<id>` runs one of `URL_COMMANDS` (`devot-dev://` in a
// debug build). Rust checks every URL and sends the main window only what it
// asks for, as a link (`src-tauri/src/deep_link.rs`); the window reads it
// again here and takes nothing else. Links run one at a time, each once the
// window has shown what the one before did, and wait while a sheet is up.
import { useEffect, useRef } from 'react'
import { UUID_V7 } from '../../core/ids'
import { sheetOpen } from './commands/dispatch'
import type { CommandId } from './commands/registry'
import { invoke } from './ipc'

/**
 * The commands a URL may run: each one only shows something or makes an
 * empty note. Rust keeps the same list (a test compares them).
 */
export const URL_COMMANDS = [
  'note.new',
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

const isUrlCommand = (id: unknown): id is UrlCommand =>
  typeof id === 'string' && (URL_COMMANDS as readonly string[]).includes(id)

/** A link as Rust sends it, or undefined for anything else. */
export function readDeepLink(value: unknown): DeepLink | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { kind, id } = value as { kind?: unknown; id?: unknown }
  if (kind === 'note' && typeof id === 'string' && UUID_V7.test(id)) return { kind, id }
  if (kind === 'command' && isUrlCommand(id)) return { kind, id }
  return undefined
}

/** Where a linked note is, and so what opening it takes. */
export type NoteTarget =
  /** In the list shown: open it. */
  | { readonly kind: 'listed' }
  /** Live, outside the list shown: show this library first. */
  | { readonly kind: 'library'; readonly library: 'all' | 'templates' }
  /** In the Trash: open it there. */
  | { readonly kind: 'trash' }
  /** No such note. */
  | { readonly kind: 'missing' }

interface Known {
  readonly listed: ReadonlySet<string>
  readonly notes: readonly { readonly id: string }[]
  readonly templates: readonly { readonly id: string }[]
  readonly trash: readonly { readonly id: string }[]
}

/** Where the note `id` is. */
export function noteTarget(id: string, known: Known): NoteTarget {
  const has = (list: readonly { readonly id: string }[]) => list.some((n) => n.id === id)
  if (has(known.trash)) return { kind: 'trash' }
  if (known.listed.has(id)) return { kind: 'listed' }
  if (has(known.templates)) return { kind: 'library', library: 'templates' }
  if (has(known.notes)) return { kind: 'library', library: 'all' }
  return { kind: 'missing' }
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
  private busy = false
  private cancelSettle: (() => void) | undefined
  private unwatch: (() => void) | undefined
  private stopped = false

  constructor(
    private readonly run: (link: DeepLink) => void,
    private readonly blocked: () => boolean,
    private readonly watch: (changed: () => void) => () => void,
    private readonly settleLater: (done: () => void) => () => void,
  ) {}

  push(link: DeepLink): void {
    if (this.stopped) return
    this.waiting.push(link)
    this.flush()
  }

  /** The window has rendered: the link run last has taken effect. */
  settled(): void {
    this.busy = false
    this.cancelSettle?.()
    this.cancelSettle = undefined
    this.flush()
  }

  /** Runs the next link, unless one is still taking effect or a sheet is up. */
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

  stop(): void {
    this.stopped = true
    this.waiting.length = 0
    this.cancelSettle?.()
    this.cancelSettle = undefined
    this.stopWatching()
  }

  private stopWatching(): void {
    this.unwatch?.()
    this.unwatch = undefined
  }
}

/** How often a link waiting behind a sheet looks again (closing one renders too). */
const SHEET_CHECK_MS = 200
/** How long a link that changed nothing on screen holds the next one back. */
const SETTLE_MS = 200

const every = (changed: () => void) => {
  const timer = setInterval(changed, SHEET_CHECK_MS)
  return () => clearInterval(timer)
}

const after = (done: () => void) => {
  const timer = setTimeout(done, SETTLE_MS)
  return () => clearTimeout(timer)
}

/** The page event a link arrives as (Rust's `devot://open-url`, re-sent; tests send it too). */
export const OPEN_URL = 'devot:open-url'
const TAURI_EVENT = 'devot://open-url'

/**
 * Runs `handle` for each link, from the moment `ready` is true (the window
 * has restored its view): first the links that came before (Rust held them;
 * `deep_link_take`), then each one as it comes.
 */
export function useDeepLinks(ready: boolean, handle: (link: DeepLink) => void): void {
  const latest = useRef(handle)
  const queueRef = useRef<LinkQueue>(undefined)
  useEffect(() => {
    latest.current = handle
    // After every render: the link run last has taken effect.
    queueRef.current?.settled()
  })
  useEffect(() => {
    if (!ready) return
    const queue = new LinkQueue((link) => latest.current(link), sheetOpen, every, after)
    queueRef.current = queue
    const take = (value: unknown) => {
      const link = readDeepLink(value)
      if (link) queue.push(link)
      else console.warn('W_DEEP_LINK_INVALID')
    }
    const onEvent = (e: Event) => take(e instanceof CustomEvent ? e.detail : undefined)
    window.addEventListener(OPEN_URL, onEvent)
    let stopped = false
    let unlisten: (() => void) | undefined
    // Listening first, then asking for what waits: no link is lost between.
    const listening = DEVOT_UI_TEST
      ? Promise.resolve()
      : import('@tauri-apps/api/event').then(async ({ listen }) => {
          const stop = await listen<unknown>(TAURI_EVENT, (event) =>
            window.dispatchEvent(new CustomEvent(OPEN_URL, { detail: event.payload })),
          )
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
      queue.stop()
      queueRef.current = undefined
    }
  }, [ready])
}
